import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runCli, exitCode } from '../packages/cli/src/cli';
const origin='https://locker.example.com', token='al_cli-token-canary', owner='owner-token-canary';
const action=(status='pending',extra:object={})=>({id:'action-1',approval_id:'approval-1',status,expires_at:123456,request_id:'request-1',...extra});
let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'agentlocker-cli-'));});
afterEach(async()=>{vi.useRealTimers();await rm(dir,{recursive:true,force:true});});
function fixture(reply:(request:Request)=>Response|Promise<Response>=()=>Response.json({request_id:'r'}), env:Record<string,string>={}) {
 const calls:Request[]=[];
 const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{const req=new Request(input,init);calls.push(req);return reply(req);};
 return {calls, async run(args:string[], signal?:AbortSignal) {
  let stdout='',stderr='';const code=await runCli(args,{env:{AGENTLOCKER_URL:origin,AGENTLOCKER_TOKEN:token,AGENTLOCKER_OWNER_TOKEN:owner,AGENTLOCKER_CONFIG:join(dir,'config.json'),...env},fetch:fetcher,signal,stdout:s=>stdout+=s,stderr:s=>stderr+=s});
  return {code,stdout,stderr,...(args.includes('--json')?{value:JSON.parse(stdout)}:{})};
 }};
}
describe('CLI public behavior',()=>{
 it('configures and tests identity without saving either credential',async()=>{
  const f=fixture(()=>Response.json({request_id:'r',agent:{id:'a',name:'Agent'}}));
  const result=await f.run(['configure','--url',origin,'--label','coding','--json']);expect(result.code).toBe(0);
  const saved=await readFile(join(dir,'config.json'),'utf8');expect(JSON.parse(saved)).toEqual({url:origin,label:'coding'});
  expect(saved+result.stdout+result.stderr).not.toContain(token);expect(saved+result.stdout).not.toContain(owner);
  expect(f.calls[0].url).toBe(origin+'/api/v1/whoami');
 });
 it('does not save config when identity fails',async()=>{
  const f=fixture(()=>Response.json({error:{code:'unauthorized'},request_id:'r'},{status:401}));
  expect((await f.run(['configure','--json'])).code).toBe(1);expect(await readdir(dir)).toEqual([]);
 });
 it('uses config URL while requiring environment credentials',async()=>{
  await writeFile(join(dir,'config.json'),JSON.stringify({url:origin,label:'coding',token:'must-not-use'}));
  const f=fixture(undefined,{AGENTLOCKER_URL:'',AGENTLOCKER_TOKEN:''});
  expect((await f.run(['whoami','--json'])).value.error.code).toBe('invalid_arguments');expect(f.calls).toHaveLength(0);
 });
 it('isolates owner and agent credentials and renders untrusted text inertly',async()=>{
  const f=fixture(()=>Response.json({request_id:'r',name:'unsafe\u001b[31m\u202e'}));
  await f.run(['whoami']);const ownerResult=await f.run(['admin','agents','list']);
  expect(f.calls[0].headers.get('authorization')).toBe('Bearer '+token);expect(f.calls[1].headers.get('authorization')).toBe('Bearer '+owner);
  expect(ownerResult.stdout).not.toContain('\u001b');expect(ownerResult.stdout).not.toContain('\u202e');expect(ownerResult.stdout).toContain('\\u202e');
 });
 it('streams file puts with create-only by default and explicit replacement revisions',async()=>{
  const bytes=Buffer.from([0,255,128,10]);const file=join(dir,'upload');await writeFile(file,bytes);const uploaded:Buffer[]=[];
  const f=fixture(async req=>{uploaded.push(Buffer.from(await req.arrayBuffer()));return Response.json(action('succeeded'));});
  const created=await f.run(['files','put',file,'/mine/a','--json']);expect(created.code).toBe(0);expect(created.value.idempotency_key).toHaveLength(36);
  expect(f.calls[0].headers.get('idempotency-key')).toBe(created.value.idempotency_key);expect(f.calls[0].headers.get('if-none-match')).toBe('*');
  const replaced=await f.run(['files','put',file,'/mine/a','--revision','revision-1','--idempotency-key','explicit-key-123456','--json']);
  expect(replaced.value.idempotency_key).toBe('explicit-key-123456');expect(f.calls[1].headers.get('if-match')).toBe('"revision-1"');expect(uploaded).toEqual([bytes,bytes]);
 });
 it('downloads exact binary bytes atomically and requires --force to overwrite',async()=>{
  const file=join(dir,'output'), bytes=Uint8Array.of(255,0,128,13,10);
  const f=fixture(()=>new Response(bytes,{headers:{etag:'"revision-1"','content-type':'application/octet-stream'}}));
  expect((await f.run(['files','get','/mine/a','--output',file,'--json'])).code).toBe(0);expect(await readFile(file)).toEqual(Buffer.from(bytes));
  await writeFile(file,'keep me');const refused=await f.run(['files','get','/mine/a','--output',file,'--json']);
  expect(refused.code).toBe(1);expect(refused.value.error.code).toBe('output_exists');expect(await readFile(file,'utf8')).toBe('keep me');
  expect(await f.run(['files','get','/mine/a','--output',file,'--force','--json'])).toMatchObject({code:0});expect(await readFile(file)).toEqual(Buffer.from(bytes));
  expect((await readdir(dir)).filter(x=>x.endsWith('.tmp'))).toEqual([]);
 });
 it('preserves action IDs, expiry and retry key for pending deletes',async()=>{
  const f=fixture(()=>Response.json(action(),{status:202}));const result=await f.run(['files','delete','/mine/a','--revision','revision-1','--no-wait','--json']);
  expect(result.code).toBe(3);expect(result.value).toMatchObject({id:'action-1',approval_id:'approval-1',expires_at:123456,idempotency_key:expect.any(String)});
  expect(f.calls).toHaveLength(1);expect(f.calls[0].method).toBe('DELETE');
 });
 it('never creates an output file for a pending read',async()=>{
  const f=fixture(()=>Response.json(action(),{status:202}));const file=join(dir,'pending');
  expect((await f.run(['files','get','/mine/a','--output',file,'--json'])).code).toBe(3);expect(await readdir(dir)).toEqual([]);
 });
 it('returns pending at the wait deadline and does not cancel the server action on interruption',async()=>{
  const f=fixture(()=>Response.json(action()));
  const result=await f.run(['actions','wait','action-1','--timeout','0.01','--json']);
  expect(result.code).toBe(3);expect(result.value.id).toBe('action-1');
  const controller=new AbortController();const interrupted=f.run(['actions','wait','action-1','--json'],controller.signal);
  const timer=setTimeout(()=>controller.abort(),30);const stopped=await interrupted;clearTimeout(timer);
  expect(stopped.code).toBe(3);expect(stopped.value.action_id).toBe('action-1');expect(f.calls.every(r=>r.method==='GET')).toBe(true);
 });
 it.each([['pending',3],['ready',3],['executing',3],['succeeded',0],['failed',1],['denied',2],['expired',2],['invalidated',2],['unknown',2]] as const)('maps %s to exit %i',async(state,code)=>{
  const f=fixture(()=>Response.json(action(state)));const result=await f.run(['actions','get','action-1','--json']);expect(result.code).toBe(code);expect(result.value.status).toBe(state);
 });
 it('reports upstream error statuses separately from locker HTTP errors, including result downloads',async()=>{
  expect(exitCode(action('succeeded',{result:{upstream_status:503}}))).toBe(1);
  const f=fixture(()=>Response.json({upstream_status:404,headers:{},body_base64:'bm90IGZvdW5k'}));
  expect((await f.run(['actions','result','action-1','--json'])).code).toBe(1);
  const file=join(dir,'result');expect((await f.run(['actions','result','action-1','--output',file,'--json'])).code).toBe(1);
  expect(JSON.parse(await readFile(file,'utf8')).upstream_status).toBe(404);
 });
 it('submits send body bytes without provider credentials or accidental deployment URL reuse',async()=>{
  const file=join(dir,'body');await writeFile(file,Buffer.from([0,255,13]));let sent:any;
  const f=fixture(async req=>{sent=await req.json();return Response.json(action(),{status:202});});
  const result=await f.run(['send','--secret','provider','--url','https://api.example.com/send?a=1&b=2','--method','post','--header','content-type: application/octet-stream','--body-file',file,'--json']);
  expect(result.code).toBe(3);expect(f.calls[0].url).toBe(origin+'/api/v1/proxy/requests');
  expect(sent).toEqual({secret:'provider',url:'https://api.example.com/send?a=1&b=2',method:'POST',headers:{'content-type':'application/octet-stream'},body_base64:'AP8N'});
  expect(result.stdout).not.toContain(token);
  const refused=await f.run(['send','--secret','provider','--url','https://api.example.com','--method','GET','--header','Authorization: raw-key','--json']);expect(refused.code).toBe(1);expect(f.calls).toHaveLength(1);
 });
 it('validates flags and required inputs before any mutation',async()=>{
  const f=fixture();for(const args of [
   ['files','delete','/mine/a'],['files','delete','/mine/a','--revision','r','--wait','--no-wait'],
   ['files','delete','/mine/a','--revision','r','--wait','--timeout','oops'],['whoami','--typo'],
   ['admin','tokens','create','a','--label','task'],['send','--secret','p','--url','https://api.example.com'],
  ])expect((await f.run([...args,'--json'])).code).toBe(1);
  expect(f.calls).toHaveLength(0);
 });
 it('outputs only sanitized structured errors, keeping the key for uncertain submissions',async()=>{
  const f=fixture(()=>{throw new Error('connection leaked '+token+' '+owner);});
  const result=await f.run(['files','delete','/mine/a','--revision','r','--json']);expect(result.value.error.code).toBe('network_error');expect(result.value.idempotency_key).toHaveLength(36);
  expect(result.stdout+result.stderr).not.toContain(token);expect(result.stdout+result.stderr).not.toContain(owner);
 });
});

