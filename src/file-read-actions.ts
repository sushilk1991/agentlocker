import { active, requireFolder, requiresReview } from './auth';
import { audit, auditStatement } from './audit';
import { changedOne, storageError } from './file-transaction';
import { current } from './files';
import { idempotencyKey, DAY } from './file-actions';
import { canonical, seal, sha } from './security';
import { all, assert, Context, NOW, one, opaqueId, settings, statement } from './types';

// Reads ordinarily return data. Persist owner-rule-gated reads for the approval
// engine, just like writes, instead of releasing bytes before a decision.
export async function gateFileRead(c: Context, operation: 'file.read' | 'files.list', target: string,
 key: string | null, parameters: Record<string, unknown> = {}) {
 await active(c);
 if (operation === 'file.read') await requireFolder(c, target, 'read');
 const grants = operation === 'files.list' && c.actor.kind !== 'owner' ? await all(c, `SELECT prefix FROM folder_grants
  WHERE agent_id=? AND read=1 AND (expires_at IS NULL OR expires_at>${NOW})`, c.actor.agentId) : [];
 if (operation === 'files.list' && c.actor.kind !== 'owner' && !grants.some(g => target.startsWith(g.prefix) || g.prefix.startsWith(target))) return null;
 let gated = await requiresReview(c, operation, target);
 // Listing a parent must not bypass a rule on a child folder. Gate only when
 // the caller can read something in that intersection.
 if (!gated && operation === 'files.list' && c.actor.kind !== 'owner') {
  const rules = await all(c, 'SELECT prefix FROM approval_rules WHERE operation=?', operation);
  gated = rules.some(r => r.prefix?.startsWith(target) && grants.some(g => r.prefix.startsWith(g.prefix) || g.prefix.startsWith(r.prefix)));
 }
 if (!gated) return null;
 idempotencyKey(key!);
 const identity = `agent:${c.actor.agentId}`, submission = await sha(canonical({operation, target, parameters}));
 const replay = async () => {
  const a = await one(c, `SELECT k.input_digest,a.* FROM idempotency_keys k JOIN actions a ON a.id=k.action_id
   WHERE k.identity=? AND k.caller_key=? AND k.expires_at>${NOW}`, identity, key);
  if (!a) return null;
  assert(a.input_digest === submission, 'idempotency_conflict', 409);
  await audit(c, operation, target, 'allow', 'replayed', {actionId: a.id});
  return {id: a.id, approval_id: a.approval_id, status: a.status, expires_at: a.expires_at};
 };
 const existing = await replay(); if (existing) return existing;
 const s = await settings(c), id = opaqueId(), approval = opaqueId();
 const f = operation === 'file.read' ? await current(c, target) : null;
 if (operation === 'file.read') assert(f, 'not_found_or_not_allowed', 404);
 const input = {operation, target, parameters, revision: f?.current_revision_id ?? null, hash: f?.hash ?? null, length: f?.length ?? null};
 const digest = await sha(canonical({input, config_version: s.config_version, agent_id: c.actor.agentId, token_id: c.actor.tokenId}));
 const encrypted = await seal(c.env, 'action.input', id, 1, canonical(input));
 try {
  await c.env.DB.batch([
   statement(c, `DELETE FROM idempotency_keys WHERE identity=? AND caller_key=? AND expires_at<=${NOW}`, identity, key),
   statement(c, `INSERT INTO idempotency_keys VALUES(?,?,?,?,${NOW},${NOW}+?)`, identity, key, submission, id, 7 * DAY),
   statement(c, `INSERT INTO actions(id,agent_id,token_id,request_id,operation,target,digest,submission_digest,input_cipher,input_nonce,key_version,
    config_version,target_revision,result_revision,status,approval_id,created_at,updated_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,${NOW},${NOW},${NOW}+? FROM settings WHERE id=1 AND config_version=? AND maintenance=0`,
   id, c.actor.agentId, c.actor.tokenId, c.requestId, operation, target, digest, submission, encrypted.cipher, encrypted.nonce, encrypted.keyVersion,
   s.config_version, f?.current_revision_id, f?.current_revision_id, approval, s.approval_ttl, s.config_version),
   ...changedOne(c),
   statement(c, `INSERT INTO approvals(id,action_id,state,created_at,expires_at) SELECT ?,id,'pending',created_at,expires_at FROM actions WHERE id=?`, approval, id),
   auditStatement(c, operation, target, 'pending', 'accepted', {actionId: id, approvalId: approval, metadata: {digest}}),
  ]);
 } catch (error) {
  const winner = await replay(); if (winner) return winner;
  storageError(error);
 }
 return {id, approval_id: approval, status: 'pending', expires_at: (await one(c, 'SELECT expires_at FROM actions WHERE id=?', id))!.expires_at};
}
