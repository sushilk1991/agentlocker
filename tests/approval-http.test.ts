import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Response as RuntimeResponse } from 'miniflare';
import { database } from './helpers';
import { CANARY, key, setupAgent } from './approval-helpers';
import { unbase64 } from '../src/security';

let f:Awaited<ReturnType<typeof database>>,token:string,secret:any;
const captured:{url:string;auth:string|null;body:string}[]=[];
const request=(route:string,owner=false,method='GET',body?:any,headers:Record<string,string>={})=>f.runtime.dispatchFetch(`https://locker.example.com/api/v1/${owner?'owner/':''}${route}`,{
 method,body:body===undefined?undefined:JSON.stringify(body),headers:{authorization:`Bearer ${owner?f.env.OWNER_TOKEN:token}`,...(body===undefined?{}:{'content-type':'application/json','idempotency-key':key()}),...headers},
});
const submit=async()=>{
 const response=await request('proxy/requests',false,'POST',{secret:secret.name,url:'https://api.example.com/send?keep=1',method:'POST',body_text:'send exactly this'});
 expect(response.status).toBe(202);return response.json<any>();
};
async function terminal(id:string) {
 for(let i=0;i<100;i++) {
  const response=await request('actions/'+id),a=await response.json<any>();if(!['pending','ready','executing'].includes(a.status))return a;
  await new Promise(r=>setTimeout(r,20));
 }
 throw new Error('action did not finish');
}

