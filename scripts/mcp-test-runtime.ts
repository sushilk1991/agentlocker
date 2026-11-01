import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
export async function freePort() {
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=(server.address() as {port:number}).port;
 await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 return port;
}

export async function mcpRuntime(upstream:string) {
 const dir=await mkdtemp(join(tmpdir(),'agentlocker-mcp-'));
 const port=await freePort(),origin=`http://127.0.0.1:${port}`;
 const owner=randomBytes(32).toString('hex'),control=randomBytes(32).toString('hex');
 const config=join(dir,'wrangler.json'),state=join(dir,'state');
 const wrangler=resolve('node_modules/wrangler/bin/wrangler.js');
 let dev:ChildProcess|undefined,migration:ChildProcess|undefined,logs='';
 let stopping:Promise<void>|undefined,disposing:Promise<void>|undefined;
 const env={...process.env,WRANGLER_SEND_METRICS:'false',CLOUDFLARE_ENV:undefined};
 const startChild=(args:string[])=> {
  const child=spawn(process.execPath,[wrangler,...args,'--config',config],{env,detached:true,stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream!.on('data',data=>{logs=(logs+data.toString()).slice(-16000);});
  return child;
 };
 async function stopChild(child:ChildProcess|undefined) {
  if(!child?.pid)return;
  // Wrangler can exit before its workerd children. Stop the whole group even
  // when the wrapper already exited, and wait before removing persistence.
  const alive=()=>{try {process.kill(-child.pid!,0);return true;}catch{return false;}};
  try {process.kill(-child.pid,'SIGTERM');}catch{}
  const deadline=Date.now()+4000;
  while(alive()&&Date.now()<deadline)await pause(50);
  if(alive()) {try {process.kill(-child.pid,'SIGKILL');}catch{}}
 }
 async function stop() {
  if(stopping)return stopping;
  const child=dev;dev=undefined;
  stopping=stopChild(child);
  try {await stopping;}finally {stopping=undefined;}
 }
 const signals=new Map<NodeJS.Signals,()=>void>();
 function dispose() {
  return disposing??=(async()=>{
   try {await stop();await stopChild(migration);await rm(dir,{recursive:true,force:true});}
   finally {for(const [signal,handler] of signals)process.removeListener(signal,handler);}
  })();
 }
 for(const [signal,code] of [['SIGINT',130],['SIGTERM',143]] as const) {
  const handler=()=>{void dispose().then(()=>process.exit(code),()=>process.exit(1));};
  signals.set(signal,handler);process.once(signal,handler);
 }
 try {
  await writeFile(config,JSON.stringify({name:'agentlocker-mcp-test',main:resolve('scripts/fixtures/mcp-worker.ts'),
   compatibility_date:'2025-10-14',compatibility_flags:['nodejs_compat'],
   d1_databases:[{binding:'DB',database_name:'agentlocker-test',database_id:'00000000-0000-0000-0000-000000000001',migrations_dir:resolve('migrations')}],
   r2_buckets:[{binding:'FILES',bucket_name:'agentlocker-test-files'}],
   vars:{PUBLIC_ORIGIN:origin,DEPLOYMENT_ID:'mcp-test-deployment',ENCRYPTION_KEY_VERSION:'1',TEST_UPSTREAM:upstream},observability:{enabled:false},
  }));
  await writeFile(join(dir,'.dev.vars'),`OWNER_TOKEN=${owner}\nLOCKER_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\nTEST_CONTROL_TOKEN=${control}\n`,{mode:0o600});
  migration=startChild(['d1','migrations','apply','DB','--local','--persist-to',state]);
  let timer:ReturnType<typeof setTimeout>|undefined;
  let code;
  try {
   code=await Promise.race([once(migration,'exit').then(([code])=>code),new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new Error('Migration timed out'));},60000);})]);
  } finally {clearTimeout(timer);}
  if(code!==0)throw new Error('Migrations failed: '+logs);
  await stopChild(migration);migration=undefined;
 } catch(error) {await dispose();throw error;}
 return {origin,owner,control,
  async start() {
   dev=startChild(['dev','--local','--ip','127.0.0.1','--port',String(port),'--persist-to',state,'--log-level','error','--no-show-interactive-dev-session']);
   const deadline=Date.now()+60000;
   while(Date.now()<deadline && dev.exitCode===null) {
    try {if((await fetch(origin+'/healthz',{signal:AbortSignal.timeout(500)})).ok)return;}catch{}
    await pause(100);
   }
   throw new Error('Wrangler did not become healthy: '+logs);
  },stop,dispose,logs:()=>logs};
}
