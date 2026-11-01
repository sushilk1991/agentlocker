import { active, requireFolder, requireSecret } from './auth';
import { current, fileBytes } from './files';
import { canonical, open, proxyInput, sha, unbase64 } from './security';
import { secretHosts } from './secrets';
import { all, assert, Context, NOW, one, Row, settings } from './types';

export function actionSummary(a: Row) {
 return {id:a.id, approval_id:a.approval_id, status:a.status, expires_at:a.expires_at,
  result_revision:a.result_revision, ...(a.result_metadata?{result:JSON.parse(a.result_metadata)}:{}),
  ...(a.error_code?{error_code:a.error_code}:{}), result_available:a.status==='succeeded' && a.result_expires_at>Date.now(),
  ...(a.status==='succeeded' && a.result_expires_at<=Date.now()?{error_code:'result_expired'}:{})};
}
export async function actionActor(c: Context,a: Row): Promise<Context> {
 return {...c,actor:a.agent_id?{kind:'agent',agentId:a.agent_id,tokenId:a.token_id,
  name:(await one(c,'SELECT name FROM agents WHERE id=?',a.agent_id))?.name??'Agent'}:{kind:'owner',name:'Owner'}};
}
export async function actionAccess(c: Context,a: Row) {
 await active(c);
 assert(c.actor.kind==='owner'||a.agent_id===c.actor.agentId,'not_found_or_not_allowed',404);
 if(c.actor.kind==='owner')return;
 if(a.operation==='proxy.request') {
  const s=await one(c,'SELECT name FROM secrets WHERE id=?',a.secret_id); assert(s,'not_found_or_not_allowed',404); await requireSecret(c,s.name);
 } else if(a.operation==='secrets.list') {
  const gs=await all(c,`SELECT secret_id FROM secret_grants WHERE agent_id=? AND (expires_at IS NULL OR expires_at>${NOW})`,c.actor.agentId);
  assert(gs.length,'not_found_or_not_allowed',404);
 } else if(a.operation==='files.list') {
  assert(await one(c,`SELECT 1 FROM folder_grants WHERE agent_id=? AND read=1 AND (expires_at IS NULL OR expires_at>${NOW}) AND (substr(?,1,length(prefix))=prefix OR substr(prefix,1,length(?))=?)`,c.actor.agentId,a.target,a.target,a.target),'not_found_or_not_allowed',404);
 } else await requireFolder(c,a.target,a.operation==='file.delete'?'delete':a.operation==='file.read'?'read':'write');
}
// Keep list visibility equivalent to actionAccess, before LIMIT or cursor creation.
export const actionScopeSQL = `(
 (a.operation='proxy.request' AND EXISTS(SELECT 1 FROM secret_grants g JOIN secrets s ON s.id=g.secret_id
  WHERE g.agent_id=a.agent_id AND s.id=a.secret_id AND s.enabled=1 AND (g.expires_at IS NULL OR g.expires_at>${NOW}))) OR
 (a.operation='secrets.list' AND EXISTS(SELECT 1 FROM secret_grants g WHERE g.agent_id=a.agent_id AND (g.expires_at IS NULL OR g.expires_at>${NOW}))) OR
 (a.operation='files.list' AND EXISTS(SELECT 1 FROM folder_grants g WHERE g.agent_id=a.agent_id AND g.read=1
  AND (g.expires_at IS NULL OR g.expires_at>${NOW}) AND (substr(a.target,1,length(g.prefix))=g.prefix OR substr(g.prefix,1,length(a.target))=a.target))) OR
 (a.operation LIKE 'file.%' AND EXISTS(SELECT 1 FROM folder_grants g WHERE g.agent_id=a.agent_id
  AND (g.expires_at IS NULL OR g.expires_at>${NOW}) AND substr(a.target,1,length(g.prefix))=g.prefix
  AND CASE WHEN a.operation='file.delete' THEN g."delete" WHEN a.operation='file.read' THEN g.read ELSE g.write END=1)))`;
