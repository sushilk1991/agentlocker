import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate } from '../src/auth';
import { createAgent, issueToken, replaceGrants, revokeToken, setAgentStatus } from '../src/agents';
import { executeFileAction, fileAction, submitDelete, submitWrite } from '../src/file-actions';
import { readFile, listFiles } from '../src/files';
import { bytes, open } from '../src/security';
import { bearer, database } from './helpers';

let f: Awaited<ReturnType<typeof database>>;
const key = () => crypto.randomUUID();
const write = (p: string, content = 'original') => submitWrite(f.context(), p, bytes(content), 'text/plain', null, key());
async function agent(prefix = '/agents/', permissions = {read: true, write: true, delete: true}) {
 const owner = f.context(), a = await createAgent(owner, key()), t = await issueToken(owner, a.id, 'test');
 await replaceGrants(owner, a.id, 1, [{prefix, ...permissions}], []);
 await setAgentStatus(owner, a.id, 'enabled');
 return {a, t, c: f.context(await authenticate(owner, bearer(t.token), false))};
}
// Only the test harness decides approvals in this chunk. No agent route can do it.
async function approve(id: string) {
 await f.db.batch([
  f.db.prepare("UPDATE approvals SET state='approved',decided_at=0 WHERE action_id=?").bind(id),
  f.db.prepare("UPDATE actions SET status='ready' WHERE id=? AND status='pending'").bind(id),
 ]);
}

