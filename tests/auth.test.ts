import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate } from '../src/auth';
import { createAgent, issueToken, revokeToken, setAgentStatus } from '../src/agents';
import { sha } from '../src/security';
import { bearer, database } from './helpers';

describe('bearer authentication', () => {
 let f: Awaited<ReturnType<typeof database>>;
 beforeAll(async () => { f = await database(); });
 afterAll(async () => { await f?.runtime.dispose(); });

 async function enabled() {
  const owner = f.context();
  const a = await createAgent(owner, crypto.randomUUID());
  const t = await issueToken(owner, a.id, 'coding task');
  await setAgentStatus(owner, a.id, 'enabled');
  return {a, t, owner};
 }

 it('authenticates the owner and rejects a different token', async () => {
  await expect(authenticate(f.context(), bearer(f.env.OWNER_TOKEN), true)).resolves.toEqual({kind: 'owner', name: 'Owner'});
  await expect(authenticate(f.context(), bearer(f.env.OWNER_TOKEN + 'x'), true)).rejects.toMatchObject({code: 'unauthorized', status: 401});
 });

 it('issues random credentials, stores only hashes, and resolves the credential identity', async () => {
  const {a, t, owner} = await enabled();
  const second = await issueToken(owner, a.id, 'second task');
  expect(t.token).toMatch(/^al_[0-9a-f]{64}$/);
  expect(t.token).not.toBe(second.token);
  expect(t.expires_at - t.created_at).toBe(86400000);
  const rows = await f.db.prepare('SELECT * FROM agent_tokens WHERE agent_id=?').bind(a.id).all();
  expect(JSON.stringify(rows)).not.toContain(t.token);
  expect(rows.results[0]).toMatchObject({token_hash: await sha(t.token), prefix: t.token.slice(0, 11)});
  expect(t).not.toHaveProperty('token_hash');
  await expect(authenticate(f.context(), bearer(t.token), false)).resolves.toMatchObject({kind: 'agent', agentId: a.id, tokenId: t.id, name: a.name});
 });

 it('keeps owner and agent credential types separate', async () => {
  const {t} = await enabled();
  await expect(authenticate(f.context(), bearer(t.token), true)).rejects.toMatchObject({code: 'unauthorized'});
  await expect(authenticate(f.context(), bearer(f.env.OWNER_TOKEN), false)).rejects.toMatchObject({code: 'unauthorized'});
  await expect(authenticate(f.context(), bearer(await sha(t.token)), false)).rejects.toMatchObject({code: 'unauthorized'});
  await expect(authenticate(f.context(), bearer('al_' + await sha(t.token)), false)).rejects.toMatchObject({code: 'unauthorized'});
 });

 it.each(['', 'Basic abc', 'Bearer', 'Bearer al_invalid', 'Bearer a b'])('rejects malformed authorization %j', async authorization => {
  const request = new Request(f.env.PUBLIC_ORIGIN, {headers: {authorization}});
  await expect(authenticate(f.context(), request, false)).rejects.toMatchObject({code: 'unauthorized'});
 });

 it('does not use URL credentials, names, or claimed roles', async () => {
  const {t} = await enabled();
  const request = new Request(`${f.env.PUBLIC_ORIGIN}/?token=${t.token}&role=owner&agent_id=other`);
  await expect(authenticate(f.context(), request, true)).rejects.toMatchObject({code: 'unauthorized'});
 });

 it('allows bearer scheme case and checks request origin and host', async () => {
  const request = new Request(f.env.PUBLIC_ORIGIN, {headers: {authorization: `bearer ${f.env.OWNER_TOKEN}`}});
  await expect(authenticate(f.context(), request, true)).resolves.toHaveProperty('kind', 'owner');
  await expect(authenticate(f.context(), bearer(f.env.OWNER_TOKEN, f.env.PUBLIC_ORIGIN, f.env.PUBLIC_ORIGIN), true)).resolves.toHaveProperty('kind', 'owner');
  for (const origin of ['https://attacker.example', 'null']) {
   await expect(authenticate(f.context(), bearer(f.env.OWNER_TOKEN, f.env.PUBLIC_ORIGIN, origin), true)).rejects.toMatchObject({code: 'invalid_origin'});
  }
  await expect(authenticate(f.context(), bearer(f.env.OWNER_TOKEN, 'https://attacker.example'), true)).rejects.toMatchObject({code: 'invalid_origin'});
 });

 it('checks disabled and revoked agents without caching', async () => {
  const owner = f.context(), a = await createAgent(owner, 'disabled-agent');
  const t = await issueToken(owner, a.id, 'task');
  await expect(authenticate(owner, bearer(t.token), false)).rejects.toMatchObject({code: 'unauthorized'});
  await setAgentStatus(owner, a.id, 'enabled');
  await expect(authenticate(owner, bearer(t.token), false)).resolves.toHaveProperty('agentId', a.id);
  await setAgentStatus(owner, a.id, 'revoked');
  await expect(authenticate(owner, bearer(t.token), false)).rejects.toMatchObject({code: 'unauthorized'});
  await expect(issueToken(owner, a.id, 'new')).rejects.toMatchObject({code: 'agent_revoked'});
 });

 it('rejects expired and individually revoked tokens but preserves other tokens', async () => {
  const {a, t, owner} = await enabled();
  const second = await issueToken(owner, a.id, 'second task');
  await revokeToken(owner, a.id, t.id);
  await expect(authenticate(owner, bearer(t.token), false)).rejects.toMatchObject({code: 'unauthorized'});
  await expect(authenticate(owner, bearer(second.token), false)).resolves.toHaveProperty('agentId', a.id);
  // Insert an expired fixture. Database time, rather than a fake JS clock, checks it.
  const expired = 'al_' + 'c'.repeat(64);
  await f.db.prepare(`INSERT INTO agent_tokens(id,agent_id,token_hash,prefix,label,created_at,expires_at) VALUES('expired',?,?, 'al_cccccccc','expired',0,1)`)
   .bind(a.id, await sha(expired)).run();
  await expect(authenticate(owner, bearer(expired), false)).rejects.toMatchObject({code: 'unauthorized'});
 });

 it.each([0, -1, 1.5, 30 * 86400000 + 1, Number.NaN])('rejects invalid token lifetimes: %s', async lifetime => {
  const a = await createAgent(f.context(), crypto.randomUUID());
  await expect(issueToken(f.context(), a.id, 'task', lifetime)).rejects.toMatchObject({code: 'invalid_token_lifetime'});
 });

 it('supports the maximum lifetime and short task lifetimes', async () => {
  const a = await createAgent(f.context(), crypto.randomUUID());
  const max = await issueToken(f.context(), a.id, 'month', 30 * 86400000);
  const short = await issueToken(f.context(), a.id, 'short', 60000);
  expect(max.expires_at - max.created_at).toBe(30 * 86400000);
  expect(short.expires_at - short.created_at).toBe(60000);
 });
});
