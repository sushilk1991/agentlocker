import { active, bump, requireOwner, requireSecret } from './auth';
import { audit, auditStatement } from './audit';
import { changedOne, storageError } from './file-transaction';
import { base64, bytes, canonical, host, injection, open, seal, secretValue, sha, unbase64 } from './security';
import { pageLimit } from './files';
import { all, assert, Context, NOW, one, opaqueId, Row, settings, statement } from './types';
import { DAY, idempotencyKey } from './file-actions';

export interface SecretInput {name: string; value?: string; hosts: string[]; injection_header: string; scheme: 'bearer'|'plain'; enabled?: boolean}
export const secretName = (name: unknown) => assert(typeof name==='string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(name), 'invalid_secret_name');
export const secretHosts = async (c: Context, id: string) => (await all(c, 'SELECT hostname FROM secret_hosts WHERE secret_id=? ORDER BY hostname', id)).map(r=>r.hostname as string);
export async function secretMetadata(c: Context, s: Row,hosts?: string[]) {
 return {id:s.id, name:s.name, version:s.version, value_version:s.value_version, enabled:!!s.enabled,
  injection_header:s.injection_header, scheme:s.scheme, hosts:hosts??await secretHosts(c,s.id), created_at:s.created_at, updated_at:s.updated_at};
}
// Saved values have no retrieval API, including for the owner.
export async function saveSecret(c: Context, input: SecretInput, id?: string, expectedVersion?: number) {
 requireOwner(c);
 assert(input && typeof input==='object' && !Array.isArray(input) && Object.keys(input).every(k=>['name','value','hosts','injection_header','scheme','enabled'].includes(k)), 'invalid_secret');
 secretName(input.name); assert(typeof input.injection_header==='string','invalid_injection');
 const header=injection(input.injection_header,input.scheme);
 assert(input.enabled===undefined || typeof input.enabled==='boolean','invalid_secret');
 assert(Array.isArray(input.hosts)&&input.hosts.length>0&&input.hosts.length<=50,'invalid_hosts');
 const hosts=[...new Set(input.hosts.map(host))].sort();
 assert(!hosts.includes(new URL(c.env.PUBLIC_ORIGIN).hostname),'invalid_host');
 const old=id ? await one(c,'SELECT * FROM secrets WHERE id=?',id) : null;
 if(id) assert(old,'not_found',404);
 assert(!old || Number.isInteger(expectedVersion)&&expectedVersion===old.version,'version_conflict',409);
 assert(old || input.value!==undefined,'secret_value_required');
 const secretId=id??opaqueId(), version=(old?.version??0)+1, valueVersion=(old?.value_version??0)+(input.value===undefined?0:1);
 const encrypted=input.value===undefined ? null : await seal(c.env,'secret.value',secretId,valueVersion,secretValue(input.value));
 try {
  await c.env.DB.batch([
   old ? statement(c,`UPDATE secrets SET name=?,encrypted_value=?,nonce=?,key_version=?,value_version=?,version=?,injection_header=?,scheme=?,enabled=?,updated_at=${NOW} WHERE id=? AND version=?`,
    input.name,encrypted?.cipher??old.encrypted_value,encrypted?.nonce??old.nonce,encrypted?.keyVersion??old.key_version,valueVersion,version,header,input.scheme,+(input.enabled??!!old.enabled),secretId,expectedVersion)
   : statement(c,`INSERT INTO secrets(id,name,encrypted_value,nonce,key_version,value_version,version,injection_header,scheme,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,${NOW},${NOW})`,
    secretId,input.name,encrypted!.cipher,encrypted!.nonce,encrypted!.keyVersion,valueVersion,version,header,input.scheme,+(input.enabled??true)),
   ...changedOne(c),
   statement(c,'DELETE FROM secret_hosts WHERE secret_id=?',secretId),
   ...hosts.map(h=>statement(c,'INSERT INTO secret_hosts VALUES(?,?)',secretId,h)), bump(c),
   ...invalidateSecretStatements(c),
   auditStatement(c,'secret.save',secretId,'allow',old?'updated':'created',{metadata:{secret_id:secretId,version,secret_version:valueVersion}}),
  ]);
 } catch(error) {storageError(error);}
 return secretMetadata(c,(await one(c,'SELECT * FROM secrets WHERE id=?',secretId))!);
}
function invalidateSecretStatements(c: Context) {
 return [statement(c,`UPDATE actions SET status='invalidated',error_code='policy_changed',updated_at=${NOW},result_expires_at=${NOW}+86400000 WHERE status IN('pending','ready') AND config_version!=(SELECT config_version FROM settings WHERE id=1)`),
  statement(c,`INSERT INTO audit_events(request_id,action_id,approval_id,actor_kind,actor_name,operation,target,decision,result,reason_code)
   SELECT ?,a.id,p.id,'system','System','approval.invalidated',a.target,'deny','invalidated','policy_changed' FROM actions a JOIN approvals p ON p.action_id=a.id WHERE a.status='invalidated' AND p.state='pending'`,c.requestId),
  statement(c,`UPDATE approvals SET state='invalidated',decided_at=${NOW},decision_request_id=? WHERE state='pending' AND action_id IN(SELECT id FROM actions WHERE status='invalidated')`,c.requestId)];
}
export async function disableSecret(c: Context,id: string,version: number) {
 requireOwner(c); const s=await one(c,'SELECT * FROM secrets WHERE id=?',id); assert(s,'not_found',404);
 return saveSecret(c,{name:s.name,hosts:await secretHosts(c,id),injection_header:s.injection_header,scheme:s.scheme,enabled:false},id,version);
}
async function secretAfter(c: Context,cursor: string|undefined,version: number) {
 let after='';
 if(cursor!==undefined) {
  try {
   assert(cursor.length>0&&cursor.length<=8192,'invalid_cursor');
   const identity=c.actor.kind==='owner'?'owner':`agent:${c.actor.agentId}`;
   const e=JSON.parse(new TextDecoder().decode(unbase64(cursor))),v=JSON.parse(await open(c.env,'secrets.cursor',identity,1,e.cipher,e.nonce,e.keyVersion));
   assert(v.version===version&&typeof v.after==='string','invalid_cursor');after=v.after;
  } catch {assert(false,'invalid_cursor');}
 }
 return after;
}
export async function listSecrets(c: Context,limit=50,cursor?:string) {
 await active(c);
 pageLimit(limit);
 const identity=c.actor.kind==='owner'?'owner':`agent:${c.actor.agentId}`,version=(await one(c,'SELECT config_version FROM settings WHERE id=1'))!.config_version;
 const after=await secretAfter(c,cursor,version);
 const rows=await all(c,`SELECT s.id,s.name,s.version,s.value_version,s.enabled,s.injection_header,s.scheme,s.created_at,s.updated_at
  FROM secrets s WHERE s.name>? ${c.actor.kind==='owner'?'':`AND s.enabled=1 AND EXISTS(SELECT 1 FROM secret_grants g WHERE g.secret_id=s.id AND g.agent_id=? AND (g.expires_at IS NULL OR g.expires_at>${NOW}))`} ORDER BY s.name LIMIT ?`,after,...(c.actor.kind==='owner'?[]:[c.actor.agentId]),limit+1);
 const page=rows.slice(0,limit);
 const next=rows.length>limit?base64(bytes(JSON.stringify(await seal(c.env,'secrets.cursor',identity,1,canonical({version,after:page.at(-1)!.name}))))):null;
 const ids=page.map(s=>s.id),slots=ids.map(()=>'?').join(',');
 const hosts=ids.length?await all(c,`SELECT secret_id,hostname FROM secret_hosts WHERE secret_id IN(${slots}) ORDER BY hostname`,...ids):[];
 const agents=c.actor.kind==='owner'&&ids.length?await all(c,`SELECT g.secret_id,a.id,a.name,a.status,g.read,g.expires_at
  FROM secret_grants g JOIN agents a ON a.id=g.agent_id WHERE g.secret_id IN(${slots}) ORDER BY a.id`,...ids):[];
 const secrets=await Promise.all(page.map(async s=>({...await secretMetadata(c,s,hosts.filter(h=>h.secret_id===s.id).map(h=>h.hostname)),...(c.actor.kind==='owner'?{
  agents:agents.filter(a=>a.secret_id===s.id).map(({secret_id,...a})=>a),
 }:{})})));
 await active(c);
 await audit(c,'secrets.list','/','allow','listed');
 return {secrets,cursor:next};
}
export async function selectedSecret(c: Context,name: string) {secretName(name); return requireSecret(c,name);}

export async function gateSecretList(c: Context,key: string|null,parameters?:{limit:number;cursor?:string}) {
 await active(c); if(c.actor.kind==='owner')return null;
 if(parameters) {
  pageLimit(parameters.limit);
  await secretAfter(c,parameters.cursor,(await settings(c)).config_version);
 }
 const names=await all(c,`SELECT s.id FROM secrets s JOIN secret_grants g ON g.secret_id=s.id WHERE g.agent_id=? AND s.enabled=1 AND (g.expires_at IS NULL OR g.expires_at>${NOW})`,c.actor.agentId);
 const rules=await all(c,"SELECT secret_id FROM approval_rules WHERE operation='secrets.list'");
 if(!names.length||!rules.some(r=>!r.secret_id||names.some(s=>s.id===r.secret_id)))return null;
 idempotencyKey(key!);
 const input={operation:'secrets.list',target:'/',secret_ids:names.map(s=>s.id).sort(),...(parameters?{parameters}:{})};
 const submission=await sha(canonical({operation:'secrets.list',...(parameters?{parameters}:{})})), identity=`agent:${c.actor.agentId}`;
 const replay=async()=>{
  const old=await one(c,`SELECT k.input_digest,a.* FROM idempotency_keys k JOIN actions a ON a.id=k.action_id WHERE k.identity=? AND k.caller_key=? AND k.expires_at>${NOW}`,identity,key);
  if(!old)return null;assert(old.input_digest===submission,'idempotency_conflict',409);
  await audit(c,'secrets.list','/','allow','replayed',{actionId:old.id});
  return {id:old.id,approval_id:old.approval_id,status:old.status,expires_at:old.expires_at};
 };
 const old=await replay();if(old)return old;
 const s=await settings(c);assert(s.setup_complete&&!s.maintenance,'maintenance',503);
 const id=opaqueId(),approval=opaqueId(),digest=await sha(canonical({input,config_version:s.config_version,agent_id:c.actor.agentId,token_id:c.actor.tokenId}));
 const encrypted=await seal(c.env,'action.input',id,1,canonical(input));
 try {
  await c.env.DB.batch([
   statement(c,`DELETE FROM idempotency_keys WHERE identity=? AND caller_key=? AND expires_at<=${NOW}`,identity,key),
   statement(c,`INSERT INTO idempotency_keys VALUES(?,?,?,?,${NOW},${NOW}+?)`,identity,key,submission,id,7*DAY),
   statement(c,`INSERT INTO actions(id,agent_id,token_id,request_id,operation,target,digest,submission_digest,input_cipher,input_nonce,key_version,config_version,status,approval_id,created_at,updated_at,expires_at)
    SELECT ?,?,?,?,'secrets.list','/',?,?,?,?,?,?,'pending',?,${NOW},${NOW},${NOW}+? FROM settings WHERE id=1 AND config_version=? AND setup_complete=1 AND maintenance=0`,
    id,c.actor.agentId,c.actor.tokenId,c.requestId,digest,submission,encrypted.cipher,encrypted.nonce,encrypted.keyVersion,s.config_version,approval,s.approval_ttl,s.config_version),
   ...changedOne(c),
   statement(c,`INSERT INTO approvals(id,action_id,state,created_at,expires_at) SELECT ?,id,'pending',created_at,expires_at FROM actions WHERE id=?`,approval,id),
   auditStatement(c,'secrets.list','/','pending','accepted',{actionId:id,approvalId:approval,metadata:{digest}}),
  ]);
 } catch(error) {const winner=await replay();if(winner)return winner;storageError(error);}
 return {id,approval_id:approval,status:'pending',expires_at:(await one(c,'SELECT expires_at FROM actions WHERE id=?',id))!.expires_at};
}