describe('file submissions and exact revision execution with real D1/R2', () => {
 beforeAll(async () => { f = await database(); });
 afterAll(async () => { await f?.runtime.dispose(); });

 it('keeps new writes safe and replacements pending with fixed, encrypted bytes', async () => {
  const {c} = await agent(), first = await submitWrite(c, '/agents/safe', bytes('one'), 'text/plain', null, key());
  expect(first.status).toBe('succeeded');
  const next = await submitWrite(c, '/agents/safe', bytes('two'), 'text/plain', first.result_revision, key());
  expect(next).toMatchObject({status: 'pending', approval_id: expect.any(String)});
  expect(new TextDecoder().decode((await readFile(c, '/agents/safe')).data)).toBe('one');
  const row = await f.db.prepare('SELECT * FROM actions WHERE id=?').bind(next.id).first<any>();
  expect(JSON.stringify(row)).not.toContain('two');
  const input = JSON.parse(await open(c.env, 'action.input', row.id, 1, row.input_cipher, row.input_nonce, row.key_version));
  expect(input).toMatchObject({expected_revision: first.result_revision, length: 3});
  expect((await f.db.prepare('SELECT retain_until FROM file_revisions WHERE id=?').bind(input.revision).first<any>())!.retain_until).toBeGreaterThan(Date.now());
  expect((await executeFileAction(c, next.id)).status).toBe('pending');
  await approve(next.id);
  expect((await executeFileAction(c, next.id)).status).toBe('succeeded');
  expect(new TextDecoder().decode((await readFile(c, '/agents/safe')).data)).toBe('two');
  const previous = await f.db.prepare('SELECT retain_until FROM file_revisions WHERE id=?').bind(first.result_revision).first<any>();
  expect(previous!.retain_until - Date.now()).toBeGreaterThan(7 * 86400000 - 10000);
 });

 it('does not delete before approval and preserves a tombstone and retained content', async () => {
  const {c} = await agent(), first = await write('/agents/delete');
  const pending = await submitDelete(c, '/agents/delete', first.result_revision!, key());
  expect(pending.status).toBe('pending');
  expect((await listFiles(c, '/agents/', 100)).files.map(x => x.path)).toContain('/agents/delete');
  await approve(pending.id); await executeFileAction(c, pending.id);
  expect((await listFiles(c, '/agents/', 100)).files.map(x => x.path)).not.toContain('/agents/delete');
  await expect(readFile(c, '/agents/delete')).rejects.toHaveProperty('code', 'not_found_or_not_allowed');
  expect(await f.db.prepare('SELECT current_revision_id,deleted_at FROM files WHERE path=?').bind('/agents/delete').first()).toMatchObject({current_revision_id: first.result_revision, deleted_at: expect.any(Number)});
 });

 it('deduplicates concurrent submissions, binds keys to bytes and conditions, and scopes keys to identity', async () => {
  const {c} = await agent(), first = await write('/agents/retry'), k = key();
  const results = await Promise.all(Array.from({length: 4}, () => submitDelete(c, '/agents/retry', first.result_revision!, k)));
  expect(new Set(results.map(r => r.id)).size).toBe(1);
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE action_id=?').bind(results[0].id).first('n')).toBe(1);
  await expect(submitWrite(c, '/agents/retry', bytes('different'), 'text/plain', first.result_revision, k)).rejects.toHaveProperty('code', 'idempotency_conflict');
  const another = await submitDelete(f.context(), '/agents/retry', first.result_revision!, k);
  expect(another.id).not.toBe(results[0].id);
 });

 it('allows only one replacement to publish against a revision', async () => {
  const {c} = await agent(), first = await write('/agents/race');
  const proposals = await Promise.all(['left','right'].map(x => submitWrite(c, '/agents/race', bytes(x), 'text/plain', first.result_revision, key())));
  for (const a of proposals) await approve(a.id);
  const results = await Promise.allSettled(proposals.map(a => executeFileAction(c, a.id)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect(await f.db.prepare("SELECT COUNT(*) FROM actions WHERE id IN (?,?) AND status='succeeded'").bind(...proposals.map(a => a.id)).first('COUNT(*)')).toBe(1);
 });

 it('does not execute an approved delete after the file changes', async () => {
  const {c} = await agent(), first = await write('/agents/stale');
  const deletion = await submitDelete(c, '/agents/stale', first.result_revision!, key());
  await approve(deletion.id);
  const replacement = await submitWrite(f.context(), '/agents/stale', bytes('new'), 'text/plain', first.result_revision, key());
  await expect(executeFileAction(c, deletion.id)).rejects.toHaveProperty('code', 'revision_or_policy_conflict');
  expect((await readFile(c, '/agents/stale')).r.id).toBe(replacement.result_revision);
 });

 it('blocks execution after original token revocation', async () => {
  const {c, a, t} = await agent(), first = await write('/agents/revoke');
  const deletion = await submitDelete(c, '/agents/revoke', first.result_revision!, key());
  await approve(deletion.id); await revokeToken(f.context(), a.id, t.id);
  expect((await executeFileAction(f.context(), deletion.id)).status).toBe('invalidated');
  expect((await readFile(f.context(), '/agents/revoke')).r.id).toBe(first.result_revision);
 });

 it('checks grant expiry and policy versions at commit time', async () => {
  const {c, a} = await agent(), first = await write('/agents/expiry');
  const deletion = await submitDelete(c, '/agents/expiry', first.result_revision!, key()); await approve(deletion.id);
  await f.db.prepare('UPDATE folder_grants SET expires_at=1 WHERE agent_id=?').bind(a.id).run();
  await expect(executeFileAction(f.context(), deletion.id)).rejects.toHaveProperty('code', 'not_found_or_not_allowed');
  await f.db.prepare('UPDATE folder_grants SET expires_at=NULL WHERE agent_id=?').bind(a.id).run();
  await f.db.prepare('UPDATE settings SET config_version=config_version+1').run();
  await expect(executeFileAction(c, deletion.id)).rejects.toHaveProperty('code', 'revision_or_policy_conflict');
  expect((await readFile(f.context(), '/agents/expiry')).r.id).toBe(first.result_revision);
 });

 it('rejects expired execution using database time even without a sweep', async () => {
  const {c} = await agent(), first = await write('/agents/action-expiry');
  const deletion = await submitDelete(c, '/agents/action-expiry', first.result_revision!, key()); await approve(deletion.id);
  // The immutable action deadline is shortened only by the test harness.
  await f.db.prepare('DROP TRIGGER action_immutable').run();
  await f.db.prepare('UPDATE actions SET expires_at=1 WHERE id=?').bind(deletion.id).run();
  await expect(executeFileAction(c, deletion.id)).rejects.toHaveProperty('code', 'revision_or_policy_conflict');
 });

 it('requires independent permissions and conceals unknown and ungranted paths alike', async () => {
  const {c} = await agent('/write-only/', {read: false, write: true, delete: false});
  const first = await submitWrite(c, '/write-only/file', bytes('hidden'), 'text/plain', null, key());
  for (const p of ['/write-only/file','/other/unknown']) {
   await expect(readFile(c, p)).rejects.toMatchObject({code: 'not_found_or_not_allowed', status: 404});
   await expect(submitDelete(c, p, first.result_revision!, key())).rejects.toMatchObject({code: 'not_found_or_not_allowed', status: 404});
  }
  expect((await listFiles(c, '/', 100)).files).toEqual([]);
 });

 it('conceals another agent action and requires current grants for polling', async () => {
  const firstAgent = await agent(), first = await write('/agents/status');
  const deletion = await submitDelete(firstAgent.c, '/agents/status', first.result_revision!, key());
  const second = await agent();
  await expect(fileAction(second.c, deletion.id)).rejects.toHaveProperty('code', 'not_found_or_not_allowed');
  await f.db.prepare('DELETE FROM folder_grants WHERE agent_id=?').bind(firstAgent.a.id).run();
  await expect(fileAction(firstAgent.c, deletion.id)).rejects.toHaveProperty('code', 'not_found_or_not_allowed');
 });
});
