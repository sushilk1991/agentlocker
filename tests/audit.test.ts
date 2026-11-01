import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit, auditStatement } from '../src/audit';
import { createAgent } from '../src/agents';
import { database } from './helpers';

describe('append-only audit writer', () => {
 let f: Awaited<ReturnType<typeof database>>;
 beforeAll(async () => { f = await database(); });
 afterAll(async () => { await f?.runtime.dispose(); });

 it('records server time, request IDs, identity snapshots, decisions, and outcome links', async () => {
  const c = f.context({kind: 'agent', agentId: 'agent-a', tokenId: 'token-a', name: 'Coding agent'});
  const before = Date.now();
  await audit(c, 'file.read', '/a/file', 'allow', 'succeeded', {
   actionId: 'action-a', approvalId: 'approval-a', attemptId: 'attempt-a', batchId: 'batch-a',
   status: 200, reason: 'read_allowed', metadata: {revision: 'r1', length: 17, hash: 'content-hash'},
  });
  const row = await f.db.prepare('SELECT * FROM audit_events WHERE request_id=?').bind(c.requestId).first();
  expect(row).toMatchObject({request_id: c.requestId, actor_kind: 'agent', agent_id: 'agent-a', token_id: 'token-a',
   actor_name: 'Coding agent', operation: 'file.read', target: '/a/file', decision: 'allow', result: 'succeeded',
   action_id: 'action-a', approval_id: 'approval-a', attempt_id: 'attempt-a', batch_id: 'batch-a', http_status: 200, reason_code: 'read_allowed'});
  expect(Number(row!.timestamp)).toBeGreaterThanOrEqual(before - 5);
  expect(Number(row!.timestamp)).toBeLessThanOrEqual(Date.now() + 5);
  expect(JSON.parse(String(row!.metadata))).toEqual({revision: 'r1', length: 17, hash: 'content-hash'});
 });

 it('keeps separate monotonic events and preserves old actor names', async () => {
  const c = f.context({kind: 'agent', name: 'Original name', agentId: 'agent-a', tokenId: 'token-a'});
  await audit(c, 'file.delete', '/a/file', 'pending', 'pending');
  c.actor.name = 'New name';
  await audit(c, 'file.delete', '/a/file', 'deny', 'denied');
  const {results} = await f.db.prepare('SELECT * FROM audit_events WHERE request_id=? ORDER BY id').bind(c.requestId).all();
  expect(results.map(x => x.actor_name)).toEqual(['Original name', 'New name']);
  expect(Number(results[1].id)).toBeGreaterThan(Number(results[0].id));
  expect(results.map(x => x.result)).toEqual(['pending', 'denied']);
 });

 it('records authentication failures with an anonymous actor', async () => {
  const c = f.context({kind: 'anonymous', name: 'Unknown'});
  await audit(c, 'auth', 'agent', 'deny', 'unauthorized', {status: 401});
  expect(await f.db.prepare('SELECT actor_kind,agent_id,token_id FROM audit_events WHERE request_id=?').bind(c.requestId).first())
   .toEqual({actor_kind: 'anonymous', agent_id: null, token_id: null});
 });

 it('rejects audit updates and deletes, including owner attempts', async () => {
  const c = f.context();
  await audit(c, 'owner.session', 'owner', 'allow', 'succeeded');
  await expect(f.db.prepare("UPDATE audit_events SET result='failed' WHERE request_id=?").bind(c.requestId).run()).rejects.toThrow('append_only');
  await expect(f.db.prepare('DELETE FROM audit_events WHERE request_id=?').bind(c.requestId).run()).rejects.toThrow('append_only');
 });

 it.each(['authorization','body','headers','token_hash','encrypted_value','url','response'])('rejects unsafe metadata key %s', async key => {
  await expect(audit(f.context(), 'proxy.request', 'service-a', 'allow', 'pending', {metadata: {[key]: 'private'}}))
   .rejects.toHaveProperty('code', 'invalid_audit_metadata');
 });

 it('rejects token values and complete proxy URLs in structured fields', async () => {
  for (const target of [f.env.OWNER_TOKEN, 'al_' + 'f'.repeat(64), 'https://service.example/path?private=yes']) {
   await expect(audit(f.context(), 'proxy.request', target, 'allow', 'pending')).rejects.toThrow();
  }
  await expect(audit(f.context(), 'file.read', '/a/file', 'allow', 'succeeded', {metadata: {revision: f.env.OWNER_TOKEN}}))
   .rejects.toHaveProperty('code', 'sensitive_audit_field');
 });

 it('returns a sanitized failure when persistence is unavailable', async () => {
  const c = f.context();
  c.env = {...c.env, DB: {prepare: () => ({bind: () => ({run: async () => {throw new Error('database contains private data');}})})} as unknown as D1Database};
  await expect(audit(c, 'file.read', '/a/file', 'allow', 'succeeded')).rejects.toMatchObject({code: 'audit_unavailable', status: 503, message: 'audit unavailable'});
 });

 it('rolls back a protected state change when its audit insert fails', async () => {
  await f.db.prepare(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events
   WHEN NEW.operation='agent.create' BEGIN SELECT RAISE(ABORT,'test_audit_failure'); END`).run();
  await expect(createAgent(f.context(), 'must-not-exist')).rejects.toThrow('test_audit_failure');
  expect(await f.db.prepare("SELECT id FROM agents WHERE name='must-not-exist'").first()).toBeNull();
  await f.db.prepare('DROP TRIGGER fail_audit').run();
 });

 it('supports an audit statement in an atomic D1 batch', async () => {
  const c = f.context();
  await f.db.batch([
   f.db.prepare('UPDATE settings SET config_version=config_version+1 WHERE id=1'),
   auditStatement(c, 'settings.update', 'settings', 'allow', 'updated'),
  ]);
  expect(await f.db.prepare('SELECT result FROM audit_events WHERE request_id=?').bind(c.requestId).first('result')).toBe('updated');
 });
});
