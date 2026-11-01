import { all, assert, Context, Identity, NOW, one, Row, settings, statement } from './types';
import { equalToken, matches, path, sha } from './security';
import { audit } from './audit';
export { audit, auditStatement } from './audit';
export async function authenticate(c: Context,request: Request,owner: boolean): Promise<Identity> {
 assert(new URL(request.url).origin===c.env.PUBLIC_ORIGIN,'invalid_origin',403);
 const origin=request.headers.get('origin');
 assert(origin===null||origin===c.env.PUBLIC_ORIGIN,'invalid_origin',403);
 const auth=request.headers.get('authorization')||'';assert(/^Bearer [^\s]+$/i.test(auth),'unauthorized',401);
 const token=auth.slice(7);
 if(owner){assert(c.env.OWNER_TOKEN?.length>=43,'not_configured',503);assert(!token.startsWith('al_')&&await equalToken(token,c.env.OWNER_TOKEN),'unauthorized',401);return {kind:'owner',name:'Owner'};}
 assert(/^al_[0-9a-f]{64}$/.test(token),'unauthorized',401);
 const row=await one(c,`SELECT t.id,t.agent_id,t.expires_at,a.name FROM agent_tokens t JOIN agents a ON a.id=t.agent_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>${NOW} AND a.status='enabled'`,await sha(token));
 assert(row,'unauthorized',401);return {kind:'agent',agentId:row.agent_id,tokenId:row.id,name:row.name,expiresAt:row.expires_at};
}
export async function rate(c: Context,identity: string,cls: string,max: number) {
 const r=await one(c,`INSERT INTO rate_windows(identity,class,bucket,count,expires_at) VALUES(?,?,CAST(${NOW}/60000 AS INTEGER),1,${NOW}+120000) ON CONFLICT(identity,class,bucket) DO UPDATE SET count=count+1 RETURNING count`,identity,cls);
 assert(r&&r.count<=max,'rate_limited',429);
}
export async function grants(c: Context) {
 await active(c);
 return {folders:await all(c,`SELECT prefix,read,write,"delete",expires_at FROM folder_grants WHERE agent_id=? AND (expires_at IS NULL OR expires_at>${NOW})`,c.actor.agentId),
 secrets:await all(c,`SELECT s.id,s.name,g.read,g.expires_at FROM secret_grants g JOIN secrets s ON s.id=g.secret_id WHERE g.agent_id=? AND s.enabled=1 AND (g.expires_at IS NULL OR g.expires_at>${NOW})`,c.actor.agentId)};
}
export async function identity(c: Context) {
 assert(c.actor.kind==='agent','forbidden',403);
 const effective=await grants(c);
 await audit(c,'identity.read','/','allow','read');
 return {agent:{id:c.actor.agentId,name:c.actor.name},token:{id:c.actor.tokenId,expires_at:c.actor.expiresAt},grants:effective};
}
export async function folderAllowed(c: Context,target: string,permission: 'read'|'write'|'delete') {
 path(target,target.endsWith('/'));
 assert(['read','write','delete'].includes(permission),'invalid_permission');
 if(c.actor.kind==='owner')return true;
 await active(c);
 const gs=await all(c,`SELECT prefix FROM folder_grants WHERE agent_id=? AND "${permission}"=1 AND (expires_at IS NULL OR expires_at>${NOW})`,c.actor.agentId);
 return gs.some(g=>matches(g.prefix,target));
}
export async function requireFolder(c: Context,target: string,permission: 'read'|'write'|'delete') { assert(await folderAllowed(c,target,permission),'not_found_or_not_allowed',404); }
export async function requireSecret(c: Context,name: string) {
 await active(c);
 const secret=await one(c,`SELECT * FROM secrets s WHERE name=? AND enabled=1 ${c.actor.kind==='owner'?'':`AND EXISTS(SELECT 1 FROM secret_grants g WHERE g.secret_id=s.id AND g.agent_id=? AND (g.expires_at IS NULL OR g.expires_at>${NOW}))`}`,name,...(c.actor.kind==='owner'?[]:[c.actor.agentId]));
 assert(secret,'not_found_or_not_allowed',404);return secret;
}
export async function requiresReview(c: Context,operation: string,target: string,secretId?: string) {
 if(c.actor.kind==='owner')return false;
 if(operation==='file.delete'||operation==='proxy.request')return true;
 const rules=await all(c,'SELECT * FROM approval_rules WHERE operation=?',operation);
 return rules.some(r=>(!r.prefix||matches(r.prefix,target))&&(!r.secret_id||r.secret_id===secretId));
}
export async function active(c: Context) {
 if(c.actor.kind==='owner')return;
 assert(c.actor.kind==='agent'&&c.actor.agentId&&c.actor.tokenId,'unauthorized',401);
 const t=await one(c,`SELECT t.id FROM agent_tokens t JOIN agents a ON a.id=t.agent_id WHERE t.id=? AND t.agent_id=? AND t.revoked_at IS NULL AND t.expires_at>${NOW} AND a.status='enabled'`,c.actor.tokenId,c.actor.agentId);
 assert(t,'credential_revoked',403);
}
export async function invalidate(c: Context,reason='policy_changed') {
 await c.env.DB.batch([
 statement(c,`UPDATE actions SET status='invalidated',error_code=?,updated_at=${NOW},result_expires_at=${NOW}+86400000 WHERE status IN('pending','ready') AND config_version!=(SELECT config_version FROM settings WHERE id=1)`,reason),
 statement(c,`INSERT INTO audit_events(request_id,action_id,approval_id,actor_kind,actor_name,operation,target,decision,result,reason_code) SELECT ?,a.id,a.approval_id,'system','System','approval.invalidated',a.target,'deny','invalidated',? FROM actions a JOIN approvals p ON p.action_id=a.id WHERE a.status='invalidated' AND p.state='pending'`,c.requestId,reason),
 statement(c,`UPDATE approvals SET state='invalidated',decided_at=${NOW},decision_request_id=? WHERE state='pending' AND action_id IN(SELECT id FROM actions WHERE status='invalidated')`,c.requestId)
 ]);
}
export function bump(c: Context) {return statement(c,`UPDATE settings SET config_version=config_version+1,updated_at=${NOW} WHERE id=1`);}
export function requireOwner(c: Context) {assert(c.actor.kind==='owner','forbidden',403);}
export async function checkSchema(c: Context) {
 let version: Row|null;
 try {version=await one(c,'SELECT version FROM schema_version');} catch {assert(false,'schema_unavailable',503);}
 assert(version?.version===4,'schema_unavailable',503);
}
export async function ready(c: Context) {await checkSchema(c);const s=await settings(c);assert(s.setup_complete,'setup_required',503);assert(!s.maintenance,'maintenance',503);return s;}
