import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate } from '../src/auth';
import { createAgent, issueToken, replaceGrants, setAgentStatus } from '../src/agents';
import { sha } from '../src/security';
import { bearer, database } from './helpers';

let f: Awaited<ReturnType<typeof database>>, token: string, otherToken: string;
const key = () => crypto.randomUUID();
function request(path: string, method = 'GET', body?: BodyInit, headers: Record<string,string> = {}, owner = false) {
 return f.runtime.dispatchFetch(`https://locker.example.com/api/v1/${owner ? 'owner/' : ''}${path}`, {
  method, body: body as any, headers: {authorization: `Bearer ${owner ? f.env.OWNER_TOKEN : token}`, ...headers},
 });
}
async function write(path: string, body: BodyInit = 'hello', headers: Record<string,string> = {}) {
 return request(`files/content?path=${encodeURIComponent(path)}`, 'PUT', body,
  {'content-type': 'text/plain', 'idempotency-key': key(), 'if-none-match': '*', ...headers});
}
async function addAgent(prefix: string) {
 const owner = f.context(), a = await createAgent(owner, key()), t = await issueToken(owner, a.id, 'http');
 await replaceGrants(owner, a.id, 1, [{prefix, read: true, write: true, delete: true}], []);
 await setAgentStatus(owner, a.id, 'enabled');
 return t.token;
}

