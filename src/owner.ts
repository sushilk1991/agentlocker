import { checkSchema, requireOwner } from './auth';
import { audit, auditStatement } from './audit';
import { idempotencyKey } from './file-actions';
import { changedOne } from './file-transaction';
import { storageUsage } from './file-cleanup';
import { canonical, sha } from './security';
import { all, assert, Context, LockerError, NOW, one, statement } from './types';

const defaults = {approval_ttl:900000, quota_bytes:1073741824, retention_ms:604800000};
export async function ownerSession(c: Context) {
 requireOwner(c); await checkSchema(c);
 const s = await one(c,'SELECT setup_complete,approval_ttl,quota_bytes,retention_ms,maintenance FROM settings WHERE id=1');
 await audit(c,'owner.session','/','allow','signed_in');
 return {...defaults,...s,setup_complete:!!s?.setup_complete,public_origin:c.env.PUBLIC_ORIGIN};
}
export async function setupOwner(c: Context, input: typeof defaults, callerKey: string) {
 requireOwner(c); await checkSchema(c); idempotencyKey(callerKey);
 assert(Number.isSafeInteger(input.approval_ttl) && input.approval_ttl>=60000 && input.approval_ttl<=3600000,'invalid_approval_expiry');
 assert(Number.isSafeInteger(input.quota_bytes) && input.quota_bytes>0,'invalid_quota');
 assert(Number.isSafeInteger(input.retention_ms) && input.retention_ms>=604800000,'invalid_retention');
 const digest=await sha(canonical(input));
 const replay=async()=>{
  const receipt=await one(c,"SELECT input_digest FROM idempotency_keys WHERE identity='owner.setup' AND caller_key=?",callerKey);
  if(receipt) {assert(receipt.input_digest===digest,'idempotency_conflict',409);await audit(c,'owner.setup.retry','/','allow','replayed');return {setup_complete:true};}
  return null;
 };
 const previous=await replay(); if(previous)return previous;
 assert(!(await one(c,'SELECT setup_complete FROM settings WHERE id=1'))?.setup_complete,'setup_already_complete',409);
 try {
  await c.env.DB.batch([
   statement(c,`INSERT INTO settings(id,deployment_id,public_origin,setup_complete,approval_ttl,quota_bytes,retention_ms,created_at,updated_at)
    VALUES(1,?,?,1,?,?,?,${NOW},${NOW}) ON CONFLICT(id) DO UPDATE SET setup_complete=1,public_origin=excluded.public_origin,
    deployment_id=excluded.deployment_id,approval_ttl=excluded.approval_ttl,quota_bytes=excluded.quota_bytes,retention_ms=excluded.retention_ms,updated_at=${NOW}
    WHERE settings.setup_complete=0`,c.env.DEPLOYMENT_ID,c.env.PUBLIC_ORIGIN,input.approval_ttl,input.quota_bytes,input.retention_ms),
   ...changedOne(c),
   // A permanent setup receipt has no action payload. Other idempotency identities
   // are independent. Retain this receipt for concurrent and later setup retries.
   statement(c,`INSERT INTO idempotency_keys(identity,caller_key,input_digest,action_id,created_at,expires_at)
    VALUES('owner.setup',?,?,'setup',${NOW},8640000000000000)`,callerKey,digest),
   auditStatement(c,'owner.setup','/','allow','initialized'),
  ]);
 } catch(error) {
  const recorded=await replay(); if(recorded)return recorded;
  if((await one(c,'SELECT setup_complete FROM settings WHERE id=1'))?.setup_complete)throw new LockerError('setup_already_complete',409);
  throw error;
 }
 return {setup_complete:true};
}
export async function listAgents(c: Context) {
 requireOwner(c);
 const agents=await all(c,'SELECT id,name,description,status,version,created_at,revoked_at FROM agents ORDER BY created_at,id');
 const tokens=await all(c,'SELECT id,agent_id,prefix,label,created_at,expires_at,revoked_at FROM agent_tokens ORDER BY created_at,id');
 await audit(c,'agents.list','/','allow','listed');
 return {agents:agents.map(a=>({...a,tokens:tokens.filter(t=>t.agent_id===a.id)}))};
}
export async function agentGrants(c: Context,id: string) {
 requireOwner(c);
 const agent=await one(c,'SELECT version FROM agents WHERE id=?',id); assert(agent,'not_found',404);
 const folders=await all(c,`SELECT prefix,read,write,"delete",expires_at FROM folder_grants WHERE agent_id=?`,id);
 const secrets=await all(c,`SELECT g.secret_id,g.read,g.expires_at,s.name,s.enabled FROM secret_grants g JOIN secrets s ON s.id=g.secret_id WHERE g.agent_id=?`,id);
 const active=(g: Record<string,any>)=>g.expires_at===null||g.expires_at>Date.now();
 await audit(c,'grants.read',id,'allow','read');
 return {version:agent.version,folders,secrets,effective:{folders:folders.filter(active),secrets:secrets.filter(s=>active(s)&&s.enabled===1)}};
}
export async function overview(c: Context,cursor: number) {
 requireOwner(c); assert(Number.isSafeInteger(cursor)&&cursor>=0,'invalid_cursor');
 const [events,queue,storage,usage]=await Promise.all([
  all(c,`SELECT * FROM audit_events WHERE id>? ORDER BY id DESC LIMIT 100`,cursor),
  one(c,`SELECT COUNT(*) AS pending_count,MIN(created_at) AS oldest_pending_at FROM actions WHERE status='pending' AND expires_at>${NOW}`),
  storageUsage(c),one(c,`SELECT COALESCE((SELECT MAX(id) FROM audit_events),0) AS last_event_id,
   CAST(COALESCE((SELECT MAX(id) FROM audit_events),0)*COALESCE(AVG(size),0) AS INTEGER) AS estimated_bytes
   FROM (SELECT length(metadata)+length(target)+length(operation)+length(actor_name)+256 AS size FROM audit_events ORDER BY id DESC LIMIT 100)`),
 ]);
 const pending=await all(c,`SELECT id,status,updated_at FROM actions WHERE status IN('pending','ready','executing') ORDER BY id LIMIT 200`);
 await audit(c,'owner.overview','/','allow','read');
 return {...queue,events,event_cursor:events[0]?.id??cursor,pending_version:await sha(canonical(pending)),storage,audit_storage:usage,
  server_time:Date.now(),warnings:[...(Number(storage.bytes)>=storage.quota_bytes*.9?['File storage is almost full.']:[]),...(queue!.pending_count>=80?['The approval queue is almost full.']:[])]};
}
