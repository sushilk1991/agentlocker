import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLocker, AgentLockerError, Download, HttpClient, isAction, newIdempotencyKey, retryAfter } from '../packages/sdk/src/index';
const origin = 'https://locker.example.com', token = 'al_client-canary';
const action = (status = 'pending', extra: object = {}) => ({request_id:'request-1',id:'action-1',approval_id:'approval-1',status,expires_at:123456,...extra});
const response = (data: unknown, status = 200, headers: Record<string,string> = {}) => Response.json(data,{status,headers});
function fixture(reply: (request: Request) => Response | Promise<Response> = () => response({request_id:'request-1'})) {
 const calls: Request[] = [];
 const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input,init); calls.push(request); return reply(request);
 }) as unknown as typeof fetch;
 return {sdk:new AgentLocker({base_url:origin,token,fetch:fetcher}),calls,fetcher};
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe('fetch SDK public contract',()=>{
 it('builds every route and encodes logical paths once, preserving pages and key headers',async()=>{
  const {sdk,calls}=fixture();
  await sdk.identity(); await sdk.files.list('/mine/a & b/',{cursor:'a&b',limit:7},{idempotency_key:'read-key-12345678'});
  await sdk.files.metadata('/mine/a?b'); await sdk.secrets.list({cursor:'secret-next',limit:2});
  await sdk.actions.list({cursor:'action-next',limit:3}); await sdk.actions.get('a/b');
  const result=await sdk.actions.result('a/b'); await result.bytes();
  expect(calls.map(r=>new URL(r.url).pathname)).toEqual(['/api/v1/whoami','/api/v1/files','/api/v1/files/metadata','/api/v1/secrets','/api/v1/actions','/api/v1/actions/a%2Fb','/api/v1/actions/a%2Fb/result']);
  expect(new URL(calls[1].url).searchParams.get('prefix')).toBe('/mine/a & b/');
  expect(new URL(calls[1].url).searchParams.get('cursor')).toBe('a&b');
  expect(calls[1].headers.get('idempotency-key')).toBe('read-key-12345678');
  expect(calls[2].headers.get('idempotency-key')).toHaveLength(36);
  expect(new URL(calls[3].url).searchParams.get('cursor')).toBe('secret-next');
  for(const request of calls) {expect(request.headers.get('authorization')).toBe('Bearer '+token);expect(request.redirect).toBe('manual');}
 });
 it('preserves all byte values on download, including metadata headers',async()=>{
  const bytes=Uint8Array.from({length:1024},(_,i)=>i%256);
  const {sdk}=fixture(()=>new Response(bytes,{headers:{etag:'"revision-1"','x-content-sha256':'hash','content-type':'application/octet-stream','content-length':String(bytes.length),'x-request-id':'request-2'}}));
  const result=await sdk.files.read('/mine/binary');expect(result).toBeInstanceOf(Download);
  if(!(result instanceof Download))throw Error('expected bytes');
  expect(result).toMatchObject({revision:'revision-1',hash:'hash',length:1024,request_id:'request-2'});
  expect(await result.bytes()).toEqual(bytes);
 });
 it('streams uploads with exact preconditions and the caller key, without base64',async()=>{
  const uploaded:Uint8Array[]=[];
  const {sdk,calls}=fixture(async request=>{uploaded.push(new Uint8Array(await request.arrayBuffer()));return response(action('succeeded'));});
  const bytes=Uint8Array.of(0,255,128,13,10);
  await sdk.files.write('/mine/a',new Blob([bytes]).stream(),{create_only:true,media_type:'application/octet-stream',idempotency_key:'stable-write-key-123'});
  await sdk.files.write('/mine/a',bytes,{expected_revision:'revision-1',media_type:'image/png',idempotency_key:'stable-write-key-456'});
  await sdk.files.delete('/mine/a','revision-2',{idempotency_key:'stable-delete-key-123'});
  expect(uploaded[0]).toEqual(bytes);expect(uploaded[1]).toEqual(bytes);
  expect(calls[0].headers.get('if-none-match')).toBe('*');expect(calls[0].headers.has('if-match')).toBe(false);
  expect(calls[1].headers.get('if-match')).toBe('"revision-1"');
  expect(calls[1].headers.get('content-type')).toBe('image/png');expect(calls[2].method).toBe('DELETE');
  expect(calls[2].headers.get('if-match')).toBe('"revision-2"');
 });
 it.each(['pending','ready','executing','succeeded','failed','denied','expired','invalidated','unknown'])('keeps the %s state without claiming success',async status=>{
  const {sdk}=fixture(()=>response(action(status),status==='pending'?202:200));
  expect(await sdk.actions.get('action-1')).toMatchObject({status});
  expect(isAction(action(status))).toBe(true);
 });
 it.each([202,200])('returns gated file-read actions with HTTP %i rather than pretending they are bytes',async status=>{
  const {sdk}=fixture(()=>response(action(status===202?'pending':'denied'),status));
  expect(await sdk.files.read('/mine/a')).toMatchObject({id:'action-1',status:status===202?'pending':'denied'});
 });
 it('never retries a mutation after network failure or unknown status',async()=>{
  const fetcher=vi.fn().mockRejectedValue(new Error('sensitive '+token));
  const sdk=new AgentLocker({base_url:origin,token,fetch:fetcher});
  await expect(sdk.proxy.request({secret:'provider',url:'https://api.example.com/send',method:'POST'},{idempotency_key:'stable-send-key-123'})).rejects.toMatchObject({code:'network_error',status:0});
  expect(fetcher).toHaveBeenCalledTimes(1);
  const {sdk:second,calls}=fixture(()=>response(action('unknown')));
  expect((await second.proxy.request({secret:'provider',url:'https://api.example.com/send',method:'POST'},{idempotency_key:'stable-send-key-456'})).status).toBe('unknown');
  expect(calls).toHaveLength(1);
 });
 it('provides typed locker errors and preserves IDs and rate guidance',async()=>{
  const {sdk}=fixture(()=>response({error:{code:'rate_limited',message:'Wait before trying again.'},request_id:'r',action_id:'a',approval_id:'p'},429,{'retry-after':'3'}));
  await expect(sdk.identity()).rejects.toMatchObject({name:'AgentLockerError',code:'rate_limited',status:429,request_id:'r',action_id:'a',approval_id:'p',retry_after_ms:3000});
  expect(retryAfter('Thu, 01 Jan 1970 00:00:00 GMT')).toBe(0);
 });
 it('sanitizes non-JSON responses, network exceptions, and malformed successful JSON',async()=>{
  const {sdk}=fixture(()=>new Response('gateway '+token,{status:503}));
  await expect(sdk.identity()).rejects.toMatchObject({code:'http_error',message:'The request failed.'});
  const {sdk:empty}=fixture(()=>response(null,502));
  await expect(empty.identity()).rejects.toMatchObject({code:'http_error',status:502});
  const {sdk:other}=fixture(()=>new Response('not json'));
  await expect(other.identity()).rejects.toMatchObject({code:'invalid_response'});
  const {sdk:redirected,calls}=fixture(()=>new Response(null,{status:302,headers:{location:'https://another.example.com'}}));
  await expect(redirected.identity()).rejects.toMatchObject({code:'http_error',status:302});expect(calls).toHaveLength(1);
 });
 it('rejects invalid URLs, credentials, keys, revisions, and oversized buffered writes before fetching',async()=>{
  for(const base_url of ['not a URL','http://remote.example','https://user:pass@locker.example.com','https://locker.example.com/sub','https://locker.example.com/?token=oops'])expect(()=>new AgentLocker({base_url,token})).toThrow(AgentLockerError);
  expect(()=>new AgentLocker({base_url:origin,token:'bad\nvalue'})).toThrow(AgentLockerError);
  const {sdk,calls}=fixture();
  await expect(sdk.proxy.request({secret:'p',url:origin,method:'GET'},{idempotency_key:'short'})).rejects.toMatchObject({code:'invalid_idempotency_key'});
  expect(()=>sdk.files.write('/mine/a',new Uint8Array(10*1024*1024+1),{create_only:true,media_type:'x/test',idempotency_key:newIdempotencyKey()})).toThrow(AgentLockerError);
  expect(()=>sdk.files.delete('/mine/a','"quoted"',{idempotency_key:newIdempotencyKey()})).toThrow(AgentLockerError);
  expect(calls).toHaveLength(0);
  const http=new HttpClient({base_url:origin,token});await expect(http.request('/api/v1/../../outside')).rejects.toMatchObject({code:'invalid_path'});
 });
 it('propagates caller abort and timeout to fetch without disclosing the token',async()=>{
  vi.useFakeTimers();
  const fetcher=vi.fn((_url,init)=>new Promise<Response>((_resolve,reject)=>{
   if(init.signal.aborted)reject(new Error(token)); else init.signal.addEventListener('abort',()=>reject(new Error(token)),{once:true});
  }));
  const sdk=new AgentLocker({base_url:origin,token,fetch:fetcher,timeout_ms:100});
  const timed=expect(sdk.identity()).rejects.toMatchObject({code:'aborted'});await vi.advanceTimersByTimeAsync(100);await timed;
  const controller=new AbortController();const stopped=expect(sdk.identity({signal:controller.signal})).rejects.toMatchObject({code:'aborted'});controller.abort();await stopped;
  expect(fetcher).toHaveBeenCalledTimes(2);
 });
});
describe('SDK wait helper',()=>{
 it('backs off with jitter, honors Retry-After, and polls GET only through execution',async()=>{
  vi.useFakeTimers();vi.spyOn(Math,'random').mockReturnValue(0.5);
  const times:number[]=[],states=['pending','ready','executing','succeeded'];
  const {sdk,calls}=fixture(()=>{times.push(Date.now());const state=states.shift();return response(action(state),200,{'retry-after':state==='pending'?'5':'2'});});
  const waiting=sdk.actions.wait('action-1',{timeout_ms:30000});
  await vi.advanceTimersByTimeAsync(15000);
  expect((await waiting).status).toBe('succeeded');
  expect(times.slice(1).map((time,i)=>time-times[i])).toEqual([5000,3300,4950]);
  expect(calls.every(r=>r.method==='GET')).toBe(true);expect(calls).toHaveLength(4);
 });
 it('returns the last pending state at its deadline, without another submission',async()=>{
  vi.useFakeTimers();const {sdk,calls}=fixture(()=>response(action(),200,{'retry-after':'10'}));
  const waiting=sdk.actions.wait('action-1',{timeout_ms:1500});
  await vi.advanceTimersByTimeAsync(1500);expect((await waiting).status).toBe('pending');expect(calls).toHaveLength(1);
 });
 it('backs off on 429 using server guidance, then observes a terminal state',async()=>{
  vi.useFakeTimers();let count=0;
  const {sdk,calls}=fixture(()=>++count===1?response({error:{code:'rate_limited'}},429,{'retry-after':'4'}):response(action('denied')));
  const waiting=sdk.actions.wait('action-1',{timeout_ms:10000});await vi.advanceTimersByTimeAsync(4000);
  expect((await waiting).status).toBe('denied');expect(calls).toHaveLength(2);
 });
 it('aborts a wait without sending a cancel or a new mutation',async()=>{
  vi.useFakeTimers();const {sdk,calls}=fixture(()=>response(action()));const controller=new AbortController();
  const stopped=expect(sdk.actions.wait('action-1',{signal:controller.signal})).rejects.toMatchObject({code:'aborted'});
  await vi.advanceTimersByTimeAsync(100);controller.abort();await stopped;expect(calls).toHaveLength(1);
 });
 it.each(['denied','expired','invalidated','failed','unknown'])('returns terminal %s immediately',async status=>{
  const {sdk,calls}=fixture(()=>response(action(status)));expect((await sdk.actions.wait('action-1')).status).toBe(status);expect(calls).toHaveLength(1);
 });
});
