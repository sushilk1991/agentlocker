import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { Miniflare, Response as RuntimeResponse } from 'miniflare';
import { AgentLocker, AgentLockerError, Download, HttpClient, type Action } from '../packages/sdk/src/index';
import { database } from './helpers';
import { CANARY, key, setupAgent } from './approval-helpers';
import { executeAction } from '../src/approvals';
const exec=promisify(execFile);
let f:Awaited<ReturnType<typeof database>>, agent:Awaited<ReturnType<typeof setupAgent>>, other:Awaited<ReturnType<typeof setupAgent>>;
let sdk:AgentLocker, owner:HttpClient, dir:string, origin:string;
const outbound:{auth:string|null;body:string}[]=[];
async function port() {
 const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const number=(server.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return number;
}
async function cli(args:string[],token=agent.t.token, interrupt=false) {
 const env={...process.env,AGENTLOCKER_URL:origin,AGENTLOCKER_TOKEN:token,AGENTLOCKER_OWNER_TOKEN:f.env.OWNER_TOKEN,AGENTLOCKER_CONFIG:join(dir,'no-config')};
 if(interrupt) {
  // Wait for an actual action status read before interrupting the waiting child.
  const {spawn}=await import('node:child_process');
  const child=spawn(process.execPath,['packages/cli/dist/index.js',...args,'--json'],{env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  const done=new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));});
  try {
   const id=args[2];
   for(let attempt=0;attempt<150;attempt++) {
    const row=await f.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE operation='action.get' AND action_id=?").bind(id).first<{n:number}>();
    if(row!.n>0)break;
    await new Promise(resolve=>setTimeout(resolve,20));
    if(attempt===149)throw Error('child never polled');
   }
   child.kill('SIGINT');const result=await done;return {...result,value:JSON.parse(result.stdout)};
  } finally { if(child.exitCode===null)child.kill('SIGKILL'); }
 }
 try {const result=await exec(process.execPath,['packages/cli/dist/index.js',...args,'--json'],{env,timeout:15000});return {code:0,...result,value:JSON.parse(result.stdout)};}
 catch(error) {const result=error as unknown as {code:number;stdout:string;stderr:string};return {...result,value:JSON.parse(result.stdout)};}
}
async function terminal(id:string) {
 for(let i=0;i<100;i++) {const action=await sdk.actions.get(id);if(!['pending','ready','executing'].includes(action.status))return action;await new Promise(r=>setTimeout(r,20));}
 throw Error('action did not finish');
}
async function decision(action:Action,choice='approve') {
 const review=await owner.json<any>('/api/v1/owner/approvals/'+action.approval_id);
 await owner.json('/api/v1/owner/approvals/'+action.approval_id+'/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({digest:review.digest,decision:choice})},{idempotency_key:key()});
 return review;
}
describe('published client flows against the bundled Worker over HTTP',()=>{
 beforeAll(async()=>{
  dir=await mkdtemp(join(tmpdir(),'agentlocker-clients-'));origin='http://127.0.0.1:'+await port();
  await exec('npm',['run','clients:build'],{timeout:30000});
  f=await database(true,true,async request=>{outbound.push({auth:request.headers.get('authorization'),body:await request.text()});return new RuntimeResponse('echo '+CANARY,{status:503,headers:{'x-echo':CANARY,'set-cookie':CANARY}});},origin);
  await f.runtime.ready;agent=await setupAgent(f);other=await setupAgent(f,false);
  // Use a disjoint namespace for the second identity.
  await f.db.prepare("UPDATE folder_grants SET prefix='/other/' WHERE agent_id=?").bind(other.a.id).run();
  sdk=new AgentLocker({base_url:origin,token:agent.t.token});owner=new HttpClient({base_url:origin,token:f.env.OWNER_TOKEN});
 },45000);
 afterAll(async()=>{await f?.runtime.dispose();if(dir)await rm(dir,{recursive:true,force:true});});
 it('checks real identity through SDK, CLI whoami, and configure without saving credentials',async()=>{
  const identity=await sdk.identity();expect(identity).toMatchObject({agent:{id:agent.a.id},token:{id:agent.t.id},grants:{folders:[{prefix:'/mine/'}]}});
  const whoami=await cli(['whoami']);expect(whoami.code).toBe(0);expect(whoami.value.agent.id).toBe(agent.a.id);
  const configured=await cli(['configure','--label','coding-task']);expect(configured.code).toBe(0);expect(configured.value.identity.agent.id).toBe(agent.a.id);
  const saved=await readFile(join(dir,'no-config'),'utf8');expect(JSON.parse(saved)).toEqual({url:origin,label:'coding-task'});
  for(const value of [agent.t.token,f.env.OWNER_TOKEN,CANARY])expect(saved.includes(value)).toBe(false);
 });
 it('streams a 10 MiB file through HTTP, preserves bytes, and deduplicates with the same key',async()=>{
  const bytes=Uint8Array.from({length:10*1024*1024},(_,i)=>i%256),idempotency_key=key();
  const first=await sdk.files.write('/mine/large',new Blob([bytes]).stream(),{create_only:true,media_type:'application/octet-stream',idempotency_key});
  const retry=await sdk.files.write('/mine/large',bytes,{create_only:true,media_type:'application/octet-stream',idempotency_key});expect(retry.id).toBe(first.id);
  const read=await sdk.files.read('/mine/large');expect(read).toBeInstanceOf(Download);if(!(read instanceof Download))throw Error('expected bytes');const downloaded=await read.bytes();expect(downloaded.byteLength).toBe(bytes.byteLength);expect(Buffer.from(downloaded).equals(Buffer.from(bytes))).toBe(true);
  await expect(sdk.files.write('/mine/large',Uint8Array.of(1),{create_only:true,media_type:'application/octet-stream',idempotency_key})).rejects.toMatchObject({code:'idempotency_conflict',status:409});
 });
 it('runs built CLI create/read and refuses cross-agent access',async()=>{
  const input=join(dir,'input'),output=join(dir,'output'),bytes=Buffer.from([0,255,128,13,10]);await writeFile(input,bytes);
  const written=await cli(['files','put',input,'/mine/cli']);expect(written.code).toBe(0);expect(written.value.status).toBe('succeeded');
  expect((await cli(['files','get','/mine/cli','--output',output])).code).toBe(0);expect(await readFile(output)).toEqual(bytes);
  const denied=await cli(['files','get','/mine/cli','--output',join(dir,'other')],other.t.token);expect(denied.code).toBe(1);expect(denied.value.error.code).toBe('not_found_or_not_allowed');
  await expect(new AgentLocker({base_url:origin,token:other.t.token}).files.metadata('/mine/cli')).rejects.toMatchObject({status:404});
 });
 it('lists actions and pages granted secrets through the real SDK and built CLI',async()=>{
  const actions=await sdk.actions.list({limit:1});expect(actions.actions).toHaveLength(1);expect(actions.cursor).toEqual(expect.any(String));
  const next=await sdk.actions.list({limit:1,cursor:actions.cursor!});expect(next.actions).toHaveLength(1);expect(next.actions[0].id).not.toBe(actions.actions[0].id);
  const listed=await cli(['actions','list','--limit','1']);expect(listed.code).toBe(0);expect(listed.value.actions[0].id).toBe(actions.actions[0].id);
  await expect(new AgentLocker({base_url:origin,token:other.t.token}).actions.get(actions.actions[0].id)).rejects.toMatchObject({status:404});
  const secret=await owner.json<any>('/api/v1/owner/secrets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
   name:'z-client-pagination',value:CANARY,hosts:['api.example.com'],injection_header:'Authorization',scheme:'bearer',
  })},{idempotency_key:key()});
  const current=await owner.json<any>('/api/v1/owner/agents/'+agent.a.id+'/grants');
  await owner.json('/api/v1/owner/agents/'+agent.a.id+'/grants',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({
   expected_version:current.version,folders:[{prefix:'/mine/',read:true,write:true,delete:true}],secrets:[{secret_id:agent.secret!.id,read:true},{secret_id:secret.id,read:true}],
  })},{idempotency_key:key()});
  const first=await sdk.secrets.list({limit:1});if('status' in first)throw Error('expected metadata');expect(first.cursor).toEqual(expect.any(String));
  const second=await sdk.secrets.list({limit:1,cursor:first.cursor!});if('status' in second)throw Error('expected metadata');
  expect(new Set([first.secrets[0].id,second.secrets[0].id])).toEqual(new Set([secret.id,agent.secret!.id]));expect(second.cursor).toBeNull();
  const page=await cli(['secrets','list','--limit','1','--cursor',first.cursor!]);expect(page.code).toBe(0);expect(page.value.secrets[0].id).toBe(second.secrets[0].id);
 });
 it('requires exact approval for replacement and delete; full CLI review drives one decision',async()=>{
  const created=await sdk.files.write('/mine/review',Uint8Array.of(1),{create_only:true,media_type:'application/octet-stream',idempotency_key:key()});
  const proposed=Uint8Array.of(0,255,128,10),pending=await sdk.files.write('/mine/review',proposed,{expected_revision:created.result_revision!,media_type:'application/octet-stream',idempotency_key:key()});
  expect(pending.status).toBe('pending');const old=await sdk.files.read('/mine/review');expect(await (old as Download).bytes()).toEqual(Uint8Array.of(1));
  const file=join(dir,'full-review.json'),shown=await cli(['admin','approvals','show',pending.approval_id!,'--output',file]);expect(shown.code).toBe(3);
  const saved=JSON.parse(await readFile(file,'utf8'));expect(Buffer.from(saved.content_base64,'base64')).toEqual(Buffer.from(proposed));
  const approved=await cli(['admin','approvals','approve',pending.approval_id!,'--review',file,'--digest',shown.value.digest]);expect([0,3]).toContain(approved.code);
  const completed=await terminal(pending.id);expect(completed.status).toBe('succeeded');
  const deleted=await cli(['files','delete','/mine/review','--revision',completed.result_revision!]);expect(deleted.code).toBe(3);
  await decision(deleted.value,'deny');expect((await cli(['actions','get',deleted.value.id])).code).toBe(2);
  const unchanged=await sdk.files.read('/mine/review');expect(await (unchanged as Download).bytes()).toEqual(proposed);
 });
 it('interrupts a real waiting CLI without cancelling the pending action and retrieves approved read bytes',async()=>{
  await f.db.prepare("INSERT INTO approval_rules VALUES(?,'file.read','/mine/',NULL,1,0)").bind(key()).run();
  const pending=await sdk.files.read('/mine/cli');expect(pending).not.toBeInstanceOf(Download);const action=pending as Action;
  const stopped=await cli(['actions','wait',action.id,'--timeout','30'],agent.t.token,true);expect(stopped.code).toBe(3);expect(stopped.value.action_id).toBe(action.id);
  expect((await sdk.actions.get(action.id)).status).toBe('pending');
  await decision(action);expect((await terminal(action.id)).status).toBe('succeeded');
  const file=join(dir,'read-result');expect((await cli(['actions','result',action.id,'--output',file])).code).toBe(0);expect(await readFile(file)).toEqual(await readFile(join(dir,'input')));
  await f.db.prepare("DELETE FROM approval_rules WHERE operation='file.read'").run();
 });
 it('holds and deduplicates sends, redacts results, and distinguishes upstream errors',async()=>{
  const count=outbound.length,idempotency_key=key(),input={secret:agent.secret!.name,url:'https://api.example.com/send',method:'POST' as const,body_text:'hello'};
  const pending=await sdk.proxy.request(input,{idempotency_key});expect((await sdk.proxy.request(input,{idempotency_key})).id).toBe(pending.id);expect(outbound).toHaveLength(count);
  await decision(pending);const completed=await terminal(pending.id);expect(completed).toMatchObject({status:'succeeded',result:{upstream_status:503}});
  expect(outbound.slice(count)).toEqual([{auth:'Bearer '+CANARY,body:'hello'}]);
  const file=join(dir,'proxy-result'),result=await cli(['actions','result',pending.id,'--output',file]);expect(result.code).toBe(1);
  const text=await readFile(file,'utf8');expect(text).not.toContain(CANARY);const value=JSON.parse(text);expect(Buffer.from(value.body_base64,'base64').toString()).toBe('echo [REDACTED]');expect(value.headers).not.toHaveProperty('set-cookie');
 });
 it('observes expired, unknown, and definite request errors with the documented exit codes',async()=>{
  const input={secret:agent.secret!.name,url:'https://api.example.com/send',method:'GET' as const};
  const expired=await sdk.proxy.request(input,{idempotency_key:key()});const trigger=await f.db.prepare("SELECT sql FROM sqlite_master WHERE name='action_immutable'").first<string>('sql');
  await f.db.prepare('DROP TRIGGER action_immutable').run();
  try {await f.db.prepare('UPDATE actions SET expires_at=0 WHERE id=?').bind(expired.id).run();}
  finally {await f.db.prepare(trigger!).run();}
  expect((await cli(['actions','get',expired.id])).code).toBe(2);
  const unknown=await sdk.proxy.request(input,{idempotency_key:key()});
  // Claim through the shared engine with an interrupted controlled upstream.
  const review=await owner.json<any>('/api/v1/owner/approvals/'+unknown.approval_id);
  const {decideApproval}=await import('../src/approvals');await decideApproval(f.context(),unknown.approval_id!,review.digest,'approve');
  await executeAction(f.context(),unknown.id,async()=>{throw Error('disconnect');});
  expect((await cli(['actions','get',unknown.id])).code).toBe(2);expect((await sdk.actions.wait(unknown.id)).status).toBe('unknown');
  expect((await cli(['actions','get','does-not-exist'])).code).toBe(1);
 });
 it('supports owner management and filtered audit exports without leaking credentials',async()=>{
  const created=await cli(['admin','agents','create','--name','cli-admin-agent']);expect(created.value.status).toBe('disabled');
  const grantFile=join(dir,'grants.json');await writeFile(grantFile,JSON.stringify({expected_version:1,folders:[{prefix:'/cli/',read:true,write:false,delete:false}],secrets:[]}));
  expect((await cli(['admin','grants','set',created.value.id,'--file',grantFile])).code).toBe(0);
  expect((await cli(['admin','grants','get',created.value.id])).code).toBe(0);
  const issued=await cli(['admin','tokens','create',created.value.id,'--label','test-task','--expires-in','60']);expect(issued.value.sensitive).toBe(true);expect(issued.value.token).toMatch(/^al_/);
  expect((await cli(['admin','tokens','revoke',created.value.id,issued.value.id])).code).toBe(0);
  expect((await cli(['admin','agents','update',created.value.id,'--status','enabled'])).code).toBe(0);
  expect((await cli(['admin','agents','revoke',created.value.id])).code).toBe(0);
  const file=join(dir,'audit.jsonl');expect((await cli(['admin','audit','export','--output',file,'--filter','operation=proxy.result'])).code).toBe(0);
  const audit=await readFile(file,'utf8');for(const canary of [CANARY,agent.t.token,f.env.OWNER_TOKEN,issued.value.token])expect(audit).not.toContain(canary);
  expect(audit.trim().split('\n').map(line=>JSON.parse(line)).every(row=>row.operation==='proxy.result')).toBe(true);
 });
});