export async function actionInput(c: Context,a: Row) {
 assert(a.input_cipher&&a.input_nonce&&a.key_version,'action_input_expired',410);
 const input=JSON.parse(await open(c.env,'action.input',a.id,1,a.input_cipher,a.input_nonce,a.key_version));
 assert(await sha(canonical({input,config_version:a.config_version,agent_id:a.agent_id,token_id:a.token_id}))===a.digest,'action_integrity_error',503);
 assert(input.operation===a.operation && (input.path??input.target)===a.target,'action_integrity_error',503);
 return input;
}
// Complete input verification is used both for review and immediately before a
// decision/claim. SQL repeats time and authority checks inside each transaction.
export async function verifyAction(c: Context,a: Row) {
 const input=await actionInput(c,a), execution=await actionActor(c,a);
 await active(execution); await actionAccess(execution,a);
 const s=await settings(c); assert(s.config_version===a.config_version,'policy_changed',409);
 assert(s.setup_complete&&!s.maintenance,'maintenance',503);
 if(a.operation==='proxy.request') {
  const secret=await requireSecret(execution,input.secret);
  assert(secret.id===a.secret_id && secret.version===a.secret_version && secret.value_version===input.value_version && secret.injection_header===input.injection_header && secret.scheme===input.scheme,'secret_changed',409);
  const {url,method,headers,body_base64}=input.request;
  const normalized=proxyInput({url,method,headers,body_base64},secret,await secretHosts(c,secret.id),c.env.PUBLIC_ORIGIN);
  normalized.body_hash=await sha(unbase64(normalized.body_base64));
  assert(canonical(normalized)===canonical(input.request),'action_integrity_error',503);
 } else if(a.operation.startsWith('file.')) {
  const f=await current(c,a.target), expected=input.expected_revision??input.revision??null;
  assert((f?.current_revision_id??null)===expected && expected===a.target_revision,'revision_conflict',409);
  if(input.file_id)assert(f?.id===input.file_id,'revision_conflict',409);
  if(input.previous_hash!==undefined) assert(f?.hash===input.previous_hash && f?.length===input.previous_length,'content_integrity_error',503);
  if(a.operation==='file.read') assert(f?.hash===input.hash && f?.length===input.length,'content_integrity_error',503);
  if(input.revision && a.operation!=='file.read') {
   const {r}=await fileBytes(c,input.revision);
   assert(r.action_id===a.id && r.hash===input.hash && r.length===input.length && r.media_type===input.media_type,'content_integrity_error',503);
  }
 }
 return {input,execution};
}

// a is the actions alias. Changes to grants and host policy bump config_version.
// Expiring grants and credentials also need database-time checks here.
export const authoritySQL = `EXISTS(SELECT 1 FROM settings s WHERE s.id=1 AND s.setup_complete=1 AND s.maintenance=0 AND s.config_version=a.config_version)
 AND (a.agent_id IS NULL OR EXISTS(SELECT 1 FROM agent_tokens t JOIN agents g ON g.id=t.agent_id WHERE t.id=a.token_id AND t.agent_id=a.agent_id AND t.revoked_at IS NULL AND t.expires_at>${NOW} AND g.status='enabled'))
 AND (a.agent_id IS NULL OR
  (a.operation='proxy.request' AND EXISTS(SELECT 1 FROM secret_grants g JOIN secrets s ON s.id=g.secret_id WHERE g.agent_id=a.agent_id AND g.secret_id=a.secret_id AND (g.expires_at IS NULL OR g.expires_at>${NOW}) AND s.enabled=1 AND s.version=a.secret_version)) OR
  (a.operation='secrets.list' AND EXISTS(SELECT 1 FROM secret_grants g WHERE g.agent_id=a.agent_id AND (g.expires_at IS NULL OR g.expires_at>${NOW}))) OR
  (a.operation='files.list' AND EXISTS(SELECT 1 FROM folder_grants g WHERE g.agent_id=a.agent_id AND g.read=1 AND (g.expires_at IS NULL OR g.expires_at>${NOW}) AND (substr(a.target,1,length(g.prefix))=g.prefix OR substr(g.prefix,1,length(a.target))=a.target))) OR
  (a.operation LIKE 'file.%' AND EXISTS(SELECT 1 FROM folder_grants g WHERE g.agent_id=a.agent_id AND (g.expires_at IS NULL OR g.expires_at>${NOW}) AND substr(a.target,1,length(g.prefix))=g.prefix AND CASE WHEN a.operation='file.delete' THEN g."delete" WHEN a.operation='file.read' THEN g.read ELSE g.write END=1)))
 AND (a.operation NOT LIKE 'file.%' OR EXISTS(SELECT 1 FROM files f WHERE f.path=a.target AND f.current_revision_id IS a.target_revision AND f.deleted_at IS NULL))`;
