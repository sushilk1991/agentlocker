import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSchema, ready } from '../src/auth';
import { createAgent, issueToken, revokeToken, setAgentStatus } from '../src/agents';
import { applyMigration, database } from './helpers';

describe('core D1 migrations', () => {
 let f: Awaited<ReturnType<typeof database>>;
 beforeAll(async () => { f = await database(); });
 afterAll(async () => { await f?.runtime.dispose(); });

 it('applies the complete schema to an empty database', async () => {
  await expect(checkSchema(f.context())).resolves.toBeUndefined();
  await expect(ready(f.context())).resolves.toMatchObject({setup_complete: 1, config_version: 1});
  const {results} = await f.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
  expect(results.map(x => x.name)).toEqual(expect.arrayContaining(['audit_agent','audit_decision','audit_time','audit_request','audit_token']));
 });

 it('enforces foreign keys, token uniqueness, hash shape, and maximum token age', async () => {
  const owner = f.context(), a = await createAgent(owner, 'schema-agent');
  const token = await issueToken(owner, a.id, 'task');
  const row = await f.db.prepare('SELECT * FROM agent_tokens WHERE id=?').bind(token.id).first();
  const insert = (id: string, agentId: string, hash: string, expiry: number) => f.db.prepare(`INSERT INTO agent_tokens(id,agent_id,token_hash,prefix,label,created_at,expires_at)
   VALUES(?,?,?,'al_display','test',0,?)`).bind(id, agentId, hash, expiry).run();
  await expect(insert('orphan', 'missing', 'a'.repeat(64), 1)).rejects.toThrow('FOREIGN KEY');
  await expect(insert('duplicate', a.id, String(row!.token_hash), 1)).rejects.toThrow('UNIQUE');
  await expect(insert('plaintext', a.id, token.token, 1)).rejects.toThrow('invalid_token_hash');
  await expect(insert('too-long', a.id, 'd'.repeat(64), 2592000001)).rejects.toThrow('CHECK');
 });

 it('keeps token identity immutable and revocation permanent', async () => {
  const owner = f.context(), a = await createAgent(owner, 'immutable-agent');
  const t = await issueToken(owner, a.id, 'task');
  await expect(f.db.prepare('UPDATE agent_tokens SET expires_at=expires_at+1 WHERE id=?').bind(t.id).run()).rejects.toThrow('immutable_token');
  await revokeToken(owner, a.id, t.id);
  await revokeToken(owner, a.id, t.id);
  await expect(f.db.prepare('UPDATE agent_tokens SET revoked_at=NULL WHERE id=?').bind(t.id).run()).rejects.toThrow('credential_revoked');
  await setAgentStatus(owner, a.id, 'revoked');
  await expect(setAgentStatus(owner, a.id, 'enabled')).rejects.toThrow('agent_revoked');
  expect(await f.db.prepare('SELECT agent_id FROM agent_tokens WHERE id=?').bind(t.id).first('agent_id')).toBe(a.id);
 });

 it('fails closed for unsupported schema, incomplete setup, and maintenance', async () => {
  await f.db.prepare('UPDATE schema_version SET version=999').run();
  await expect(ready(f.context())).rejects.toMatchObject({code: 'schema_unavailable', status: 503});
  await f.db.prepare('UPDATE schema_version SET version=2').run();
  await f.db.prepare('UPDATE settings SET setup_complete=0 WHERE id=1').run();
  await expect(ready(f.context())).rejects.toHaveProperty('code', 'setup_required');
  await f.db.prepare('UPDATE settings SET setup_complete=1,maintenance=1 WHERE id=1').run();
  await expect(ready(f.context())).rejects.toHaveProperty('code', 'maintenance');
 });
});

describe('upgrade from the existing initial migration', () => {
 let f: Awaited<ReturnType<typeof database>>;
 beforeAll(async () => { f = await database(false); });
 afterAll(async () => { await f?.runtime.dispose(); });

 it('rejects a missing schema with a sanitized error', async () => {
  await expect(checkSchema(f.context())).rejects.toMatchObject({code: 'schema_unavailable', message: 'schema unavailable', status: 503});
 });

 it('preserves identities, hashes, revocations, grants, and audit IDs', async () => {
  await applyMigration(f.db, '0001_initial.sql');
  await f.db.prepare("INSERT INTO agents(id,name,status,created_at) VALUES('old-agent','Old agent','revoked',0)").run();
  await f.db.prepare(`INSERT INTO agent_tokens(id,agent_id,token_hash,prefix,label,created_at,expires_at,revoked_at)
   VALUES('old-token','old-agent',?,'al_display','old task',0,1000,500)`).bind('b'.repeat(64)).run();
  await f.db.prepare(`INSERT INTO folder_grants(id,agent_id,prefix,read,write,"delete",version,created_at)
   VALUES('old-grant','old-agent','/old/',1,0,0,1,0)`).run();
  await f.db.prepare(`INSERT INTO audit_events(id,request_id,actor_kind,actor_name,operation,target,decision,result,reason_code)
   VALUES(42,'old-request','owner','Owner','agent.revoke','old-agent','allow','revoked','revoked')`).run();
  await expect(checkSchema(f.context())).rejects.toHaveProperty('code', 'schema_unavailable');
  await applyMigration(f.db, '0002_core_guards.sql');
  await expect(checkSchema(f.context())).resolves.toBeUndefined();
  expect(await f.db.prepare('SELECT token_hash,revoked_at FROM agent_tokens').first()).toEqual({token_hash: 'b'.repeat(64), revoked_at: 500});
  expect(await f.db.prepare('SELECT prefix FROM folder_grants').first('prefix')).toBe('/old/');
  expect(await f.db.prepare('SELECT id FROM audit_events').first('id')).toBe(42);
 });
});
