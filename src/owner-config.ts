import { requireOwner } from './auth';
import { invalidateStatements } from './agents';
import { audit, auditStatement } from './audit';
import { DAY, idempotencyKey } from './file-actions';
import { changedOne, storageError } from './file-transaction';
import { canonical, path, sha } from './security';
import { all, assert, Context, LockerError, NOW, one, opaqueId, settings, statement } from './types';

const mandatory = ['file.delete','file.replace','proxy.request'];
const operations = ['file.read','file.write','files.list','secrets.list'];
interface Rule {operation: string; prefix?: string | null; secret_id?: string | null}
interface SettingsPatch {approval_ttl?: number; quota_bytes?: number; retention_ms?: number; maintenance?: boolean}

export async function readPolicy(c: Context) {
 requireOwner(c);
 const s=await settings(c),rules=await all(c,'SELECT id,operation,prefix,secret_id,version,created_at FROM approval_rules ORDER BY operation,prefix,secret_id,id');
 await audit(c,'policy.read','/','allow','read');
 return {version:s.config_version,mandatory,rules};
}
export async function readSettings(c: Context) {
 requireOwner(c);
 const s=await settings(c);
 await audit(c,'settings.read','/','allow','read');
 return {version:s.config_version,approval_ttl:s.approval_ttl,quota_bytes:s.quota_bytes,retention_ms:s.retention_ms,
  maintenance:!!s.maintenance,public_origin:c.env.PUBLIC_ORIGIN,created_at:s.created_at,updated_at:s.updated_at};
}

// Config changes, invalidation, the retry receipt, and audit commit together.
// Receipts contain only a version. They never hold credentials or private input.
async function change(c: Context,kind: 'policy'|'settings',expectedVersion: number,input: unknown,key: string,
 changes: (version: number) => D1PreparedStatement[]) {
 requireOwner(c); idempotencyKey(key);
 assert(Number.isSafeInteger(expectedVersion)&&expectedVersion>=1,'invalid_version');
 const digest=await sha(canonical({expected_version:expectedVersion,input})),identity=`owner.${kind}`;
 const replay=async()=>{
  const old=await one(c,`SELECT input_digest,action_id FROM idempotency_keys WHERE identity=? AND caller_key=? AND expires_at>${NOW}`,identity,key);
  if(!old)return null;
  assert(old.input_digest===digest,'idempotency_conflict',409);
  await audit(c,`${kind}.retry`,'/','allow','replayed');
  return {version:Number(old.action_id)};
 };
 const previous=await replay();if(previous)return previous;
 assert((await settings(c)).config_version===expectedVersion,'version_conflict',409);
 const version=expectedVersion+1;
 try {
  await c.env.DB.batch([
   statement(c,`UPDATE settings SET config_version=config_version+1,updated_at=${NOW} WHERE id=1 AND config_version=?`,expectedVersion),
   ...changedOne(c),...changes(version),
   ...invalidateStatements(c,'config_version!=(SELECT config_version FROM settings WHERE id=1)',[],'policy_changed'),
   statement(c,`DELETE FROM idempotency_keys WHERE identity=? AND caller_key=? AND expires_at<=${NOW}`,identity,key),
   statement(c,`INSERT INTO idempotency_keys VALUES(?,?,?,?,${NOW},${NOW}+?)`,identity,key,digest,String(version),7*DAY),
   auditStatement(c,`${kind}.update`,'/','allow','updated',{metadata:{version}}),
  ]);
 } catch(error) {
  const winner=await replay();if(winner)return winner;
  if(String(error).includes('file_commit_conflict'))throw new LockerError('version_conflict',409);
  storageError(error);
 }
 return {version};
}

export async function replacePolicy(c: Context,expectedVersion: number,rules: Rule[],key: string) {
 requireOwner(c);
 assert(Array.isArray(rules)&&rules.length<=100,'invalid_rules');
 const seen=new Set<string>();
 for(const r of rules) {
  assert(r&&typeof r==='object'&&!Array.isArray(r)&&Object.keys(r).every(k=>['operation','prefix','secret_id'].includes(k))&&operations.includes(r.operation),'invalid_rule');
  if(r.operation==='secrets.list') {
   assert(r.prefix==null,'invalid_rule');
   if(r.secret_id!=null)assert(typeof r.secret_id==='string'&&await one(c,'SELECT id FROM secrets WHERE id=?',r.secret_id),'invalid_rule');
  } else {
   assert(r.secret_id==null,'invalid_rule');
   if(r.prefix!=null)path(r.prefix,true);
  }
  const signature=canonical({operation:r.operation,prefix:r.prefix??null,secret_id:r.secret_id??null});
  assert(!seen.has(signature),'duplicate_rule');seen.add(signature);
 }
 return change(c,'policy',expectedVersion,rules,key,version=>[
  statement(c,'DELETE FROM approval_rules'),
  ...rules.map(r=>statement(c,`INSERT INTO approval_rules VALUES(?,?,?,?,?,${NOW})`,opaqueId(),r.operation,r.prefix??null,r.secret_id??null,version)),
 ]);
}
export async function patchSettings(c: Context,expectedVersion: number,input: SettingsPatch,key: string) {
 requireOwner(c);
 assert(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length>0&&
  Object.keys(input).every(k=>['approval_ttl','quota_bytes','retention_ms','maintenance'].includes(k)),'invalid_settings');
 if('approval_ttl' in input)assert(Number.isSafeInteger(input.approval_ttl)&&input.approval_ttl!>=60000&&input.approval_ttl!<=3600000,'invalid_approval_expiry');
 if('quota_bytes' in input)assert(Number.isSafeInteger(input.quota_bytes)&&input.quota_bytes!>0,'invalid_quota');
 if('retention_ms' in input)assert(Number.isSafeInteger(input.retention_ms)&&input.retention_ms!>=7*DAY,'invalid_retention');
 if('maintenance' in input)assert(typeof input.maintenance==='boolean','invalid_maintenance');
 return change(c,'settings',expectedVersion,input,key,()=>[
  statement(c,`UPDATE settings SET ${Object.keys(input).map(k=>`${k}=?`).join(',')} WHERE id=1`,
   ...Object.values(input).map(v=>typeof v==='boolean'?+v:v)),
 ]);
}