describe('file HTTP API in a bundled Worker with real local D1 and R2', () => {
 beforeAll(async () => { f = await database(true, true); token = await addAgent('/mine/'); otherToken = await addAgent('/private/'); });
 afterAll(async () => { await f?.runtime.dispose(); });

 it('writes, lists, returns metadata, and downloads lossless bytes with safe headers', async () => {
  const data = Uint8Array.from([0,255,128,1,10]), response = await write('/mine/binary', data);
  expect(response.status).toBe(200);
  const created = await response.json<any>();
  expect(created).toMatchObject({status: 'succeeded', request_id: expect.any(String), result_revision: expect.any(String)});
  const meta = await request('files/metadata?path=/mine/binary');
  expect(await meta.json()).toMatchObject({revision: created.result_revision, length: data.length, hash: await sha(data), author_kind: 'agent'});
  const content = await request('files/content?path=/mine/binary');
  expect(new Uint8Array(await content.arrayBuffer())).toEqual(data);
  expect(content.headers.get('etag')).toBe(`"${created.result_revision}"`);
  expect(content.headers.get('content-type')).toBe('application/octet-stream');
  expect(content.headers.get('content-disposition')).toContain('attachment');
  expect(content.headers.get('cache-control')).toBe('no-store');
  expect(content.headers.get('x-content-type-options')).toBe('nosniff');
  expect(content.headers.get('x-content-sha256')).toBe(await sha(data));
  const list = await request('files?prefix=/mine/');
  expect((await list.json<any>()).files).toContainEqual(expect.objectContaining({path: '/mine/binary'}));
 });

 it('transfers a 10 MiB file and rejects a byte above the limit', async () => {
  const data = new Uint8Array(10 * 1024 * 1024); data[0] = 255; data[data.length - 1] = 127;
  const response = await write('/mine/large', data);
  expect(response.status).toBe(200);
  const content = await request('files/content?path=/mine/large');
  const downloaded = new Uint8Array(await content.arrayBuffer());
  expect(downloaded.length).toBe(data.length); expect(await sha(downloaded)).toBe(await sha(data));
  const tooLarge = await write('/mine/over-limit', new Uint8Array(data.length + 1));
  expect(tooLarge.status).toBe(413); expect((await tooLarge.json<any>()).error.code).toBe('too_large');
 });

 it('never serves uploaded HTML as active content', async () => {
  expect((await write('/mine/html', '<script>alert(1)</script>', {'content-type': 'text/html'})).status).toBe(200);
  const content = await request('files/content?path=/mine/html');
  expect(content.headers.get('content-type')).toBe('application/octet-stream');
  expect(content.headers.get('content-disposition')).toContain('attachment');
 });

 it('requires an exact create/replace precondition and idempotency key', async () => {
  for (const headers of [
   {'idempotency-key': key()}, {'idempotency-key': key(), 'if-match': '*'},
   {'if-none-match': '*'}, {'idempotency-key': key(), 'if-none-match': '*', 'if-match': '"x"'},
  ]) {
   const response = await request('files/content?path=/mine/preconditions', 'PUT', 'hello', {'content-type': 'text/plain', ...headers} as Record<string,string>);
   expect(response.status).toBe(400);
  }
  const initial = await write('/mine/conditions'); expect(initial.status).toBe(200);
  expect((await write('/mine/conditions')).status).toBe(409);
  expect((await write('/mine/wrong-type', 'hello', {'content-type': ''})).status).toBe(400);
 });

 it('returns pending for delete and replacement and polls without executing', async () => {
  const first = await (await write('/mine/pending')).json<any>(), revision = first.result_revision;
  const deletion = await request('files/content?path=/mine/pending', 'DELETE', undefined, {'if-match': `"${revision}"`, 'idempotency-key': key()});
  expect(deletion.status).toBe(202); expect(deletion.headers.get('retry-after')).toBe('2');
  const pending = await deletion.json<any>();
  expect(pending).toMatchObject({status: 'pending', approval_id: expect.any(String)});
  const status = await request(`actions/${pending.id}`); expect((await status.json<any>()).status).toBe('pending');
  const replacement = await request('files/content?path=/mine/pending', 'PUT', 'new', {
   'content-type': 'text/plain', 'if-match': `"${revision}"`, 'idempotency-key': key(),
  });
  expect(replacement.status).toBe(202);
  expect(await (await request('files/content?path=/mine/pending')).text()).toBe('hello');
 });

 it('filters parent listings and encrypts and authenticates pagination cursors', async () => {
  const privateWrite = await request('files/content?path=/private/hidden', 'PUT', 'hidden', {
   authorization: `Bearer ${otherToken}`, 'content-type': 'text/plain', 'if-none-match': '*', 'idempotency-key': key(),
  }); expect(privateWrite.status).toBe(200);
  const response = await request('files?prefix=/&limit=1'), body = await response.json<any>();
  expect(body.files).toHaveLength(1); expect(body.files[0].path.startsWith('/mine/')).toBe(true);
  expect(body.cursor).toBeTypeOf('string'); expect(atob(body.cursor)).not.toContain('/mine/');
  const next = await request(`files?prefix=/&limit=1&cursor=${encodeURIComponent(body.cursor)}`);
  expect(next.status).toBe(200); expect((await next.json<any>()).files[0].path).not.toBe(body.files[0].path);
  expect((await request(`files?prefix=/&limit=1&cursor=${encodeURIComponent(body.cursor.slice(0,-4) + 'aaaa')}`)).status).toBe(400);
  expect((await request(`files?prefix=/&limit=1&cursor=${encodeURIComponent(body.cursor)}`, 'GET', undefined, {authorization: `Bearer ${otherToken}`})).status).toBe(400);
  expect((await request(`files?prefix=/mine/&cursor=${encodeURIComponent(body.cursor)}`)).status).toBe(400);
  expect(JSON.stringify(await (await request('files?prefix=/')).json())).not.toContain('/private/');
 });

 it('uses the same error for missing and ungranted files and blocks owner history routes', async () => {
  const responses = await Promise.all(['/private/hidden','/private/unknown'].map(p => request(`files/metadata?path=${p}`)));
  const errors = await Promise.all(responses.map(async r => {expect(r.status).toBe(404); return (await r.json<any>()).error;}));
  expect(errors[0]).toEqual(errors[1]);
  const response = await request('files/revisions?path=/mine/binary', 'GET', undefined, {authorization: `Bearer ${token}`}, true);
  expect(response.status).toBe(401);
 });

 it.each(['0','101','NaN','1.5'])('rejects invalid list limit %s', async limit => {
  expect((await request(`files?limit=${limit}`)).status).toBe(400);
 });

 it.each(['/mine/../private', '/mine/%2e%2e/file', '/mine//file', '/mine/file/'])('rejects ambiguous logical path %s', async p => {
  expect((await request(`files/metadata?path=${encodeURIComponent(p)}`)).status).toBe(400);
 });

 it('requires explicit owner confirmation for replacements and deletes and permits owner restore', async () => {
  const initial = await (await write('/mine/owner')).json<any>(), revision = initial.result_revision;
  const headers = {'content-type': 'text/plain', 'idempotency-key': key(), 'if-match': `"${revision}"`};
  expect((await request('files/content?path=/mine/owner', 'PUT', 'replacement', headers, true)).status).toBe(409);
  const replaced = await request('files/content?path=/mine/owner', 'PUT', 'replacement', {...headers, 'x-confirm-content-sha256': await sha('replacement')}, true);
  expect(replaced.status).toBe(200); const latest = (await replaced.json<any>()).result_revision;
  expect((await request('files/content?path=/mine/owner', 'DELETE', undefined, {'if-match': `"${latest}"`, 'idempotency-key': key()}, true)).status).toBe(409);
  const deletion = await request('files/content?path=/mine/owner', 'DELETE', undefined, {'if-match': `"${latest}"`, 'x-confirm-revision': latest, 'idempotency-key': key()}, true);
  expect(deletion.status).toBe(200);
  expect((await request('files/content?path=/mine/owner')).status).toBe(404);
  const history = await request('files/revisions?path=/mine/owner', 'GET', undefined, {}, true);
  const versions = (await history.json<any>()).revisions;
  expect(versions).toHaveLength(2); expect(versions[0].restore_deadline).toBeGreaterThan(Date.now() + 6 * 86400000);
  const original = await request(`files/revisions/${revision}/content`, 'GET', undefined, {}, true);
  expect(await original.text()).toBe('hello');
  const restored = await request('files/restore', 'POST', JSON.stringify({source_revision: revision, expected_revision: latest}), {
   'content-type': 'application/json', 'idempotency-key': key(),
  }, true);
  expect(restored.status).toBe(200); expect((await restored.json<any>()).revision).not.toBe(revision);
  expect(await (await request('files/content?path=/mine/owner')).text()).toBe('hello');
 });

 it('does not release read or metadata bytes under an owner review rule', async () => {
  await write('/mine/review');
  await f.db.prepare("INSERT INTO approval_rules(id,operation,prefix,version,created_at) VALUES('read-rule','file.read','/mine/review/',1,0)").run();
  // Use an exact parent grant/rule prefix for this target.
  await f.db.prepare("UPDATE approval_rules SET prefix='/mine/' WHERE id='read-rule'").run();
  const k = key();
  for (const endpoint of ['content','metadata']) {
   const response = await request(`files/${endpoint}?path=/mine/review`, 'GET', undefined, {'idempotency-key': endpoint + k});
   expect(response.status).toBe(202); expect((await response.json<any>()).status).toBe('pending');
  }
  expect((await request('files/content?path=/mine/review')).status).toBe(400);
  const first = await (await request('files/content?path=/mine/review', 'GET', undefined, {'idempotency-key': k})).json<any>();
  const retry = await (await request('files/content?path=/mine/review', 'GET', undefined, {'idempotency-key': k})).json<any>();
  expect(retry.id).toBe(first.id);
  await f.db.prepare("DELETE FROM approval_rules WHERE id='read-rule'").run();
 });

 it('gates new writes and parent listings when owner rules require review', async () => {
  await f.db.prepare("INSERT INTO approval_rules(id,operation,prefix,version,created_at) VALUES('new-write-rule','file.write','/mine/review-new/',1,0),('list-rule','files.list','/mine/review-new/',1,0)").run();
  try {
   const created = await write('/mine/review-new/file');
   expect(created.status).toBe(202); expect((await created.json<any>()).status).toBe('pending');
   expect((await request('files/content?path=/mine/review-new/file')).status).toBe(404);
   const parent = await request('files?prefix=/', 'GET', undefined, {'idempotency-key': key()});
   expect(parent.status).toBe(202); expect((await parent.json<any>()).status).toBe('pending');
   const unrelated = await request('files?prefix=/private/');
   expect(unrelated.status).toBe(200); expect((await unrelated.json<any>()).files).toEqual([]);
  } finally { await f.db.prepare("DELETE FROM approval_rules WHERE id IN('new-write-rule','list-rule')").run(); }
 });

 it('records attributed success, validation and denial events without content or credentials', async () => {
  const actor = await authenticate(f.context(), bearer(token), false);
  const {results} = await f.db.prepare('SELECT * FROM audit_events WHERE agent_id=?').bind(actor.agentId!).all();
  expect(results).toEqual(expect.arrayContaining([
   expect.objectContaining({operation: 'file.write', result: 'written', token_id: actor.tokenId}),
   expect.objectContaining({operation: 'file.metadata', decision: 'deny', result: 'not_found_or_not_allowed'}),
   expect.objectContaining({decision: 'deny', result: 'invalid_path'}),
  ]));
  const text = JSON.stringify(results);
  for (const secret of [token, otherToken, f.env.OWNER_TOKEN, 'replacement', '<script>']) expect(text).not.toContain(secret);
 });
});
