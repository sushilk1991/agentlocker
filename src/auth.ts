import { all, assert, Context, Identity, NOW, one, Row, settings, statement } from './types';
import { equalToken, matches, sha } from './security';
export async function authenticate(c: Context,request: Request,owner: boolean): Promise<Identity> {
 const auth=request.headers.get('authorization')||'';assert(/^Bearer [^\s]+$/.test(auth),'unauthorized',401);
 const token=auth.slice(7);
 if(owner){assert(await equalToken(token,c.env.OWNER_TOKEN),'unauthorized',401);return {kind:'owner',name:'Owner'};}
 assert(/^al_[0-9a-f]{64}$/.test(token),'unauthorized',401);
 const row=await one(c,`SELECT t.id,t.agent_id,t.expires_at,a.name FROM agent_tokens t JOIN agents a ON a.id=t.agent_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>${NOW} AND a.status='enabled'`,await sha(token));
 assert(row,'unauthorized',401);return {kind:'agent',agentId:row.agent_id,tokenId:row.id,name:row.name,expiresAt:row.expires_at};
}
export function auditStatement(c: Context,operation: string,target: string,decision: string,result: string,extra: Row={}) {
 return statement(c,`INSERT INTO audit_events(request_id,action_id,approval_id,attempt_id,batch_id,actor_kind,agent_id,token_id,actor_name,operation,target,decision,result,http_status,reason_code,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
 c.requestId,extra.actionId,extra.approvalId,extra.attemptId,extra.batchId,c.actor.kind,c.actor.agentId,c.actor.tokenId,c.actor.name,operation,target,decision,result,extra.status,extra.reason||result,JSON.stringify(extra.metadata||{}));
}
export async function audit(c: Context,operation: string,target: string,decision: string,result: string,extra: Row={}) {await auditStatement(c,operation,target,decision,result,extra).run();}
export async function rate(c: Context,identity: string,cls: string,max: number) {
 const r=await one(c,`INSERT INTO rate_windows(identity,class,bucket,count,expires_at) VALUES(?,?,CAST(${NOW}/60000 AS INTEGER),1,${NOW}+120000) ON CONFLICT(identity,class,bucket) DO UPDATE SET count=count+1 RETURNING count`,identity,cls);
 assert(r&&r.count<=max,'rate_limited',429);
}
export async function grants(c: Context) {
 return {folders:await all(c,`SELECT prefix,read,write,"delete",expires_at FROM folder_grants WHERE agent_id=? AND (expires_at IS NULL OR expires_at>${NOW})`,c.actor.agentId),
 secrets:await all(c,`SELECT s.id,s.name,g.read,g.expires_at FROM secret_grants g JOIN secrets s ON s.id=g.secret_id WHERE g.agent_id=? AND s.enabled=1 AND (g.expires_at IS NULL OR g.expires_at>${NOW})`,c.actor.agentId)};
}
export async function folderAllowed(c: Context,target: string,permission: 'read'|'write'|'delete') {
 if(c.actor.kind==='owner')return true;
 const gs=await all(c,`SELECT prefix FROM folder_grants WHERE agent_id=? AND "${permission}"=1 AND (expires_at IS NULL OR expires_at>${NOW})`,c.actor.agentId);
 return gs.some(g=>matches(g.prefix,target));
}
export async function requireFolder(c: Context,target: string,permission: 'read'|'write'|'delete') { assert(await folderAllowed(c,target,permission),'not_found_or_not_allowed',404); }
export async function requireSecret(c: Context,name: string) {
 const secret=await one(c,`SELECT * FROM secrets s WHERE name=? AND enabled=1 ${c.actor.kind==='owner'?'':`AND EXISTS(SELECT 1 FROM secret_grants g WHERE g.secret_id=s.id AND g.agent_id=? AND (g.expires_at IS NULL OR g.expires_at>${NOW}))`}`,name,...(c.actor.kind==='owner'?[]:[c.actor.agentId]));
 assert(secret,'not_found_or_not_allowed',404);return secret;
}
export async function requiresReview(c: Context,operation: string,target: string,secretId?: string) {
 if(c.actor.kind==='owner')return false;
 const rules=await all(c,'SELECT * FROM approval_rules WHERE operation=?',operation);
 return rules.some(r=>(!r.prefix||matches(r.prefix,target))&&(!r.secret_id||r.secret_id===secretId));
}
export async function active(c: Context) {
 if(c.actor.kind==='owner')return;
 const t=await one(c,`SELECT t.id FROM agent_tokens t JOIN agents a ON a.id=t.agent_id WHERE t.id=? AND t.revoked_at IS NULL AND t.expires_at>${NOW} AND a.status='enabled'`,c.actor.tokenId);
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
export async function ready(c: Context) {const s=await settings(c);assert(s.setup_complete,'setup_required',503);assert(!s.maintenance,'maintenance',503);return s;}
