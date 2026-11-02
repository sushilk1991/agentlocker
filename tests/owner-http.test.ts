import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import { database } from './helpers';

let f: Awaited<ReturnType<typeof database>>;
const key = () => crypto.randomUUID();
const request = (route: string, method = 'GET', body?: unknown, headers: Record<string,string> = {}) =>
 f.runtime.dispatchFetch('https://locker.example.com/api/v1/owner/' + route, {method,
  headers: {authorization: 'Bearer ' + f.env.OWNER_TOKEN, ...(method==='GET'?{}:{'idempotency-key':key()}), ...(body === undefined ? {} : {'content-type':'application/json'}), ...headers},
  body: body === undefined ? undefined : JSON.stringify(body)});

describe('owner routes in the bundled Worker', () => {
 beforeAll(async () => { f = await database(true, true); await f.db.prepare('DELETE FROM settings').run(); });
 afterAll(async () => { await f?.runtime.dispose(); });
 it('runs the Worker before static assets so they cannot bypass HTTPS redirects', () => {
  const {rawConfig} = experimental_readRawConfig({config: 'wrangler.jsonc'});
  expect(rawConfig.assets?.run_worker_first).toBe(true);
 });
 it('redirects public HTTP before page, asset, health, API, and MCP handling and preserves the URL', async () => {
  const page = await f.runtime.dispatchFetch('https://locker.example.com/');
  const script = (await page.text()).match(/src="([^"]+\.js)"/)![1];
  for (const path of ['/', '/approvals', script, '/healthz', '/api/v1/owner/session', '/mcp', '/missing%20path%2Ffile']) {
   for (const method of ['GET', 'HEAD', 'POST']) {
    const url = 'http://locker.example.com' + path + '?path=%2Fwork%2Fa%20b&tag=one+two&tag=three&empty=';
    const response = await f.runtime.dispatchFetch(url, {method, redirect: 'manual'});
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(url.replace('http:', 'https:'));
    expect(await response.text()).toBe('');
   }
  }
  for (const host of ['localhost.example.com', 'notlocalhost', '127.0.0.2', '[::2]', 'locker.example.com:8080']) {
   const response = await f.runtime.dispatchFetch(`http://${host}/healthz`, {redirect: 'manual'});
   expect(response.status).toBe(308);
   expect(response.headers.get('location')).toBe(`https://${host}/healthz`);
  }
 });
 it('keeps local HTTP health requests available without redirecting', async () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'app.localhost', 'nested.app.localhost', 'LOCALHOST']) {
   const response = await f.runtime.dispatchFetch(`http://${host}:8787/healthz?local=1`, {redirect: 'manual'});
   expect(response.status).toBe(200);
   expect(response.headers.get('location')).toBeNull();
   expect(await response.text()).toBe('ok');
  }
 });
 it('serves public sign-in assets without private state and uses authenticated, atomic setup', async () => {
  const page = await f.runtime.dispatchFetch('https://locker.example.com/');
  expect(page.status).toBe(200); expect(await page.text()).toContain('Agent Locker');
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  for(const path of ['/','/approvals','/agents','/files','/secrets','/policy','/audit','/settings']) {
   const asset=await f.runtime.dispatchFetch('https://locker.example.com'+path);const content=await asset.text();
   expect(content).not.toContain(f.env.OWNER_TOKEN);expect(content).not.toContain(f.env.LOCKER_ENCRYPTION_KEY);
   expect(asset.headers.get('cache-control')).toBe('no-store');expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
  }
  expect((await request('session', 'GET', undefined, {authorization:''})).status).toBe(401);
  const session = await request('session'); expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({setup_complete:false, public_origin:f.env.PUBLIC_ORIGIN});
  expect((await request('agents')).status).toBe(503);
  const id = key(), input = {approval_ttl:900000, quota_bytes:1073741824, retention_ms:604800000};
  const results = await Promise.all([request('setup','POST',input,{'idempotency-key':id}), request('setup','POST',input,{'idempotency-key':id})]);
  expect(results.map(r=>r.status)).toEqual([200,200]);
  expect((await f.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE operation='owner.setup'").first<any>()).n).toBe(1);
  expect((await request('setup','POST',input)).status).toBe(409);
  expect((await request('setup','POST',{...input,approval_ttl:60000},{'idempotency-key':id})).status).toBe(409);
  expect(await (await request('session')).json()).toMatchObject({setup_complete:true});
 });
 it('keeps SPA fallback away from Worker routes and secures hashed assets', async () => {
  const page = await f.runtime.dispatchFetch('https://locker.example.com/approvals');
  const html = await page.text();
  expect(html).toContain('name="csp-nonce"');
  expect(page.headers.get('content-security-policy')).not.toContain('unsafe-inline');
  expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
  const script = html.match(/src="([^"]+\.js)"/)!;
  const asset = await f.runtime.dispatchFetch('https://locker.example.com' + script[1]);
  expect(asset.status).toBe(200); expect(asset.headers.get('content-type')).toContain('javascript');
  expect(asset.headers.get('x-content-type-options')).toBe('nosniff'); expect(asset.headers.get('cache-control')).toBe('no-store');
  expect((await f.runtime.dispatchFetch('https://other.example.com/approvals')).status).toBe(403);
  expect((await f.runtime.dispatchFetch('https://locker.example.com/approvals',{method:'POST'})).status).toBe(405);
  expect((await f.runtime.dispatchFetch('https://locker.example.com/approvals',{method:'HEAD'})).status).toBe(200);
  for(const path of ['/api/v1/owner/session', '/api/v1/missing', '/mcp', '/missing', '/legacy', '/app.js', '/style.css']) {
   const response = await f.runtime.dispatchFetch('https://locker.example.com'+path,{headers:{accept:'text/html'}});
   expect(response.status).toBeGreaterThanOrEqual(400); expect(response.headers.get('content-type')).not.toContain('text/html');
  }
  expect(await (await f.runtime.dispatchFetch('https://locker.example.com/healthz',{headers:{accept:'text/html'}})).text()).toBe('ok');
 });
 it('creates disabled agents, returns token values once, and exposes no token hashes', async () => {
  const made = await request('agents','POST',{name:'Codex <script>',description:'Coding tasks'});
  expect(made.status).toBe(201); const a = await made.json<any>(); expect(a.status).toBe('disabled');
  const issued = await request(`agents/${a.id}/tokens`,'POST',{label:'Fix #42',lifetime_ms:60000});
  expect(issued.status).toBe(201); const t = await issued.json<any>(); expect(t.token).toMatch(/^al_[a-f0-9]{64}$/);
  expect(issued.headers.get('cache-control')).toBe('no-store');
  expect((await request(`agents/${a.id}/tokens`,'POST',{label:'too long',lifetime_ms:2592000001})).status).toBe(400);
  const list = await (await request('agents')).json<any>();
  expect(list.agents.find((v:any)=>v.id===a.id).tokens[0]).toMatchObject({id:t.id,label:'Fix #42'});
  expect(JSON.stringify(list)).not.toContain(t.token); expect(JSON.stringify(list)).not.toContain('token_hash');
  const grants = {expected_version:1,folders:[{prefix:'/work/',read:true,write:true,delete:false}],secrets:[]};
  expect((await request(`agents/${a.id}/grants`,'PUT',grants)).status).toBe(200);
  expect((await request(`agents/${a.id}/grants`,'PUT',grants)).status).toBe(409);
  expect(await (await request(`agents/${a.id}/grants`)).json()).toMatchObject({version:2,folders:[{prefix:'/work/'}]});
  expect((await request(`agents/${a.id}`,'PATCH',{name:'Coding agent',status:'enabled'})).status).toBe(200);
  expect((await request(`agents/${a.id}/tokens/${t.id}`,'DELETE')).status).toBe(200);
  expect((await request(`agents/${a.id}`,'PATCH',{status:'revoked'})).status).toBe(200);
  expect((await request(`agents/${a.id}`,'PATCH',{status:'enabled'})).status).toBe(409);
 });
 it('rejects agent credentials, unexpected origins, URL tokens, and unknown inputs', async () => {
  for(const route of ['session','agents','overview','audit','audit/export']) {
   expect((await request(route,'GET',undefined,{authorization:'Bearer al_'+'a'.repeat(64)})).status).toBe(401);
   expect((await request(route,'GET',undefined,{origin:'https://evil.example'})).status).toBe(403);
  }
  expect((await request('session?token=secret')).status).toBe(400);
  expect((await request('agents','POST',{name:'Bad',role:'owner'})).status).toBe(400);
  expect((await request('agents','POST',{name:'Coding agent'})).status).toBe(409);
  expect((await f.runtime.dispatchFetch('https://evil.example/')).status).toBe(403);
 });
 it('filters and pages audit data, exports safely, and returns combined activity deltas', async () => {
  const id=key();
  await f.db.prepare(`INSERT INTO audit_events(request_id,actor_kind,actor_name,operation,target,decision,result,reason_code) VALUES(?,'owner','=HYPERLINK("bad")','file.read','/work/a','allow','read','read'),(?,'owner','Owner','file.read','/work/another','allow','read','read')`).bind(id,id).run();
  const first=await (await request('audit?request_id='+id+'&limit=1')).json<any>();
  expect(first.events).toHaveLength(1); expect(first.next_cursor).toBeTruthy();
  const next=await (await request(`audit?request_id=${id}&limit=1&cursor=${first.next_cursor}`)).json<any>();
  expect(next.events).toHaveLength(1); expect(next.events[0].id).toBeLessThan(first.events[0].id);
  expect((await (await request(`audit?request_id=${id}&path=${encodeURIComponent('/work/a')}`)).json<any>()).events).toHaveLength(1);
  expect((await (await request('audit?prefix='+encodeURIComponent('/work/a/'))).json<any>()).events).toHaveLength(0);
  const csv=await request(`audit/export?request_id=${id}&format=csv`); expect(csv.headers.get('content-type')).toContain('text/csv');
  expect(await csv.text()).toContain("\"'=HYPERLINK(\"\"bad\"\")\"");
  const jsonl=await request(`audit/export?request_id=${id}&format=jsonl`); expect((await jsonl.text()).trim().split('\n').map(line=>JSON.parse(line))).toHaveLength(2);
  const overview=await (await request('overview')).json<any>();
  expect(overview).toMatchObject({pending_count:0,storage:{quota_bytes:1073741824},audit_storage:{last_event_id:expect.any(Number)},event_cursor:expect.any(Number),pending_version:expect.any(String)});
  const delta=await (await request('overview?cursor='+overview.event_cursor)).json<any>();
  expect(delta.events.every((v:any)=>v.id>overview.event_cursor)).toBe(true);
  for(const query of ['limit=101','cursor=bad','from=oops','nope=1','path=%2Fwork%2F','prefix=%2Fwork']) expect((await request('audit?'+query)).status).toBe(400);
  expect((await request('audit','DELETE')).status).toBe(404);
 });
});


