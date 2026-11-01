import { active, requireFolder, requireOwner, requiresReview } from './auth';
import { audit, auditStatement } from './audit';
import { fileBytes } from './files';
import { changedOne, storageError } from './file-transaction';
import { canonical, open, path, seal, sha } from './security';
import { assert, Context, LIMITS, LockerError, NOW, one, opaqueId, Row, settings, statement } from './types';

export const DAY = 86400000;
interface FileInput {
 operation: 'file.write' | 'file.delete' | 'file.restore'; path: string;
 expected_revision: string | null; revision?: string; source_revision?: string;
 hash?: string; length?: number; media_type?: string; previous_hash?: string; previous_length?: number;
}
export function idempotencyKey(key: string) {
 assert(typeof key === 'string' && /^[\x20-\x7e]{16,128}$/.test(key), 'invalid_idempotency_key');
 return key;
}
function identity(c: Context) { return c.actor.kind === 'owner' ? 'owner' : `agent:${c.actor.agentId}`; }
function submissionHash(input: FileInput) {
 return sha(canonical(input.operation === 'file.restore'
  ? {operation: input.operation, source_revision: input.source_revision, expected_revision: input.expected_revision} : input));
}
function summary(a: Row) {
 return {id: a.id as string, approval_id: a.approval_id as string | null, status: a.status as string,
  expires_at: a.expires_at as number, result_revision: a.result_revision as string | null,
  ...(a.result_metadata ? {result: JSON.parse(a.result_metadata)} : {}), ...(a.error_code ? {error_code: a.error_code} : {})};
}
export async function fileAction(c: Context, id: string) {
 await active(c);
 const a = await one(c, 'SELECT * FROM actions WHERE id=?', id);
 assert(a && (c.actor.kind === 'owner' || a.agent_id === c.actor.agentId), 'not_found_or_not_allowed', 404);
 assert(['file.write','file.delete','file.restore','file.read','files.list'].includes(a.operation), 'not_found_or_not_allowed', 404);
 if (c.actor.kind !== 'owner') {
  if (a.operation === 'files.list') {
   const allowed = await one(c, `SELECT 1 FROM folder_grants WHERE agent_id=? AND read=1 AND (expires_at IS NULL OR expires_at>${NOW})
    AND (substr(?,1,length(prefix))=prefix OR substr(prefix,1,length(?))=?)`, c.actor.agentId, a.target, a.target, a.target);
   assert(allowed, 'not_found_or_not_allowed', 404);
  } else await requireFolder(c, a.target, a.operation === 'file.delete' ? 'delete' : a.operation === 'file.read' ? 'read' : 'write');
 }
 await audit(c, 'action.get', a.target, 'allow', 'read', {actionId: a.id});
 return summary(a);
}
async function replay(c: Context, key: string, digest: string) {
 const found = await one(c, `SELECT k.input_digest,a.* FROM idempotency_keys k JOIN actions a ON a.id=k.action_id
  WHERE k.identity=? AND k.caller_key=? AND k.expires_at>${NOW}`, identity(c), key);
 if (!found) return null;
 assert(found.input_digest === digest, 'idempotency_conflict', 409);
 await audit(c, found.operation, found.target, 'allow', 'replayed', {actionId: found.id});
 return summary(found);
}

