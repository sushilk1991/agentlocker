import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { database } from './helpers';
import { listFiles, restore, visibleFile } from '../src/files';
import { submitWrite, submitDelete } from '../src/file-actions';
import { bytes } from '../src/security';

describe('file storage', () => {
 let f: Awaited<ReturnType<typeof database>>;
 beforeAll(async () => { f = await database(); });
 afterAll(async () => { await f?.runtime.dispose(); });
 it('creates an immutable revision and replays its idempotency key', async () => {
  const c = f.context(), key = crypto.randomUUID();
  const first = await submitWrite(c, '/notes/a', bytes('hello'), 'text/plain', null, key);
  expect(first.status).toBe('succeeded');
  const retry = await submitWrite(c, '/notes/a', bytes('hello'), 'text/plain', null, key);
  expect(retry.id).toBe(first.id);
  expect((await visibleFile(c, '/notes/a')).current_revision_id).toBe(first.result_revision);
  expect((await listFiles(c, '/notes/', 50)).files).toHaveLength(1);
 });
 it('conceals deleted files and restores retained bytes as a new revision', async () => {
  const c = f.context();
  const first = await submitWrite(c, '/notes/deleted', bytes('keep me'), 'text/plain', null, crypto.randomUUID());
  await submitDelete(c, '/notes/deleted', first.result_revision!, crypto.randomUUID());
  await expect(visibleFile(c, '/notes/deleted')).rejects.toHaveProperty('code', 'not_found_or_not_allowed');
  const result = await restore(c, first.result_revision!, first.result_revision!);
  expect(result.revision).not.toBe(first.result_revision);
 });
});

