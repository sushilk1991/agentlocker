// Test entry point only. The deployed wrangler.jsonc points at src/index.ts.
import worker from '../../src/index';
import type { Env } from '../../src/types';

interface TestEnv extends Env { TEST_UPSTREAM: string; TEST_CONTROL_TOKEN: string }
const nativeFetch=globalThis.fetch;
let upstream='';
// Only the test destination is redirected. All proxy policy checks still run.
globalThis.fetch=((input: RequestInfo | URL,init?:RequestInit) => {
 const url=new URL(input instanceof Request?input.url:String(input));
 if(url.origin==='https://api.example.com') {
  url.host=new URL(upstream).host;url.protocol='http:';
  return nativeFetch(url,init);
 }
 return nativeFetch(input,init);
}) as typeof fetch;

export default {
 async fetch(request:Request,env:TestEnv,ctx:ExecutionContext) {
  upstream=env.TEST_UPSTREAM;
  if(new URL(request.url).pathname==='/__test__/expire') {
   if(request.headers.get('authorization')!==`Bearer ${env.TEST_CONTROL_TOKEN}`)return new Response(null,{status:401});
   const {id}=await request.json<{id:string}>();
   // Move one fixture deadline, then restore the exact production trigger in
   // the same atomic batch. No clock or expiry hook exists in the app.
   const trigger=await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='action_immutable'").first<string>('sql');
   await env.DB.batch([
    env.DB.prepare('DROP TRIGGER action_immutable'),
    env.DB.prepare("UPDATE actions SET expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)-1 WHERE id=? AND status='pending'").bind(id),
    env.DB.prepare(trigger!),
    env.DB.prepare('UPDATE approvals SET expires_at=(SELECT expires_at FROM actions WHERE id=?) WHERE action_id=?').bind(id,id),
   ]);
   return Response.json({expired:true});
  }
  return worker.fetch(request,env,ctx);
 },
};