export async function submitWrite(c: Context, p: string, data: Uint8Array, mediaType: string, expected: string | null, key: string) {
 path(p); await requireFolder(c, p, 'write'); idempotencyKey(key);
 assert(data.length <= LIMITS.file, 'too_large', 413);
 assert(typeof mediaType === 'string' && mediaType.length > 0 && mediaType.length <= 200 && !/[\p{Cc}]/u.test(mediaType), 'invalid_media_type');
 assert(expected === null || typeof expected === 'string' && expected.length > 0 && expected.length <= 100, 'invalid_revision');
 const hash = await sha(data), input: FileInput = {operation: 'file.write', path: p, expected_revision: expected, hash, length: data.length, media_type: mediaType};
 return submit(c, input, key, data);
}
export async function submitDelete(c: Context, p: string, expected: string, key: string) {
 path(p); await requireFolder(c, p, 'delete'); idempotencyKey(key);
 assert(typeof expected === 'string' && expected.length > 0 && expected.length <= 100, 'invalid_revision');
 return submit(c, {operation: 'file.delete', path: p, expected_revision: expected}, key);
}
export async function submitRestore(c: Context, source: string, expected: string | null, key: string = opaqueId()) {
 requireOwner(c); idempotencyKey(key);
 assert(expected === null || typeof expected === 'string' && expected.length > 0 && expected.length <= 100, 'invalid_revision');
 assert(typeof source === 'string' && source.length > 0 && source.length <= 100, 'invalid_revision');
 const old = await replay(c, key, await submissionHash({operation: 'file.restore', path: '', source_revision: source, expected_revision: expected}));
 if (old) return {...old, revision: old.result_revision, path: old.result?.path, hash: old.result?.hash};
 const r = await one(c, `SELECT r.*,f.path FROM file_revisions r JOIN files f ON f.id=r.file_id
  WHERE r.id=? AND r.uploaded=1 AND r.published_at IS NOT NULL AND (r.retain_until IS NULL OR r.retain_until>${NOW})`, source);
 assert(r, 'not_found_or_not_allowed', 404);
 const input: FileInput = {operation: 'file.restore', path: r.path, expected_revision: expected, source_revision: source,
  hash: r.hash, length: r.length, media_type: r.media_type};
 await audit(c, 'file.restore', r.path, 'allow', 'intent', {metadata: {source_revision: source}});
 const {data} = await fileBytes(c, source);
 const result = await submit(c, input, key, data);
 return {...result, revision: result.result_revision, path: r.path, hash: r.hash};
}