describe('retention, quota, and storage failures', () => {
 let f: Awaited<ReturnType<typeof database>>;
 beforeAll(async () => { f = await database(); });
 afterAll(async () => { await f?.runtime.dispose(); });
 const key = () => crypto.randomUUID();
 const write = (p: string, text = 'data', expected: string | null = null, k = key()) => submitWrite(f.context(), p, bytes(text), 'text/plain', expected, k);

 it('rejects blind overwrite and wrong revision without staging', async () => {
  await write('/overwrite');
  for (const expected of [null, 'wrong-revision']) {
   await expect(write('/overwrite', 'new', expected)).rejects.toHaveProperty('code', 'revision_conflict');
  }
  expect(await f.db.prepare("SELECT COUNT(*) AS n FROM file_revisions r JOIN files f ON f.id=r.file_id WHERE f.path='/overwrite'").first('n')).toBe(1);
 });

 it('binds replay to decoded bytes, media type, path and expected revision', async () => {
  const k = key(), original = await write('/idempotency', 'one', null, k);
  expect((await write('/idempotency', 'one', null, k)).id).toBe(original.id);
  for (const [p, content, media, expected] of [
   ['/idempotency','two','text/plain',null], ['/elsewhere','one','text/plain',null],
   ['/idempotency','one','application/json',null], ['/idempotency','one','text/plain',original.result_revision],
  ] as const) {
   await expect(submitWrite(f.context(), p, bytes(content), media, expected, k)).rejects.toHaveProperty('code', 'idempotency_conflict');
  }
 });

 it('allows a new action after the seven-day mapping expires', async () => {
  const k = key(), first = await write('/mapping', 'one', null, k);
  const expiry = await f.db.prepare('SELECT expires_at-created_at AS ttl FROM idempotency_keys WHERE caller_key=?').bind(k).first('ttl');
  expect(expiry).toBe(7 * 86400000);
  await f.db.prepare('UPDATE idempotency_keys SET expires_at=1 WHERE caller_key=?').bind(k).run();
  const second = await write('/mapping', 'two', first.result_revision, k);
  expect(second.id).not.toBe(first.id);
 });

 it.each(['short', 'x'.repeat(129), 'x'.repeat(15) + '\n'])('rejects an invalid idempotency key', async k => {
  await expect(write('/invalid-key', 'data', null, k)).rejects.toHaveProperty('code', 'invalid_idempotency_key');
 });

 it('enforces quota across concurrent reservations including retained versions', async () => {
  const used = Number(await f.db.prepare('SELECT COALESCE(SUM(length),0) AS n FROM file_revisions').first('n'));
  await f.db.prepare('UPDATE settings SET quota_bytes=?').bind(used + 5).run();
  try {
   const results = await Promise.allSettled([write('/quota-a'), write('/quota-b')]);
   expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
   expect(results.find(x => x.status === 'rejected')).toMatchObject({reason: {code: 'quota_exceeded', status: 429}});
   expect(Number(await f.db.prepare('SELECT SUM(length) AS n FROM file_revisions').first('n'))).toBe(used + 4);
  } finally { await f.db.prepare('UPDATE settings SET quota_bytes=1073741824').run(); }
 });

 it('reserves restore quota before writing and keeps original history', async () => {
  const first = await write('/restore-quota');
  await submitDelete(f.context(), '/restore-quota', first.result_revision!, key());
  const used = Number(await f.db.prepare('SELECT SUM(length) AS n FROM file_revisions').first('n'));
  await f.db.prepare('UPDATE settings SET quota_bytes=?').bind(used).run();
  try { await expect(restore(f.context(), first.result_revision!, first.result_revision)).rejects.toHaveProperty('code', 'quota_exceeded'); }
  finally { await f.db.prepare('UPDATE settings SET quota_bytes=1073741824').run(); }
  expect(await f.db.prepare('SELECT deleted_at FROM files WHERE path=?').bind('/restore-quota').first('deleted_at')).toBeTypeOf('number');
 });

 it('leaves failed uploads reserved, invisible, and idempotent', async () => {
  const original = f.env.FILES, c = f.context(), k = key();
  c.env = {...f.env, FILES: {put: async () => { throw new Error('test upload failure'); }} as unknown as R2Bucket};
  await expect(submitWrite(c, '/failed-upload', bytes('unavailable'), 'text/plain', null, k)).rejects.toHaveProperty('code', 'storage_unavailable');
  await expect(visibleFile(f.context(), '/failed-upload')).rejects.toHaveProperty('code', 'not_found_or_not_allowed');
  const retry = await submitWrite(f.context(), '/failed-upload', bytes('unavailable'), 'text/plain', null, k);
  expect(retry.status).toBe('failed');
  expect(await f.db.prepare('SELECT uploaded,length FROM file_revisions WHERE action_id=?').bind(retry.id).first()).toEqual({uploaded: 0, length: 11});
  expect(f.env.FILES).toBe(original);
 });

 it('rolls back pointers, retention and success when the final audit insert fails', async () => {
  const first = await write('/commit-failure');
  await f.db.prepare(`CREATE TRIGGER fail_file_result BEFORE INSERT ON audit_events WHEN NEW.operation='file.write' AND NEW.result='written'
   BEGIN SELECT RAISE(ABORT,'test_result_failure'); END`).run();
  try { await expect(write('/commit-failure', 'uncommitted', first.result_revision)).rejects.toHaveProperty('code', 'storage_unavailable'); }
  finally { await f.db.prepare('DROP TRIGGER fail_file_result').run(); }
  expect((await visibleFile(f.context(), '/commit-failure')).current_revision_id).toBe(first.result_revision);
  expect(await f.db.prepare('SELECT retain_until FROM file_revisions WHERE id=?').bind(first.result_revision).first('retain_until')).toBeNull();
  const staged = await f.db.prepare("SELECT r.* FROM file_revisions r JOIN files f ON f.id=r.file_id WHERE f.path='/commit-failure' AND r.id!=?").bind(first.result_revision).first<any>();
  expect(staged.uploaded).toBe(1);
  expect(staged.published_at).toBeNull();
  expect(await f.env.FILES.head(staged.object_key)).toBeTruthy();
 });

 it('blocks initial audit failure before any upload', async () => {
  await f.db.prepare(`CREATE TRIGGER fail_file_intent BEFORE INSERT ON audit_events WHEN NEW.operation='file.write'
   BEGIN SELECT RAISE(ABORT,'test_intent_failure'); END`).run();
  try { await expect(write('/intent-failure')).rejects.toHaveProperty('code', 'storage_unavailable'); }
  finally { await f.db.prepare('DROP TRIGGER fail_file_intent').run(); }
  expect(await f.db.prepare("SELECT id FROM files WHERE path='/intent-failure'").first()).toBeNull();
 });

 it('prevents agents from restoring or reading history', async () => {
  const first = await write('/owner-restore');
  const c = f.context({kind: 'agent', name: 'Untrusted', agentId: 'none', tokenId: 'none'});
  await expect(restore(c, first.result_revision!, first.result_revision)).rejects.toHaveProperty('code', 'forbidden');
  const {revisions, retainedContent} = await import('../src/files');
  await expect(revisions(c, '/owner-restore')).rejects.toHaveProperty('code', 'forbidden');
  await expect(retainedContent(c, first.result_revision!)).rejects.toHaveProperty('code', 'forbidden');
 });

 it('rejects corruption instead of returning partial or changed content', async () => {
  const first = await write('/corrupt');
  const r = await f.db.prepare('SELECT object_key FROM file_revisions WHERE id=?').bind(first.result_revision).first<any>();
  await f.env.FILES.put(r.object_key, bytes('wrong bytes'));
  const {readFile} = await import('../src/files');
  await expect(readFile(f.context(), '/corrupt')).rejects.toHaveProperty('code', 'content_integrity_error');
 });

 it('preserves current, retained, live staged and result-pinned revisions during cleanup', async () => {
  const {cleanupFiles} = await import('../src/file-cleanup');
  const {revisions, retainedContent} = await import('../src/files');
  const first = await write('/cleanup'), second = await write('/cleanup', 'new', first.result_revision);
  await f.db.prepare('UPDATE file_revisions SET retain_until=1 WHERE id=?').bind(first.result_revision).run();
  await expect(retainedContent(f.context(), first.result_revision!)).rejects.toHaveProperty('code', 'not_found_or_not_allowed');
  expect((await revisions(f.context(), '/cleanup')).revisions.map(r => r.revision)).not.toContain(first.result_revision);
  // Its action-result deadline still pins it, even though file retention passed.
  await cleanupFiles(f.context());
  expect(await f.db.prepare('SELECT id FROM file_revisions WHERE id=?').bind(first.result_revision).first()).toBeTruthy();
  await f.db.prepare('UPDATE actions SET result_expires_at=1 WHERE id=?').bind(first.id).run();
  const r = await f.db.prepare('SELECT object_key FROM file_revisions WHERE id=?').bind(first.result_revision).first<any>();
  await cleanupFiles(f.context());
  expect(await f.db.prepare('SELECT id FROM file_revisions WHERE id=?').bind(first.result_revision).first()).toBeNull();
  expect(await f.env.FILES.head(r.object_key)).toBeNull();
  expect((await visibleFile(f.context(), '/cleanup')).current_revision_id).toBe(second.result_revision);
  // The failed final commit left a ready action with a staged object: keep it.
  await f.db.prepare("UPDATE file_revisions SET retain_until=1 WHERE published_at IS NULL").run();
  await cleanupFiles(f.context());
  expect(await f.db.prepare("SELECT r.id FROM file_revisions r JOIN files f ON f.id=r.file_id WHERE f.path='/commit-failure' AND r.published_at IS NULL").first()).toBeTruthy();
 });

 it('removes abandoned uploads only after terminal retention and keeps tombstones visible to owner', async () => {
  const {cleanupFiles, storageUsage} = await import('../src/file-cleanup');
  const first = await write('/expired-delete');
  const deletion = await submitDelete(f.context(), '/expired-delete', first.result_revision!, key());
  await f.db.prepare('UPDATE actions SET result_expires_at=1 WHERE id IN (?,?)').bind(first.id, deletion.id).run();
  await f.db.prepare('UPDATE file_revisions SET retain_until=1 WHERE id=?').bind(first.result_revision).run();
  const before = await storageUsage(f.context());
  await cleanupFiles(f.context());
  expect((await storageUsage(f.context())).bytes).toBe(before.bytes - 4);
  expect((await listFiles(f.context(), '/', 100, undefined, true)).files).toContainEqual(expect.objectContaining({path: '/expired-delete', deleted_at: expect.any(Number)}));
  await expect(restore(f.context(), first.result_revision!, first.result_revision)).rejects.toHaveProperty('code', 'not_found_or_not_allowed');
 });

 it('does not release a quota reservation if R2 deletion fails', async () => {
  const {cleanupFiles, storageUsage} = await import('../src/file-cleanup');
  const first = await write('/cleanup-failure');
  const deletion = await submitDelete(f.context(), '/cleanup-failure', first.result_revision!, key());
  await f.db.prepare('UPDATE actions SET result_expires_at=1 WHERE id IN (?,?)').bind(first.id, deletion.id).run();
  await f.db.prepare('UPDATE file_revisions SET retain_until=1 WHERE id=?').bind(first.result_revision).run();
  const before = await storageUsage(f.context()), c = f.context();
  c.env = {...c.env, FILES: {delete: async () => {throw new Error('test delete failure');}} as unknown as R2Bucket};
  await expect(cleanupFiles(c)).rejects.toThrow('test delete failure');
  expect((await storageUsage(f.context())).bytes).toBe(before.bytes);
  await cleanupFiles(f.context());
  expect((await storageUsage(f.context())).bytes).toBe(before.bytes - 4);
 });
});