it('runs SDK byte/stream examples in a Worker runtime without Node dependencies',async()=>{
 const script=(await build({stdin:{contents:`import { AgentLocker, Download } from './packages/sdk/src/index.ts';
 export default { async fetch() { try {
  let stored;
  const client=new AgentLocker({base_url:'https://locker.example.com',token:'worker-test-token',fetch:async(input,init)=>{
   const request=new Request(input,init);
   if(request.method==='PUT') { stored=new Uint8Array(await request.arrayBuffer());return Response.json({status:'succeeded',id:'a',request_id:'r'}); }
   return new Response(stored,{headers:{etag:'"r1"','content-type':'application/octet-stream'}});
  }});
  const bytes=Uint8Array.of(0,255,128,13,10);
  const write=await client.files.write('/mine/a',new Blob([bytes]).stream(),{create_only:true,media_type:'application/octet-stream',idempotency_key:'worker-example-key-123'});
  const read=await client.files.read('/mine/a');
  return Response.json({status:write.status,bytes:Array.from(await read.bytes()),revision:read.revision});
 } catch(error) { return Response.json({error:error.message,code:error.code}); } }};`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'})).outputFiles[0].text;
 const runtime=new Miniflare({modules:true,script,compatibilityDate:'2025-10-14'});
 try {expect(await (await runtime.dispatchFetch('https://example.com')).json()).toEqual({status:'succeeded',bytes:[0,255,128,13,10],revision:'r1'});}
 finally {await runtime.dispose();}
});
