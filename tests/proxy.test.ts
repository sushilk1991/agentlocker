import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { actionResult, executeAction, getAction, reviewApproval, sweepActions } from '../src/approvals';
import { issueToken } from '../src/agents';
import { authenticate } from '../src/auth';
import { submitProxy } from '../src/proxy';
import { bytes, canonical, injection, open, proxyInput, redact, sha, unbase64 } from '../src/security';
import { disableSecret, gateSecretList, listSecrets, saveSecret } from '../src/secrets';
import { LIMITS } from '../src/types';
import { bearer, database } from './helpers';
import { approve, CANARY, key, requestFor, setupAgent } from './approval-helpers';

let f:Awaited<ReturnType<typeof database>>;
const row=(id:string)=>f.db.prepare('SELECT * FROM actions WHERE id=?').bind(id).first<any>();
describe('encrypted secrets and approval-gated outbound proxy',()=>{
 beforeAll(async()=>{f=await database();});afterAll(async()=>{await f?.runtime.dispose();});
 it('stores authenticated ciphertext and exposes metadata only, scoped to current grants',async()=>{
  const {c,secret}=await setupAgent(f),s=await f.db.prepare('SELECT * FROM secrets WHERE id=?').bind(secret!.id).first<any>();
  expect(JSON.stringify(s)).not.toContain(CANARY);
  expect(await open(f.env,'secret.value',s.id,s.value_version,s.encrypted_value,s.nonce,s.key_version)).toBe(CANARY);
  for(const [type,id,version] of [['action.input',s.id,s.value_version],['secret.value','other',s.value_version],['secret.value',s.id,9]] as const)
   await expect(open(f.env,type,id,version,s.encrypted_value,s.nonce,s.key_version)).rejects.toHaveProperty('code','encrypted_record_unavailable');
  const listed=await listSecrets(c);expect(listed.secrets).toHaveLength(1);expect(listed.secrets[0].name).toBe(secret!.name);
  const metadata=JSON.stringify(listed);for(const sensitive of [CANARY,s.encrypted_value,s.nonce,'token_hash','encrypted_value'])expect(metadata).not.toContain(sensitive);
  const other=await setupAgent(f,false);expect((await listSecrets(other.c)).secrets).toEqual([]);
 });
 it('encrypts queued requests and every method including GET and HEAD stays pending',async()=>{
  const {c,secret}=await setupAgent(f);
  for(const method of ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']) {
   const a=await submitProxy(c,requestFor(secret,{method,body_text:['GET','HEAD'].includes(method)?undefined:'private-request-body'}),key());
   expect(a.status).toBe('pending');expect(a.approval_id).toBeTypeOf('string');
   const stored=await row(a.id);expect(JSON.stringify(stored)).not.toContain('private-request-body');
   expect((await getAction(c,a.id)).status).toBe('pending');
   expect(await f.db.prepare('SELECT count(*) FROM execution_attempts WHERE action_id=?').bind(a.id).first('count(*)')).toBe(0);
  }
 });
 it('deduplicates concurrent submissions using decoded bytes and preserves query order and header values',async()=>{
  const {c,secret}=await setupAgent(f),k=key(),request=requestFor(secret,{body_text:undefined,body_base64:'aA==',headers:{'X-B':'two  spaces','X-A':'one'}});
  const jobs=await Promise.all(Array.from({length:3},()=>submitProxy(c,request,k)));
  expect(new Set(jobs.map(a=>a.id)).size).toBe(1);
  expect((await submitProxy(c,{...request,body_base64:'aB==',headers:{'x-a':'one','x-b':'two  spaces'}},k)).id).toBe(jobs[0].id);
  const review=await reviewApproval(f.context(),jobs[0].approval_id);
  expect(review.input.request.headers['x-b']).toBe('two  spaces');
  for(const change of [{body_base64:'aQ=='},{method:'PATCH'},{url:'https://api.example.com/v1/send?b=2&a=1'},{headers:{'x-b':'two spaces','x-a':'one'}}])
   await expect(submitProxy(c,{...request,...change},k)).rejects.toHaveProperty('code','idempotency_conflict');
  const next=await submitProxy(c,{...request,url:'https://api.example.com/v1/send?b=2&a=1'},key());
  expect((await reviewApproval(f.context(),next.approval_id)).digest).not.toBe(review.digest);
 });
 it('injects only at the saved header, never follows redirects, and redacts echoes across body chunks',async()=>{
  const {c,secret}=await setupAgent(f),a=await submitProxy(c,requestFor(secret),key());await approve(f,a);
  const logs=vi.spyOn(console,'log'),errors=vi.spyOn(console,'error');
  const fetcher=vi.fn(async(url:any,init:any)=>{
   expect(url).toBe('https://api.example.com/v1/send?a=1&b=2');expect(init.redirect).toBe('manual');
   expect(new Headers(init.headers).get('authorization')).toBe('Bearer '+CANARY);
   expect(new Headers(init.headers).get('cookie')).toBeNull();expect(new TextDecoder().decode(init.body)).toBe('hello');
   const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes('prefix '+CANARY.slice(0,9)));controller.enqueue(bytes(CANARY.slice(9)+' suffix'));controller.close();}});
   return new Response(stream,{status:302,headers:{'location':'https://api.example.com/redirect','set-cookie':'bad='+CANARY,'set-cookie2':'legacy-cookie','authorization':'Bearer '+CANARY,'www-authenticate':CANARY,'x-echo':CANARY,'content-type':'text/plain',connection:'keep-alive, X-Hop-Token','x-hop-token':'connection-only'}});
  });
  try {
   expect(await executeAction(f.context(),a.id,fetcher)).toMatchObject({status:'succeeded',result:{upstream_status:302}});
   const result=await (await actionResult(c,a.id)).json<any>();
   expect(new TextDecoder().decode(unbase64(result.body_base64))).toBe('prefix [REDACTED] suffix');
   expect(result.headers).toMatchObject({'x-echo':'[REDACTED]',location:'https://api.example.com/redirect'});
   expect(result.headers).not.toHaveProperty('authorization');expect(result.headers).not.toHaveProperty('set-cookie');expect(result.headers).not.toHaveProperty('www-authenticate');
   expect(result.headers).not.toHaveProperty('set-cookie2');expect(result.headers).not.toHaveProperty('x-hop-token');expect(result.headers).not.toHaveProperty('connection');
   expect(JSON.stringify(result)).not.toContain(CANARY);expect(fetcher).toHaveBeenCalledTimes(1);
   const stored=await row(a.id);expect(stored.result_cipher).toBeTypeOf('string');expect(JSON.stringify(stored)).not.toContain(CANARY);
   const audit=await f.db.prepare('SELECT * FROM audit_events').all();
   for(const capture of [result,stored,audit,logs.mock.calls,errors.mock.calls]) {
    const text=JSON.stringify(capture);for(const value of [CANARY,f.env.OWNER_TOKEN,c.env.LOCKER_ENCRYPTION_KEY])expect(text).not.toContain(value);
   }
  } finally {logs.mockRestore();errors.mockRestore();}
 });
 it('supports an owner-selected API-key header and removes it from responses',async()=>{
  const {c,secret}=await setupAgent(f);
  const s=await saveSecret(f.context(),{name:secret!.name,hosts:['api.example.com'],injection_header:'X-Api-Key',scheme:'plain'},secret!.id,secret!.version);
  const a=await submitProxy(c,requestFor(s),key());await approve(f,a);
  const fetcher=vi.fn(async(_url:any,init:any)=>{expect(new Headers(init.headers).get('x-api-key')).toBe(CANARY);expect(new Headers(init.headers).get('authorization')).toBeNull();return new Response('ok',{headers:{'x-api-key':CANARY}});});
  await executeAction(f.context(),a.id,fetcher);expect((await (await actionResult(c,a.id)).json<any>()).headers).not.toHaveProperty('x-api-key');
 });
 it('records observed upstream errors separately from the execution state',async()=>{
  const {c,secret}=await setupAgent(f),a=await submitProxy(c,requestFor(secret),key());await approve(f,a);
  expect(await executeAction(f.context(),a.id,async()=>new Response('provider error',{status:503}))).toMatchObject({status:'succeeded',result:{upstream_status:503}});
  expect((await (await actionResult(c,a.id)).json<any>()).upstream_status).toBe(503);
 });
 it('returns unknown for fetch failure, interrupted bodies, and oversized responses, without a retry',async()=>{
  const {c,secret}=await setupAgent(f);
  for(const response of [()=>{throw new Error('upstream '+CANARY);},()=>new Response(new ReadableStream({start(ctrl){ctrl.error(new Error(CANARY));}})),()=>new Response(new Uint8Array(LIMITS.response+1))]) {
   const a=await submitProxy(c,requestFor(secret),key());await approve(f,a);const fetcher=vi.fn(async()=>response());
   expect((await executeAction(f.context(),a.id,fetcher)).status).toBe('unknown');
   expect((await executeAction(f.context(),a.id,fetcher)).status).toBe('unknown');expect(fetcher).toHaveBeenCalledTimes(1);
   expect(JSON.stringify(await getAction(c,a.id))).not.toContain(CANARY);
  }
 });
 it('fails before dispatch on key decryption failure and preserves the secret boundary',async()=>{
  const {c,secret}=await setupAgent(f),a=await submitProxy(c,requestFor(secret),key());await approve(f,a);
  await f.db.prepare("UPDATE secrets SET encrypted_value='broken' WHERE id=?").bind(secret!.id).run();
  const fetcher=vi.fn();expect((await executeAction(f.context(),a.id,fetcher)).status).toBe('failed');expect(fetcher).not.toHaveBeenCalled();
  expect(JSON.stringify(await getAction(c,a.id))).not.toContain(CANARY);
 });
 it('invalidates saved work after value, injection, host-policy changes or disabling the secret',async()=>{
  const {c,secret}=await setupAgent(f);let s=secret!;
  for(const change of [{value:'replacement-provider-key'},{hosts:['other.example.com']},{injection_header:'x-api-key',scheme:'plain'}]) {
   const a=await submitProxy(c,requestFor(s,{url:'https://'+s.hosts[0]+'/send'}),key());await approve(f,a);
   s=await saveSecret(f.context(),{name:s.name,hosts:s.hosts,injection_header:s.injection_header,scheme:s.scheme,...change} as any,s.id,s.version);
   expect((await executeAction(f.context(),a.id)).status).toBe('invalidated');
  }
  const a=await submitProxy(c,requestFor(s,{url:'https://'+s.hosts[0]+'/send'}),key());await disableSecret(f.context(),s.id,s.version);
  expect((await executeAction(f.context(),a.id)).status).toBe('invalidated');
  await expect(submitProxy(c,requestFor(s),key())).rejects.toHaveProperty('code','not_found_or_not_allowed');
 });
 it('blocks unlisted destinations and denied grants before queueing, concealing unknown names',async()=>{
  const {c,secret}=await setupAgent(f),before=await f.db.prepare('SELECT count(*) FROM actions').first('count(*)');
  for(const url of ['https://other.example.com','https://api.example.com.evil.com','https://sub.api.example.com','https://locker.example.com'])
   await expect(submitProxy(c,requestFor(secret,{url}),key())).rejects.toHaveProperty('code','not_found_or_not_allowed');
  const other=await setupAgent(f,false);
  for(const name of [secret!.name,'missing'])await expect(submitProxy(other.c,requestFor({name}),key())).rejects.toHaveProperty('code','not_found_or_not_allowed');
  expect(await f.db.prepare('SELECT count(*) FROM actions').first('count(*)')).toBe(before);
 });
 it('requires current grants for results, permits a new token for the same agent, and expires payloads after 24h',async()=>{
  const {c,secret,a}=await setupAgent(f),job=await submitProxy(c,requestFor(secret),key());await approve(f,job);await executeAction(f.context(),job.id,async()=>new Response('ok'));
  const t=await issueToken(f.context(),a.id,'new token'),newContext=f.context(await authenticate(f.context(),bearer(t.token),false));
  expect((await actionResult(newContext,job.id)).status).toBe(200);
  await f.db.prepare('UPDATE actions SET result_expires_at=1 WHERE id=?').bind(job.id).run();await sweepActions(f.context());
  await expect(actionResult(c,job.id)).rejects.toHaveProperty('code','result_expired');
  expect(await getAction(c,job.id)).toMatchObject({status:'succeeded',result_available:false,error_code:'result_expired'});
  expect(await row(job.id)).toMatchObject({input_cipher:null,result_cipher:null});
 });
 it('does not dispatch when the dispatch audit fails; a result audit failure becomes unknown',async()=>{
  const {c,secret}=await setupAgent(f);
  for(const operation of ['proxy.dispatch','proxy.result']) {
   const a=await submitProxy(c,requestFor(secret),key());await approve(f,a);
   await f.db.prepare(`CREATE TRIGGER fail_proxy BEFORE INSERT ON audit_events WHEN NEW.operation='${operation}' BEGIN SELECT RAISE(ABORT,'test_failure'); END`).run();
   const fetcher=vi.fn(async()=>new Response(CANARY));
   try {expect((await executeAction(f.context(),a.id,fetcher)).status).toBe(operation==='proxy.dispatch'?'failed':'unknown');}
   finally {await f.db.prepare('DROP TRIGGER fail_proxy').run();}
   expect(fetcher).toHaveBeenCalledTimes(operation==='proxy.dispatch'?0:1);
   expect(JSON.stringify(await row(a.id))).not.toContain(CANARY);
  }
 });
 it('keeps stored action inputs immutable after submission',async()=>{
  const {c,secret}=await setupAgent(f),a=await submitProxy(c,requestFor(secret),key());
  for(const field of ['input_cipher','input_nonce','key_version','digest','secret_version'])
   await expect(f.db.prepare(`UPDATE actions SET ${field}='tampered' WHERE id=?`).bind(a.id).run()).rejects.toThrow('immutable_action');
 });
 it('gates secret metadata under owner rules and checks every retained result entry after grant expiry',async()=>{
  const {c,secret}=await setupAgent(f);
  await f.db.prepare("INSERT INTO approval_rules VALUES(?,'secrets.list',NULL,?,1,0)").bind(key(),secret!.id).run();
  const a=await gateSecretList(c,key());expect(a?.status).toBe('pending');
  await expect(actionResult(c,a!.id)).rejects.toHaveProperty('code','result_not_ready');
  await approve(f,a!);expect((await executeAction(f.context(),a!.id)).status).toBe('succeeded');
  const result=await (await actionResult(c,a!.id)).json<any>();expect(result.secrets).toHaveLength(1);expect(JSON.stringify(result)).not.toContain(CANARY);
  await f.db.prepare('UPDATE secret_grants SET expires_at=1 WHERE agent_id=?').bind(c.actor.agentId).run();
  await expect(actionResult(c,a!.id)).rejects.toHaveProperty('code','not_found_or_not_allowed');
 });
 it('enforces the 20-second abort deadline and keeps timeout exceptions private',async()=>{
  const {c,secret}=await setupAgent(f),a=await submitProxy(c,requestFor(secret),key());await approve(f,a);
  const original=setTimeout;
  const timer=vi.spyOn(globalThis,'setTimeout').mockImplementation(((callback:any,ms?:number,...args:any[])=>original(callback,ms===20000?50:ms,...args)) as typeof setTimeout);
  const fetcher=vi.fn(async(_url:any,init:any)=>new Promise<Response>((_,reject)=>{
   const fail=()=>reject(new Error('timeout '+CANARY));
   if(init.signal.aborted)fail();else init.signal.addEventListener('abort',fail,{once:true});
  }));
  try {expect((await executeAction(f.context(),a.id,fetcher)).status).toBe('unknown');expect(fetcher).toHaveBeenCalledTimes(1);}
  finally {timer.mockRestore();}
  expect(JSON.stringify(await getAction(c,a.id))).not.toContain(CANARY);
 });
});