describe('file history and boundary cases', () => {
 let f: Awaited<ReturnType<typeof database>>;
 beforeAll(async () => { f = await database(); });
 afterAll(async () => { await f?.runtime.dispose(); });
 const key = () => crypto.randomUUID();
 const write = (p: string, text: string, expected: string | null = null) => submitWrite(f.context(), p, bytes(text), 'text/plain', expected, key());

 it('paginates retained history without exposing staged objects', async () => {
  const {revisions} = await import('../src/files');
  const a = await write('/history', 'a'), b = await write('/history', 'b', a.result_revision);
  await write('/history', 'c', b.result_revision);
  const first = await revisions(f.context(), '/history', 1);
  expect(first.revisions).toHaveLength(1); expect(first.cursor).toBeTypeOf('string');
  const second = await revisions(f.context(), '/history', 1, first.cursor!);
  expect(second.revisions[0].revision).not.toBe(first.revisions[0].revision);
  const third = await revisions(f.context(), '/history', 1, second.cursor!);
  expect(third.revisions[0].revision).toBe(a.result_revision); expect(third.cursor).toBeNull();
  await expect(revisions(f.context(), '/other', 1, first.cursor!)).rejects.toHaveProperty('code', 'invalid_cursor');
 });

 it('replays restore after the source expires and checks the current-path precondition', async () => {
  const first = await write('/restore-retry', 'source'), next = await write('/restore-retry', 'next', first.result_revision), k = key();
  await expect(restore(f.context(), first.result_revision!, first.result_revision)).rejects.toHaveProperty('code', 'revision_conflict');
  const restored = await restore(f.context(), first.result_revision!, next.result_revision, k);
  await f.db.prepare('UPDATE file_revisions SET retain_until=1 WHERE id=?').bind(first.result_revision).run();
  const replayed = await restore(f.context(), first.result_revision!, next.result_revision, k);
  expect(replayed.id).toBe(restored.id); expect(replayed.revision).toBe(restored.revision);
  await expect(restore(f.context(), first.result_revision!, restored.revision)).rejects.toHaveProperty('code', 'not_found_or_not_allowed');
 });

 it('round-trips an empty file and refuses oversized inline reads', async () => {
  const {fileBytes, readFile} = await import('../src/files');
  await write('/empty', ''); expect((await readFile(f.context(), '/empty')).data).toEqual(new Uint8Array());
  const large = await submitWrite(f.context(), '/inline', new Uint8Array(1024 * 1024 + 1), 'application/octet-stream', null, key());
  await expect(fileBytes(f.context(), large.result_revision!, 1024 * 1024)).rejects.toMatchObject({code: 'too_large', status: 413, message: expect.stringContaining('HTTP')});
 });

 it('keeps revision content immutable at the database boundary', async () => {
  const first = await write('/immutable', 'immutable');
  await expect(f.db.prepare('UPDATE file_revisions SET hash=? WHERE id=?').bind('bad', first.result_revision).run()).rejects.toThrow('immutable_revision');
  await expect(f.db.prepare('UPDATE actions SET input_cipher=? WHERE id=?').bind('bad', first.id).run()).rejects.toThrow('immutable_action');
 });

 it('stops storage cleanup while maintenance is enabled', async () => {
  const {cleanupFiles} = await import('../src/file-cleanup');
  await f.db.prepare('UPDATE settings SET maintenance=1').run();
  try { await expect(cleanupFiles(f.context())).rejects.toMatchObject({code: 'maintenance', status: 503}); }
  finally { await f.db.prepare('UPDATE settings SET maintenance=0').run(); }
 });
});