// Persist the intent, mapping and quota reservation before writing to R2. Only
// the winner of the identity/key insert uploads; retries observe durable state.
async function submit(c: Context, base: FileInput, key: string, data?: Uint8Array) {
 const submissionDigest = await submissionHash(base), old = await replay(c, key, submissionDigest);
 if (old) return old;
 const s = await settings(c); assert(!s.maintenance && s.setup_complete, 'maintenance', 503);
 const f = await one(c, `SELECT f.*,r.hash,r.length FROM files f LEFT JOIN file_revisions r ON r.id=f.current_revision_id WHERE f.path=?`, base.path);
 assert((f?.current_revision_id ?? null) === base.expected_revision, 'revision_conflict', 409);
 if (base.operation !== 'file.restore') assert(!f?.deleted_at, 'not_found_or_not_allowed', 404);
 if (base.operation === 'file.delete') assert(f?.current_revision_id, 'not_found_or_not_allowed', 404);
 const id = opaqueId(), revision = data ? opaqueId() : undefined;
 const input: FileInput = {...base, ...(revision ? {revision} : {}), previous_hash: f?.hash, previous_length: f?.length};
 const digest = await sha(canonical({input, config_version: s.config_version, agent_id: c.actor.agentId ?? null, token_id: c.actor.tokenId ?? null}));
 const encrypted = await seal(c.env, 'action.input', id, 1, canonical(input));
 const gated = c.actor.kind !== 'owner' && (base.operation === 'file.delete' || base.expected_revision !== null || await requiresReview(c, base.operation, base.path));
 const approval = gated ? opaqueId() : null;
 const reservation = revision ? [
  statement(c, `INSERT OR IGNORE INTO files(id,path,created_at,modified_at) VALUES(?,?,${NOW},${NOW})`, opaqueId(), input.path),
  statement(c, `INSERT INTO file_revisions(id,file_id,object_key,hash,length,media_type,author_kind,agent_id,token_id,action_id,created_at,retain_until)
   SELECT ?,f.id,?,?,?,?,?,?,?,?,${NOW},${NOW}+? FROM files f WHERE path=?`,
  revision, `staged/${id}/${revision}`, input.hash, input.length, input.media_type, c.actor.kind, c.actor.agentId, c.actor.tokenId, id, DAY, input.path),
 ] : [];
 try {
  await c.env.DB.batch([
   statement(c, `DELETE FROM idempotency_keys WHERE identity=? AND caller_key=? AND expires_at<=${NOW}`, identity(c), key),
   statement(c, `INSERT INTO idempotency_keys(identity,caller_key,input_digest,action_id,created_at,expires_at) VALUES(?,?,?,?,${NOW},${NOW}+?)`, identity(c), key, submissionDigest, id, 7 * DAY),
   statement(c, `INSERT INTO actions(id,agent_id,token_id,request_id,operation,target,digest,submission_digest,input_cipher,input_nonce,key_version,
    config_version,target_revision,status,approval_id,created_at,updated_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${NOW},${NOW},${NOW}+? FROM settings WHERE id=1 AND config_version=? AND maintenance=0 AND setup_complete=1`,
   id, c.actor.agentId, c.actor.tokenId, c.requestId, input.operation, input.path, digest, submissionDigest,
   encrypted.cipher, encrypted.nonce, encrypted.keyVersion, s.config_version, input.expected_revision, gated ? 'pending' : 'ready', approval, s.approval_ttl, s.config_version),
   ...changedOne(c), ...reservation,
   ...(approval ? [statement(c, `INSERT INTO approvals(id,action_id,state,created_at,expires_at) SELECT ?,id,'pending',created_at,expires_at FROM actions WHERE id=?`, approval, id)] : []),
   auditStatement(c, input.operation, input.path, gated ? 'pending' : 'allow', revision ? 'reserved' : 'accepted', {
    actionId: id, approvalId: approval ?? undefined, metadata: {digest, ...(revision ? {revision, hash: input.hash!, length: input.length!} : {})},
   }),
  ]);
 } catch (error) {
  // A concurrent submission may have won the unique key. Never upload twice.
  const winner = await replay(c, key, submissionDigest);
  if (winner) return winner;
  storageError(error);
 }
 if (revision && data) {
  try {
   await c.env.FILES.put(`staged/${id}/${revision}`, data);
   await statement(c, 'UPDATE file_revisions SET uploaded=1 WHERE id=?', revision).run();
  } catch {
   await c.env.DB.batch([
    statement(c, `UPDATE actions SET status='failed',error_code='upload_failed',updated_at=${NOW},result_expires_at=${NOW}+? WHERE id=? AND status IN('ready','pending')`, DAY, id),
    statement(c, `UPDATE approvals SET state='invalidated',decided_at=${NOW} WHERE action_id=? AND state='pending'`, id),
    auditStatement(c, input.operation, input.path, 'deny', 'upload_failed', {actionId: id}),
   ]).catch(() => {});
   throw new LockerError('storage_unavailable', 503);
  }
 }
 if (!gated) return executeFileAction(c, id);
 return summary((await one(c, 'SELECT * FROM actions WHERE id=?', id))!);
}