describe('first-run transaction failure',()=>{
 it('rolls back initialization and the retry receipt if its audit insert fails',async()=>{
  const fixture=await database(true,true);
  try {
   await fixture.db.prepare('DELETE FROM settings').run();
   await fixture.db.prepare("CREATE TRIGGER setup_audit_failure BEFORE INSERT ON audit_events WHEN NEW.operation='owner.setup' BEGIN SELECT RAISE(ABORT,'injected'); END").run();
   const id=key(),input={approval_ttl:900000,quota_bytes:1073741824,retention_ms:604800000};
   const send=()=>fixture.runtime.dispatchFetch('https://locker.example.com/api/v1/owner/setup',{method:'POST',headers:{authorization:'Bearer '+fixture.env.OWNER_TOKEN,'content-type':'application/json','idempotency-key':id},body:JSON.stringify(input)});
   expect((await send()).status).toBe(503);
   expect(await fixture.db.prepare('SELECT id FROM settings').first()).toBeNull();
   expect(await fixture.db.prepare("SELECT identity FROM idempotency_keys WHERE identity='owner.setup'").first()).toBeNull();
   await fixture.db.prepare('DROP TRIGGER setup_audit_failure').run();expect((await send()).status).toBe(200);
  }finally{await fixture.runtime.dispose();}
 });
});