describe('owner CLI complete review',()=>{
 const canonical=(value:any):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
 function data() {
  const bytes=Buffer.from([0,255,13,10]);const input={operation:'file.delete',path:'/mine/a',expected_revision:'r',previous_hash:createHash('sha256').update(bytes).digest('hex'),previous_length:bytes.length};
  const digest_context={config_version:1,agent_id:'a',token_id:'t'};const digest=createHash('sha256').update(canonical({input,...digest_context})).digest('hex');
  return {bytes,review:{...action(),operation:'file.delete',target:'/mine/a',input,digest,digest_context}};
 }
 it('saves full bytes and binds a decision to the saved origin, approval ID, input, and digest',async()=>{
  const {bytes,review}=data();const file=join(dir,'review.json');
  const f=fixture(req=>req.url.endsWith('/content')?new Response(bytes):req.url.endsWith('/decision')?Response.json(action('ready')):Response.json(review));
  const shown=await f.run(['admin','approvals','show','approval-1','--output',file,'--json']);expect(shown.code).toBe(3);
  expect(JSON.parse(await readFile(file,'utf8'))).toMatchObject({format:'agentlocker-review-v1',origin,content_base64:bytes.toString('base64'),review});
  const approved=await f.run(['admin','approvals','approve','approval-1','--review',file,'--digest',review.digest,'--json']);expect(approved.code).toBe(3);
  const decision=f.calls.find(req=>req.url.endsWith('/decision'))!;expect(await decision.json()).toEqual({digest:review.digest,decision:'approve',reason:''});expect(decision.headers.get('authorization')).toBe('Bearer '+owner);
 });
 it('blocks decisions if the review is incomplete, truncated, altered, or from another origin',async()=>{
  const {bytes,review}=data(),file=join(dir,'review.json');
  const variants=[{origin:'https://other.example'}, {content_base64:bytes.subarray(0,2).toString('base64')}, {review:{...review,input:{...review.input,path:'/mine/b'}}}, {review:{...review,approval_id:'other'}}];
  const f=fixture();
  for(const variant of variants) {
   await writeFile(file,JSON.stringify({format:'agentlocker-review-v1',origin,review,content_base64:bytes.toString('base64'),...variant}));
   const result=await f.run(['admin','approvals','approve','approval-1','--review',file,'--digest',review.digest,'--json']);expect(result.value.error.code).toBe('review_mismatch');
  }
  expect(f.calls).toHaveLength(0);
 });
 it('does not permit approval from a digest alone or save an unverified review',async()=>{
  const {review}=data();const f=fixture(()=>Response.json({...review,digest:'0'.repeat(64)}));
  expect((await f.run(['admin','approvals','approve','approval-1','--digest',review.digest,'--json'])).code).toBe(1);
  expect((await f.run(['admin','approvals','show','approval-1','--output',join(dir,'bad'),'--json'])).code).toBe(1);expect(await readdir(dir)).toEqual([]);
 });
});