// Called by immediate safe writes and, in the approval chunk, the durable
// executor. There is deliberately no agent HTTP endpoint that sets ready.
export async function executeFileAction(c: Context, id: string) {
 const a = await one(c, 'SELECT * FROM actions WHERE id=?', id);
 assert(a && ['file.write','file.delete','file.restore'].includes(a.operation), 'not_found_or_not_allowed', 404);
 assert(c.actor.kind === 'owner' || a.agent_id === c.actor.agentId, 'not_found_or_not_allowed', 404);
 if (a.status !== 'ready') return summary(a);
 const input: FileInput = JSON.parse(await open(c.env, 'action.input', id, 1, a.input_cipher, a.input_nonce, a.key_version));
 const digest = await sha(canonical({input, config_version: a.config_version, agent_id: a.agent_id, token_id: a.token_id}));
 assert(digest === a.digest && input.path === a.target && input.operation === a.operation && input.expected_revision === a.target_revision, 'action_integrity_error', 503);
 const actor = a.agent_id ? {kind: 'agent' as const, agentId: a.agent_id, tokenId: a.token_id,
  name: (await one(c, 'SELECT name FROM agents WHERE id=?', a.agent_id))?.name ?? 'Agent'} : {kind: 'owner' as const, name: 'Owner'};
 const execution = {...c, actor};
 await active(execution);
 const permission = input.operation === 'file.delete' ? 'delete' : 'write';
 await requireFolder(execution, input.path, permission);
 await audit(execution, input.operation, input.path, 'allow', 'intent', {actionId: id, metadata: {original_request_id: a.request_id}});
 if (input.revision) {
  const {r} = await fileBytes(execution, input.revision);
  assert(r.action_id === id && r.hash === input.hash && r.length === input.length && r.media_type === input.media_type, 'content_integrity_error', 503);
 }
 const result = input.operation === 'file.delete' ? {path: input.path, deleted: true, revision: input.expected_revision} :
  {path: input.path, revision: input.revision, hash: input.hash, length: input.length};
 const statements = [
  statement(c, `UPDATE actions AS a SET status='succeeded',result_revision=?,result_metadata=?,updated_at=${NOW},result_expires_at=${NOW}+?
   WHERE id=? AND status='ready' AND expires_at>${NOW}
   AND EXISTS(SELECT 1 FROM settings s WHERE s.id=1 AND s.config_version=a.config_version AND s.maintenance=0 AND s.setup_complete=1)
   AND (a.approval_id IS NULL OR EXISTS(SELECT 1 FROM approvals p WHERE p.id=a.approval_id AND p.action_id=a.id AND p.state='approved'))
   AND (a.agent_id IS NULL OR EXISTS(SELECT 1 FROM agent_tokens t JOIN agents g ON g.id=t.agent_id
    WHERE t.id=a.token_id AND t.agent_id=a.agent_id AND t.revoked_at IS NULL AND t.expires_at>${NOW} AND g.status='enabled'
    AND EXISTS(SELECT 1 FROM folder_grants fg WHERE fg.agent_id=a.agent_id AND fg."${permission}"=1
     AND (fg.expires_at IS NULL OR fg.expires_at>${NOW}) AND substr(a.target,1,length(fg.prefix))=fg.prefix)))
   AND EXISTS(SELECT 1 FROM files f WHERE f.path=a.target AND f.current_revision_id IS a.target_revision ${input.operation === 'file.restore' ? '' : 'AND f.deleted_at IS NULL'})
   ${input.source_revision ? `AND EXISTS(SELECT 1 FROM file_revisions r WHERE r.id=? AND r.uploaded=1 AND r.published_at IS NOT NULL AND (r.retain_until IS NULL OR r.retain_until>${NOW}))` : ''}
   ${input.revision ? 'AND EXISTS(SELECT 1 FROM file_revisions r WHERE r.id=? AND r.action_id=a.id AND r.uploaded=1)' : ''}`,
  input.revision ?? input.expected_revision, JSON.stringify(result), DAY, id,
  ...(input.source_revision ? [input.source_revision] : []), ...(input.revision ? [input.revision] : [])),
  ...changedOne(c),
  statement(c, `UPDATE files SET current_revision_id=?,deleted_at=${input.operation === 'file.delete' ? NOW : 'NULL'},modified_at=${NOW} WHERE path=?`,
   input.revision ?? input.expected_revision, input.path),
  statement(c, `UPDATE file_revisions SET retain_until=MAX(COALESCE(retain_until,0),${NOW}+(SELECT retention_ms FROM settings WHERE id=1)) WHERE id=?`, input.expected_revision),
  ...(input.revision ? [statement(c, `UPDATE file_revisions SET retain_until=NULL,published_at=${NOW} WHERE id=?`, input.revision)] : []),
  auditStatement(execution, input.operation, input.path, 'allow', input.operation === 'file.delete' ? 'deleted' : input.operation === 'file.restore' ? 'restored' : 'written', {
   actionId: id, approvalId: a.approval_id ?? undefined, metadata: {revision: input.revision ?? input.expected_revision!,
    ...(input.hash ? {hash: input.hash, length: input.length!} : {hash: input.previous_hash!, length: input.previous_length!}),
    ...(input.source_revision ? {source_revision: input.source_revision} : {}), original_request_id: a.request_id},
  }),
 ];
 try { await c.env.DB.batch(statements); }
 catch (error) {
  const winner = await one(c, 'SELECT * FROM actions WHERE id=?', id);
  if (winner?.status === 'succeeded') return summary(winner);
  storageError(error);
 }
 return summary((await one(c, 'SELECT * FROM actions WHERE id=?', id))!);
}