describe('proxy URL and header policy',()=>{
 const secret={injection_header:'authorization'};
 const input=(change:any)=>proxyInput({url:'https://api.example.com/',method:'POST',...change},secret,['api.example.com','xn--bcher-kva.example'],'https://locker.example.com');
 it.each(['http://api.example.com','https://u:p@api.example.com','https://api.example.com/#x','https://api.example.com:444','https://127.0.0.1','https://[::1]','https://2130706433','https://localhost','https://foo.internal','https://foo.home.arpa','https://one'])('rejects destination %s',(url)=>{expect(()=>input({url})).toThrow();});
 it.each(['authorization','Authorization','cookie','host','connection','proxy-authorization','x-forwarded-host','forwarded','upgrade','content-length','cf-connecting-ip'])('rejects header %s',(name)=>{expect(()=>input({headers:{[name]:'x'}})).toThrow();});
 it('normalizes case and IDNA and rejects injection conflicts, CRLF, unsupported methods, and malformed bodies',()=>{
  expect(input({url:'https://API.EXAMPLE.COM/a?b=1&a=2'}).url).toBe('https://api.example.com/a?b=1&a=2');
  expect(input({url:'https://bücher.example/'}).hostname).toBe('xn--bcher-kva.example');
  for(const change of [{method:'TRACE'},{method:'CONNECT'},{method:'GET',body_text:'x'},{method:'HEAD',body_text:'x'},{headers:{x:'bad\r\nvalue'}},{headers:{x:' leading'}},{headers:{x:'trailing '}},{headers:{x:'\u0100'}},{headers:{X:'one',x:'two'}},{headers:[]},{headers:null},{body_text:3},{body_base64:'%%%'},{body_text:'x',body_base64:'eA=='},{extra:true}])expect(()=>input(change)).toThrow();
  expect(()=>proxyInput({url:'https://api.example.com',method:'POST',headers:{'x-api-key':'x'}},{injection_header:'x-api-key'},['api.example.com'],'https://locker.example.com')).toThrow();
  for(const header of ['cookie','host','content-type','x-forwarded-for'])expect(()=>injection(header,'plain')).toThrow();
 });
 it('bounds decoded bytes and header bytes and preserves stable canonical encoding',async()=>{
  expect(()=>input({body_text:'a'.repeat(LIMITS.proxyBody+1)})).toThrow();expect(()=>input({headers:{x:'a'.repeat(LIMITS.headers)}})).toThrow();
  expect(canonical({b:2,a:[1,{z:0,a:'x'}]})).toBe('{"a":[1,{"a":"x","z":0}],"b":2}');
  expect(await sha(unbase64('aA=='))).toBe(await sha(unbase64('aB==')));
 });
 it('redacts short keys, marker text, overlapping joins, and binary content without leaking the key',()=>{
  for(const [secret,body] of [['D','some D bytes'],['REDACTED','a REDACTED value'],['aba','aababa'],['x[R','xx[R'],['aaaaab','a'.repeat(20000)+'b']]) {
   expect(new TextDecoder().decode(redact(bytes(body),secret))).not.toContain(secret);
  }
  expect(redact(new Uint8Array([0,255,128]),CANARY)).toEqual(new Uint8Array([0,255,128]));
 });
});
