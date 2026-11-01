import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { active, authenticate, folderAllowed, grants, requireFolder, requireSecret, requiresReview } from '../src/auth';
import { createAgent, issueToken, replaceGrants, revokeToken, setAgentStatus } from '../src/agents';
import type { FolderGrant } from '../src/agents';
import { bearer, database } from './helpers';

describe('folder and named-secret grants', () => {
 let f: Awaited<ReturnType<typeof database>>;
 beforeAll(async () => {
  f = await database();
  await f.db.prepare(`INSERT INTO secrets(id,name,encrypted_value,nonce,key_version,injection_header,scheme,created_at,updated_at)
   VALUES('key-a','service-a','ciphertext-canary','nonce','1','authorization','bearer',0,0),
   ('key-b','service-b','other-ciphertext','nonce','1','authorization','bearer',0,0)`).run();
 });
 afterAll(async () => { await f?.runtime.dispose(); });
 const grant = (prefix: string, overrides: Partial<FolderGrant> = {}): FolderGrant => ({prefix, read: false, write: false, delete: false, ...overrides});
 async function fixture(folders: FolderGrant[] = [], secrets: string[] = []) {
  const owner = f.context(), a = await createAgent(owner, crypto.randomUUID());
  const t = await issueToken(owner, a.id, 'task');
  await replaceGrants(owner, a.id, 1, folders, secrets.map(secret_id => ({secret_id, read: true})));
  await setAgentStatus(owner, a.id, 'enabled');
  const identity = await authenticate(owner, bearer(t.token), false);
  return {owner, a, t, c: f.context(identity)};
 }

 it('starts disabled and without any grants', async () => {
  const {c} = await fixture();
  expect(await grants(c)).toEqual({folders: [], secrets: []});
  for (const p of ['read','write','delete'] as const) expect(await folderAllowed(c, '/a/file', p)).toBe(false);
  await expect(requireFolder(c, '/unknown', 'read')).rejects.toMatchObject({code: 'not_found_or_not_allowed', status: 404});
 });

 it.each(['read','write','delete'] as const)('keeps %s independent', async permission => {
  const {c} = await fixture([grant('/a/', {[permission]: true})]);
  for (const p of ['read','write','delete'] as const) expect(await folderAllowed(c, '/a/file', p)).toBe(p === permission);
  expect(await folderAllowed(c, '/ab/file', permission)).toBe(false);
 });

 it('unions overlapping grants and ignores expired grants', async () => {
  const {c} = await fixture([
   grant('/a/', {read: true}), grant('/a/deep/', {write: true}),
   grant('/expired/', {read: true, expires_at: 1}),
  ]);
  expect(await folderAllowed(c, '/a/deep/file', 'read')).toBe(true);
  expect(await folderAllowed(c, '/a/deep/file', 'write')).toBe(true);
  expect(await folderAllowed(c, '/a/file', 'write')).toBe(false);
  expect(await folderAllowed(c, '/expired/file', 'read')).toBe(false);
  expect((await grants(c)).folders).toHaveLength(2);
 });

 it('supports explicit root grants and owner access after path validation', async () => {
  const {c, owner} = await fixture([grant('/', {read: true})]);
  expect(await folderAllowed(c, '/any/file', 'read')).toBe(true);
  expect(await folderAllowed(owner, '/any/file', 'delete')).toBe(true);
  await expect(folderAllowed(owner, '/a/../private', 'read')).rejects.toMatchObject({code: 'invalid_path'});
 });

 it('returns only granted secret metadata and uses the same error for unknown or ungranted secrets', async () => {
  const {c} = await fixture([], ['key-a']);
  const visible = (await grants(c)).secrets;
  expect(visible).toEqual([expect.objectContaining({id: 'key-a', name: 'service-a', read: 1})]);
  expect(JSON.stringify(visible)).not.toContain('ciphertext');
  expect(JSON.stringify(visible)).not.toContain('service-b');
  // requireSecret is internal to the Worker proxy, never an agent response serializer.
  expect(await requireSecret(c, 'service-a')).toHaveProperty('id', 'key-a');
  for (const name of ['service-b', 'unknown']) await expect(requireSecret(c, name)).rejects.toMatchObject({code: 'not_found_or_not_allowed', status: 404});
 });

 it('ignores expired grants and disabled secrets immediately', async () => {
  const {c, a} = await fixture([], ['key-a']);
  await f.db.prepare('UPDATE secret_grants SET expires_at=1 WHERE agent_id=?').bind(a.id).run();
  await expect(requireSecret(c, 'service-a')).rejects.toHaveProperty('code', 'not_found_or_not_allowed');
  await f.db.prepare('UPDATE secret_grants SET expires_at=NULL WHERE agent_id=?').bind(a.id).run();
  await f.db.prepare("UPDATE secrets SET enabled=0 WHERE id='key-a'").run();
  expect((await grants(c)).secrets).toEqual([]);
  await expect(requireSecret(c, 'service-a')).rejects.toHaveProperty('code', 'not_found_or_not_allowed');
  await f.db.prepare("UPDATE secrets SET enabled=1 WHERE id='key-a'").run();
 });

 it('rechecks token revocation on a previously authenticated context', async () => {
  const {c, owner, a, t} = await fixture([grant('/a/', {read: true})], ['key-a']);
  await revokeToken(owner, a.id, t.id);
  for (const check of [active(c), folderAllowed(c, '/a/file', 'read'), grants(c), requireSecret(c, 'service-a')]) {
   await expect(check).rejects.toMatchObject({code: 'credential_revoked', status: 403});
  }
 });

 it('does not accept an anonymous or mismatched token identity', async () => {
  const {c} = await fixture([grant('/a/', {read: true})]);
  await expect(active({...c, actor: {...c.actor, agentId: 'another-agent'}})).rejects.toHaveProperty('code', 'credential_revoked');
  await expect(folderAllowed(f.context({kind: 'anonymous', name: 'Unknown'}), '/a/file', 'read')).rejects.toHaveProperty('code', 'unauthorized');
 });

 it('prevents agent access to owner mutations', async () => {
  const {c, a, t} = await fixture();
  for (const mutation of [
   createAgent(c, 'intruder'), issueToken(c, a.id, 'intruder'), revokeToken(c, a.id, t.id),
   setAgentStatus(c, a.id, 'revoked'), replaceGrants(c, a.id, 3, [grant('/', {read: true})], []),
  ]) await expect(mutation).rejects.toMatchObject({code: 'forbidden', status: 403});
 });

 it('replaces permissions, bumps versions, and rejects stale replacements atomically', async () => {
  const {owner, a, c} = await fixture([grant('/a/', {read: true})]);
  await expect(replaceGrants(owner, a.id, 3, [grant('/b/', {write: true})], [])).resolves.toEqual({version: 4});
  const auditBefore = await f.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE operation='grants.replace' AND target=?").bind(a.id).first('n');
  await expect(replaceGrants(owner, a.id, 3, [grant('/', {read: true})], [])).rejects.toMatchObject({code: 'version_conflict', status: 409});
  expect(await folderAllowed(c, '/a/file', 'read')).toBe(false);
  expect(await folderAllowed(c, '/b/file', 'write')).toBe(true);
  expect(await folderAllowed(c, '/outside/file', 'read')).toBe(false);
  expect(await f.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE operation='grants.replace' AND target=?").bind(a.id).first('n')).toBe(auditBefore);
 });

 it('allows only one concurrent replacement with the same version', async () => {
  const {owner, a} = await fixture();
  const result = await Promise.allSettled([
   replaceGrants(owner, a.id, 3, [grant('/first/', {read: true})], []),
   replaceGrants(owner, a.id, 3, [grant('/second/', {read: true})], []),
  ]);
  expect(result.filter(x => x.status === 'fulfilled')).toHaveLength(1);
  expect(result.filter(x => x.status === 'rejected')).toHaveLength(1);
 });

 it('rolls back grants and versions when a secret reference is invalid', async () => {
  const {owner, a, c} = await fixture([grant('/a/', {read: true})]);
  await expect(replaceGrants(owner, a.id, 3, [], [{secret_id: 'missing', read: true}])).rejects.toThrow();
  expect(await folderAllowed(c, '/a/file', 'read')).toBe(true);
  expect(await f.db.prepare('SELECT version FROM agents WHERE id=?').bind(a.id).first('version')).toBe(3);
 });

 it('rejects malformed and duplicate grants before mutation', async () => {
  const {owner, a} = await fixture();
  for (const prefix of ['/a', '/a/../', '/a//', '/%2e/']) {
   await expect(replaceGrants(owner, a.id, 3, [grant(prefix)], [])).rejects.toHaveProperty('code', 'invalid_path');
  }
  await expect(replaceGrants(owner, a.id, 3, [grant('/a/'), grant('/a/')], [])).rejects.toHaveProperty('code', 'duplicate_grant');
  await expect(replaceGrants(owner, a.id, 3, [grant('/a/', {expires_at: 1.5})], [])).rejects.toHaveProperty('code', 'invalid_grant_expiry');
 });

 it('always gates deletes and sends and applies additional folder rules', async () => {
  const {c} = await fixture();
  expect(await requiresReview(c, 'file.delete', '/a/file')).toBe(true);
  expect(await requiresReview(c, 'proxy.request', 'service-a')).toBe(true);
  expect(await requiresReview(c, 'file.read', '/a/file')).toBe(false);
  await f.db.prepare("INSERT INTO approval_rules(id,operation,prefix,version,created_at) VALUES('read-a','file.read','/a/',1,0)").run();
  expect(await requiresReview(c, 'file.read', '/a/file')).toBe(true);
  expect(await requiresReview(c, 'file.read', '/ab/file')).toBe(false);
 });
});