describe('approval and proxy routes in the real bundled Worker',()=>{
 beforeAll(async()=>{
  f=await database(true,true,async req=>{
   captured.push({url:req.url,auth:req.headers.get('authorization'),body:await req.text()});
   return new RuntimeResponse('echo '+CANARY,{status:201,headers:{'x-echo':CANARY,'set-cookie':CANARY}});
  });
  const agent=await setupAgent(f);token=agent.t.token;secret=agent.secret;
 });
 afterAll(async()=>{await f?.runtime.dispose();});
 it('holds sends for exact owner review, then executes independently of the agent connection',async()=>{
  const before=captured.length,a=await submit();expect(captured).toHaveLength(before);
  expect((await request(`actions/${a.id}`)).status).toBe(200);expect(captured).toHaveLength(before);
  const review=await (await request(`approvals/${a.approval_id}`,true)).json<any>();
  expect(review).toMatchObject({digest:expect.any(String),input:{request:{method:'POST',url:'https://api.example.com/send?keep=1'}}});
  expect(await (await request(`approvals/${a.approval_id}/content`,true)).text()).toBe('send exactly this');
  expect((await request(`approvals/${a.approval_id}/decision`,true,'POST',{digest:'0'.repeat(64),decision:'approve'})).status).toBe(409);
  const decision=await request(`approvals/${a.approval_id}/decision`,true,'POST',{digest:review.digest,decision:'approve'});
  expect(decision.status).toBe(200);expect((await decision.json<any>()).status).toBe('ready');
  expect((await terminal(a.id)).status).toBe('succeeded');expect(captured).toHaveLength(before+1);
  expect(captured[before]).toEqual({url:'https://api.example.com/send?keep=1',auth:'Bearer '+CANARY,body:'send exactly this'});
  const response=await request(`actions/${a.id}/result`),result=await response.json<any>();
  expect(result.upstream_status).toBe(201);expect(new TextDecoder().decode(unbase64(result.body_base64))).toBe('echo [REDACTED]');
  expect(JSON.stringify(result)).not.toContain(CANARY);expect(result.headers).not.toHaveProperty('set-cookie');
  expect(response.headers.get('cache-control')).toBe('no-store');
 });
 it('protects all owner approval and secret routes against agents and cross-origin decisions',async()=>{
  const a=await submit(),review=await (await request(`approvals/${a.approval_id}`,true)).json<any>();
  for(const [route,method,body] of [
   ['approvals','GET',undefined],[`approvals/${a.approval_id}`,'GET',undefined],[`approvals/${a.approval_id}/content`,'GET',undefined],
   [`approvals/${a.approval_id}/decision`,'POST',{digest:review.digest,decision:'approve'}],['approvals/batch-decision','POST',{members:[],decision:'approve'}],
   ['secrets','POST',{}],[`secrets/${secret.id}`,'PUT',{}],[`secrets/${secret.id}/disable`,'POST',{}],
  ] as const)expect((await request(route,true,method,body,{authorization:`Bearer ${token}`})).status).toBe(401);
  expect((await request(`approvals/${a.approval_id}/decision`,true,'POST',{digest:review.digest,decision:'approve'},{origin:'https://evil.example.com'})).status).toBe(403);
  expect((await request(`approvals/${a.approval_id}/decision`,true)).status).toBe(404);
  expect((await (await request(`actions/${a.id}`)).json<any>()).status).toBe('pending');
 });
 it('denies actions through POST and validates decisions, batches, and request schemas',async()=>{
  const a=await submit(),review=await (await request(`approvals/${a.approval_id}`,true)).json<any>(),before=captured.length;
  for(const body of [{digest:review.digest,decision:'approve',extra:true},{digest:review.digest,decision:'maybe'},{decision:'approve'}])expect((await request(`approvals/${a.approval_id}/decision`,true,'POST',body)).status).toBe(400);
  const denied=await request('approvals/batch-decision',true,'POST',{members:[{id:a.approval_id,digest:review.digest}],decision:'deny'});
  expect(denied.status).toBe(200);expect((await denied.json<any>()).results[0].status).toBe('denied');
  expect((await (await request(`actions/${a.id}`)).json<any>()).status).toBe('denied');expect(captured).toHaveLength(before);
  expect((await request(`actions/${a.id}/result`)).status).toBe(409);
  const list=await (await request('approvals?state=denied',true)).json<any>();expect(list.approvals.map((x:any)=>x.id)).toContain(a.id);
  expect((await request('proxy/requests',false,'POST',{secret:secret.name,url:'https://evil.example.com/',method:'GET'})).status).toBe(404);
 });
 it('returns a retained terminal decision on submission retry without pending HTTP status or another send',async()=>{
  const idempotency=key(),input={secret:secret.name,url:'https://api.example.com/retry',method:'GET'};
  const first=await request('proxy/requests',false,'POST',input,{'idempotency-key':idempotency});
  expect(first.status).toBe(202);expect(first.headers.get('retry-after')).toBe('2');
  const a=await first.json<any>(),before=captured.length;
  const review=await (await request(`approvals/${a.approval_id}`,true)).json<any>();
  expect((await request(`approvals/${a.approval_id}/decision`,true,'POST',{digest:review.digest,decision:'deny'})).status).toBe(200);
  const retry=await request('proxy/requests',false,'POST',input,{'idempotency-key':idempotency});
  expect(retry.status).toBe(200);expect(retry.headers.has('retry-after')).toBe(false);
  expect(await retry.json<any>()).toMatchObject({id:a.id,status:'denied',expires_at:a.expires_at});
  expect(captured).toHaveLength(before);
 });
 it('creates, replaces and disables secrets without returning stored bytes',async()=>{
  const name='http-'+key(),input={name,value:CANARY,hosts:['api.example.com'],injection_header:'x-api-key',scheme:'plain'};
  const created=await request('secrets',true,'POST',input);expect(created.status).toBe(201);const s=await created.json<any>();
  expect(JSON.stringify(s)).not.toContain(CANARY);
  expect((await request(`secrets/${s.id}`,true,'PUT',{...input,value:'new-key',expected_version:99})).status).toBe(409);
  const updated=await (await request(`secrets/${s.id}`,true,'PUT',{...input,value:'new-key',expected_version:1})).json<any>();expect(updated.value_version).toBe(2);
  expect((await request(`secrets/${s.id}/disable`,true,'POST',{expected_version:2})).status).toBe(200);
  expect((await request(`secrets/${s.id}`,true)).status).toBe(404);
  for(const owner of [true,false]) {
   const metadata=await (await request('secrets',owner)).text();for(const field of [CANARY,'encrypted_value','token_hash'])expect(metadata).not.toContain(field);
  }
 });
 it('executes an approved exact-revision delete through the shared engine',async()=>{
  const p='/mine/http-delete-'+key();
  const created=await f.runtime.dispatchFetch(`https://locker.example.com/api/v1/files/content?path=${p}`,{method:'PUT',body:'original',headers:{authorization:`Bearer ${token}`,'content-type':'text/plain','idempotency-key':key(),'if-none-match':'*'}});
  const revision=(await created.json<any>()).result_revision;
  const response=await request(`files/content?path=${p}`,false,'DELETE',undefined,{'if-match':`"${revision}"`,'idempotency-key':key()});
  const a=await response.json<any>();expect(a.status).toBe('pending');
  const review=await (await request(`approvals/${a.approval_id}`,true)).json<any>();
  expect((await request(`approvals/${a.approval_id}/decision`,true,'POST',{digest:review.digest,decision:'approve'})).status).toBe(200);
  expect((await terminal(a.id)).status).toBe('succeeded');expect((await request(`files/content?path=${p}`)).status).toBe(404);
 });
});
