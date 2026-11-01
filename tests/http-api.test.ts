import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Response as RuntimeResponse } from 'miniflare';
import { database } from './helpers';
import { CANARY, key, setupAgent } from './approval-helpers';
import { decideApproval } from '../src/approvals';

let f:Awaited<ReturnType<typeof database>>,agent:Awaited<ReturnType<typeof setupAgent>>,other:Awaited<ReturnType<typeof setupAgent>>;
let sends=0;
const request=(route:string,owner=false,method='GET',input?:unknown,headers:Record<string,string>={})=>f.runtime.dispatchFetch(
 `https://locker.example.com/api/v1/${owner?'owner/':''}${route}`,{method,
  headers:{authorization:`Bearer ${owner?f.env.OWNER_TOKEN:agent.t.token}`,
   ...(input===undefined?{}:{'content-type':'application/json','idempotency-key':key()}),...headers},
  body:input===undefined?undefined:JSON.stringify(input),
 });
const read=async(route:string,owner=false)=>{
 const response=await request(route,owner);expect(response.status).toBe(200);return response.json<any>();
};
const policy=()=>read('policy',true);
const settings=()=>read('settings',true);
const send=async()=>{
 const response=await request('proxy/requests',false,'POST',{secret:agent.secret!.name,url:'https://api.example.com/send',method:'GET'});
 expect(response.status).toBe(202);return response.json<any>();
};
async function upload(p:string,data=Uint8Array.of(0,255,128)) {
 const response=await f.runtime.dispatchFetch(`https://locker.example.com/api/v1/files/content?path=${encodeURIComponent(p)}`,{
  method:'PUT',headers:{authorization:`Bearer ${agent.t.token}`,'content-type':'application/octet-stream','if-none-match':'*','idempotency-key':key()},body:data,
 });
 expect(response.status).toBe(200);return response.json<any>();
}
async function terminal(id:string) {
 for(let i=0;i<100;i++) {
  const a=await read('actions/'+id,true);if(!['pending','ready','executing'].includes(a.status))return a;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw Error('action did not finish');
}
beforeAll(async()=>{
 f=await database(true,true,async()=>{sends++;return new RuntimeResponse('response '+CANARY,{status:201});});
 agent=await setupAgent(f);other=await setupAgent(f);
 await f.db.prepare("UPDATE folder_grants SET prefix='/other/' WHERE agent_id=?").bind(other.a.id).run();
});
afterAll(async()=>{await f?.runtime.dispose();});

describe('HTTP identity and agent lists',()=>{
 it('returns only authenticated identity and live grants, with HTTP and MCP parity',async()=>{
  // An expired grant must not appear as effective access.
  await f.db.prepare(`INSERT INTO folder_grants VALUES(?,?,'/expired/',1,1,1,1,1,0)`).bind(key(),agent.a.id).run();
  const identity=await read('whoami');
  expect(identity).toMatchObject({agent:{id:agent.a.id,name:agent.a.name},token:{id:agent.t.id,expires_at:agent.t.expires_at},
   grants:{folders:[{prefix:'/mine/',read:1,write:1,delete:1}],secrets:[{id:agent.secret!.id,name:agent.secret!.name}]}});
  expect(identity.grants.folders).toHaveLength(1);expect(identity.grants.secrets).toHaveLength(1);
  const response=await f.runtime.dispatchFetch('https://locker.example.com/mcp',{method:'POST',headers:{authorization:`Bearer ${agent.t.token}`,
   'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'locker_identity',arguments:{}}})});
  const mcp=(await response.json<any>()).result.structuredContent;
  const {request_id,...value}=identity;const {request_id:mcpId,...mcpValue}=mcp;expect(mcpValue).toEqual(value);
  for(const forbidden of [agent.t.token,CANARY,other.secret!.name,'token_hash','encrypted_value','cipher','nonce'])expect(JSON.stringify(identity).includes(forbidden)).toBe(false);
  expect((await request('whoami',false,'GET',undefined,{authorization:`Bearer ${f.env.OWNER_TOKEN}`})).status).toBe(401);
  expect((await request('whoami?agent_id='+other.a.id)).status).toBe(400);
  expect((await f.db.prepare("SELECT agent_id FROM audit_events WHERE operation='identity.read' ORDER BY id DESC LIMIT 1").first<any>())?.agent_id).toBe(agent.a.id);
 });
 it('pages only accessible actions, defaults to 50, permits 100, and handles timestamp ties',async()=>{
  const timestamp=Date.now();
  await f.db.batch(Array.from({length:105},(_,i)=>f.db.prepare(`INSERT INTO actions
   (id,agent_id,token_id,request_id,operation,target,digest,submission_digest,config_version,status,created_at,updated_at,expires_at)
   VALUES(?,?,?,?,'file.write',?,?,?,1,'succeeded',?,?,?)`).bind(`history-${String(i).padStart(3,'0')}`,agent.a.id,agent.t.id,key(),'/mine/history-'+i,'0'.repeat(64),'0'.repeat(64),timestamp,timestamp,timestamp+900000)));
  await f.db.prepare(`INSERT INTO actions(id,agent_id,token_id,request_id,operation,target,digest,submission_digest,config_version,status,created_at,updated_at,expires_at)
   VALUES('hidden-action',?,?,?,'file.write','/other/private',?,?,1,'succeeded',?,?,?)`).bind(other.a.id,other.t.id,key(),'0'.repeat(64),'0'.repeat(64),timestamp+1,timestamp+1,timestamp+900000).run();
  const first=await read('actions');expect(first.actions).toHaveLength(50);expect(first.cursor).toEqual(expect.any(String));
  expect(first.actions.every((a:any)=>a.target.startsWith('/mine/')&&a.operation==='file.write')).toBe(true);
  const ids=[...first.actions.map((a:any)=>a.id)];let cursor=first.cursor;
  while(cursor) {const page=await read('actions?limit=50&cursor='+encodeURIComponent(cursor));ids.push(...page.actions.map((a:any)=>a.id));cursor=page.cursor;}
  expect(ids).toHaveLength(105);expect(new Set(ids).size).toBe(105);expect(ids).toEqual([...ids].sort().reverse());
  expect((await read('actions?limit=100')).actions).toHaveLength(100);
  expect((await request('actions?cursor='+encodeURIComponent(first.cursor),false,'GET',undefined,{authorization:`Bearer ${other.t.token}`})).status).toBe(400);
  for(const q of ['limit=101','limit=0','limit=1.5','cursor=bad','cursor=','limit=1&limit=2','agent_id='+other.a.id])expect((await request('actions?'+q)).status).toBe(400);
  for(const suffix of ['','/result'])expect((await request('actions/hidden-action'+suffix)).status).toBe(404);
  // Removing all grants conceals targets and does not leave a cursor or count.
  await f.db.prepare('UPDATE folder_grants SET write=0 WHERE agent_id=?').bind(agent.a.id).run();
  try {expect(await read('actions')).toMatchObject({actions:[],cursor:null});}
  finally {await f.db.prepare('UPDATE folder_grants SET write=1 WHERE agent_id=?').bind(agent.a.id).run();}
 });
 it('pages only granted secret metadata and conceals owner grant attribution',async()=>{
  const created=await request('secrets',true,'POST',{name:'z-http-secret',value:CANARY,hosts:['api.example.com'],injection_header:'Authorization',scheme:'bearer'});
  const secret=await created.json<any>();
  await f.db.prepare('INSERT INTO secret_grants VALUES(?,?,?,1,NULL,1,0)').bind(key(),agent.a.id,secret.id).run();
  const first=await read('secrets?limit=1');expect(first.secrets).toHaveLength(1);expect(first.cursor).toEqual(expect.any(String));
  const next=await read('secrets?limit=1&cursor='+encodeURIComponent(first.cursor));expect(next.secrets).toHaveLength(1);expect(next.cursor).toBeNull();
  expect(new Set([first.secrets[0].id,next.secrets[0].id])).toEqual(new Set([secret.id,agent.secret!.id]));
  for(const s of [...first.secrets,...next.secrets])expect(s).not.toHaveProperty('agents');
  expect((await request('secrets?cursor='+encodeURIComponent(first.cursor),false,'GET',undefined,{authorization:`Bearer ${other.t.token}`})).status).toBe(400);
  for(const q of ['limit=101','limit=0','cursor=bad','cursor=','limit=1&limit=2'])expect((await request('secrets?'+q)).status).toBe(400);
  const owned=await read('secrets?limit=100',true);
  expect(owned.secrets.find((s:any)=>s.id===secret.id)).toMatchObject({hosts:['api.example.com'],agents:[{id:agent.a.id,name:agent.a.name,read:1}]});
  expect(owned.secrets.some((s:any)=>s.id===other.secret!.id)).toBe(true);
  for(const value of [CANARY,'encrypted_value','nonce','key_version','token_hash'])expect(JSON.stringify(owned).includes(value)).toBe(false);
  const ownerPage=await read('secrets?limit=1',true);expect(ownerPage.cursor).toEqual(expect.any(String));
  expect((await request('secrets?cursor='+encodeURIComponent(ownerPage.cursor))).status).toBe(400);
 });
});

describe('owner policy and settings routes',()=>{
 it('replaces additional rules, rejects weakened mandatory rules, and invalidates pending and ready work',async()=>{
  const pending=await send(),ready=await send(),before=sends;
  const review=await read('approvals/'+ready.approval_id,true);
  // Leave one approved action unclaimed, rather than dispatching through HTTP.
  await decideApproval(f.context(),ready.approval_id,review.digest,'approve');
  const current=await policy();expect(current.mandatory).toEqual(['file.delete','file.replace','proxy.request']);
  const rules=[{operation:'file.read',prefix:'/mine/'},{operation:'secrets.list',secret_id:agent.secret!.id}];
  const idempotency=key(),body={expected_version:current.version,rules};
  const changed=await request('policy',true,'PUT',body,{'idempotency-key':idempotency});expect(changed.status).toBe(200);
  const updated=await changed.json<any>();expect(updated.version).toBe(current.version+1);
  expect((await policy()).rules).toMatchObject(rules);
  for(const a of [pending,ready]) {
   expect(await read('actions/'+a.id)).toMatchObject({status:'invalidated'});
   expect((await read('actions/'+a.id,true)).timeline.some((e:any)=>e.operation==='approval.invalidated')).toBe(true);
  }
  expect(sends).toBe(before);
  expect((await request('policy',true,'PUT',body,{'idempotency-key':idempotency})).status).toBe(200);
  expect((await request('policy',true,'PUT',{...body,rules:[]},{'idempotency-key':idempotency})).status).toBe(409);
  expect((await request('policy',true,'PUT',body)).status).toBe(409);
  for(const rules of [[{operation:'file.delete'}],[{operation:'proxy.request',approval:false}],[{operation:'file.read',prefix:'/mine',secret_id:null}],
   [{operation:'secrets.list',secret_id:'missing'}],[{operation:'file.read',prefix:'/mine/'},{operation:'file.read',prefix:'/mine/'}]]) {
   expect((await request('policy',true,'PUT',{expected_version:updated.version,rules})).status).toBe(400);
  }
  expect((await request('policy',true,'PUT',{expected_version:updated.version,rules:[],mandatory:[]})).status).toBe(400);
  const gated=await request('secrets?limit=1',false,'GET',undefined,{'idempotency-key':key()});expect(gated.status).toBe(202);
  const count=await f.db.prepare('SELECT COUNT(*) AS n FROM actions').first<any>();
  expect((await request('secrets?cursor=bad',false,'GET',undefined,{'idempotency-key':key()})).status).toBe(400);
  expect((await f.db.prepare('SELECT COUNT(*) AS n FROM actions').first<any>())!.n).toBe(count.n);
  const gatedAction=await gated.json<any>(),gatedReview=await read('approvals/'+gatedAction.approval_id,true);
  expect(gatedReview.input.parameters).toEqual({limit:1});
  const decision=await request('approvals/'+gatedAction.approval_id+'/decision',true,'POST',{digest:gatedReview.digest,decision:'approve'});
  expect(decision.status).toBe(200);expect((await terminal(gatedAction.id)).status).toBe('succeeded');
  expect((await read('actions/'+gatedAction.id+'/result')).secrets).toHaveLength(1);
  // Removing all additional rules leaves the built-in send/delete gates in place.
  expect((await request('policy',true,'PUT',{expected_version:updated.version,rules:[]})).status).toBe(200);
  expect((await send()).status).toBe('pending');expect(sends).toBe(before);
  const created=await upload('/mine/mandatory-delete');
  const deletion=await request('files/content?path=/mine/mandatory-delete',false,'DELETE',undefined,{'if-match':`"${created.result_revision}"`,'idempotency-key':key()});
  expect((await deletion.json<any>()).status).toBe('pending');
  const replacement=await f.runtime.dispatchFetch('https://locker.example.com/api/v1/files/content?path=/mine/mandatory-delete',{
   method:'PUT',headers:{authorization:`Bearer ${agent.t.token}`,'content-type':'text/plain','if-match':`"${created.result_revision}"`,'idempotency-key':key()},body:'replacement',
  });expect(replacement.status).toBe(202);
 });
 it('applies saved rules to reads, listings, and new writes, and retains exact binary results for the owner',async()=>{
  const created=await upload('/mine/rule-read'),old=await policy();
  const rules=[{operation:'file.read',prefix:'/mine/'},{operation:'files.list',prefix:'/mine/'},{operation:'file.write',prefix:'/mine/gated/'}];
  expect((await request('policy',true,'PUT',{expected_version:old.version,rules})).status).toBe(200);
  const binary=await request('files/content?path=/mine/rule-read',false,'GET',undefined,{'idempotency-key':key()});expect(binary.status).toBe(202);
  const action=await binary.json<any>();
  const listing=await request('files?prefix=/mine/&limit=1',false,'GET',undefined,{'idempotency-key':key()});expect(listing.status).toBe(202);
  const write=await f.runtime.dispatchFetch('https://locker.example.com/api/v1/files/content?path=/mine/gated/new',{
   method:'PUT',headers:{authorization:`Bearer ${agent.t.token}`,'content-type':'text/plain','if-none-match':'*','idempotency-key':key()},body:'waiting',
  });expect(write.status).toBe(202);
  expect((await f.db.prepare("SELECT current_revision_id FROM files WHERE path='/mine/gated/new'").first<any>())?.current_revision_id??null).toBeNull();
  const review=await read('approvals/'+action.approval_id,true);
  expect((await request('approvals/'+action.approval_id+'/decision',true,'POST',{digest:review.digest,decision:'approve'})).status).toBe(200);
  expect((await terminal(action.id)).status).toBe('succeeded');
  const result=await request('actions/'+action.id+'/result',true);expect(result.headers.get('etag')).toBe(`"${created.result_revision}"`);
  expect(new Uint8Array(await result.arrayBuffer())).toEqual(Uint8Array.of(0,255,128));
  expect((await request('policy',true,'PUT',{expected_version:(await policy()).version,rules:[]})).status).toBe(200);
 });
 it('validates settings, uses a shared version precondition, and keeps maintenance recoverable',async()=>{
  const old=await settings(),pending=await send(),body={expected_version:old.version,approval_ttl:120000,quota_bytes:2*1024*1024,retention_ms:8*86400000};
  const idempotency=key(),updated=await request('settings',true,'PATCH',body,{'idempotency-key':idempotency});expect(updated.status).toBe(200);
  const {expected_version,...values}=body;expect(await settings()).toMatchObject({...values,version:old.version+1});
  expect((await read('actions/'+pending.id)).status).toBe('invalidated');
  expect((await request('settings',true,'PATCH',body,{'idempotency-key':idempotency})).status).toBe(200);
  expect((await request('settings',true,'PATCH',body)).status).toBe(409);
  const version=(await settings()).version;
  for(const patch of [{approval_ttl:1},{approval_ttl:'900000'},{quota_bytes:0},{quota_bytes:1.5},{retention_ms:0},{maintenance:1},{public_origin:'https://evil.example'},{OWNER_TOKEN:'change'},{}])
   expect((await request('settings',true,'PATCH',{expected_version:version,...patch})).status).toBe(400);
  expect((await request('settings',true,'PATCH',{expected_version:version,maintenance:true})).status).toBe(200);
  expect((await request('whoami')).status).toBe(503);expect((await request('policy',true)).status).toBe(503);
  const paused=await settings();expect(paused.maintenance).toBe(true);
  expect((await request('settings',true,'PATCH',{expected_version:paused.version,maintenance:false})).status).toBe(200);
  expect((await request('whoami')).status).toBe(200);
  const result=await send();expect(result.expires_at-Date.now()).toBeGreaterThan(115000);expect(result.expires_at-Date.now()).toBeLessThanOrEqual(120000);
 });
 it('allows only one concurrent configuration writer and rejects stale cursors',async()=>{
  const actionPage=await read('actions?limit=1'),secretPage=await read('secrets?limit=1'),old=await settings();
  const results=await Promise.all([request('settings',true,'PATCH',{expected_version:old.version,quota_bytes:3*1024*1024}),
   request('policy',true,'PUT',{expected_version:old.version,rules:[]})]);
  expect(results.map(r=>r.status).sort()).toEqual([200,409]);expect((await settings()).version).toBe(old.version+1);
  for(const [route,page] of [['actions',actionPage],['secrets',secretPage]] as const)expect((await request(route+'?cursor='+encodeURIComponent(page.cursor))).status).toBe(400);
 });
 it('rolls back config, rules, receipts, and invalidation when the audit write fails',async()=>{
  const pending=await send(),old=await policy(),idempotency=key();
  await f.db.prepare("CREATE TRIGGER config_audit_fail BEFORE INSERT ON audit_events WHEN NEW.operation IN('policy.update','settings.update') BEGIN SELECT RAISE(ABORT,'injected'); END").run();
  try {
   expect((await request('policy',true,'PUT',{expected_version:old.version,rules:[{operation:'file.read'}]},{'idempotency-key':idempotency})).status).toBe(503);
   expect((await request('settings',true,'PATCH',{expected_version:old.version,quota_bytes:999})).status).toBe(503);
   expect((await policy()).version).toBe(old.version);expect((await policy()).rules).toEqual(old.rules);
   expect((await read('actions/'+pending.id)).status).toBe('pending');
   expect(await f.db.prepare('SELECT caller_key FROM idempotency_keys WHERE caller_key=?').bind(idempotency).first()).toBeNull();
  }finally{await f.db.prepare('DROP TRIGGER config_audit_fail').run();}
 });
});

describe('owner investigation and transport boundaries',()=>{
 it('provides full review, cross-agent owner timelines, retained results, and tombstones',async()=>{
  const created=await upload('/mine/owner-inspection'),action=await send(),before=sends;
  const review=await read('approvals/'+action.approval_id,true);expect(review).toMatchObject({input:{request:{method:'GET'}},digest_context:{agent_id:agent.a.id}});
  expect((await read('actions/'+action.id,true)).timeline.map((e:any)=>e.operation)).toContain('proxy.request');expect(sends).toBe(before);
  expect((await request('approvals/'+action.approval_id+'/decision',true,'POST',{digest:review.digest,decision:'approve'})).status).toBe(200);
  const done=await terminal(action.id);expect(done).toMatchObject({status:'succeeded',attempt:{state:'succeeded',upstream_status:201}});
  const timeline=await read('actions/'+action.id+'?limit=100',true);
  for(const op of ['proxy.request','approval.review','approval.decision','action.claim','proxy.dispatch','proxy.result'])expect(timeline.timeline.map((e:any)=>e.operation)).toContain(op);
  const page=await read('actions/'+action.id+'?limit=1',true);expect(page.timeline).toHaveLength(1);expect(page.next_cursor).toBeTruthy();
  const next=await read('actions/'+action.id+'?limit=1&cursor='+page.next_cursor,true);expect(next.timeline[0].id).toBeLessThan(page.timeline[0].id);
  const response=await request('actions/'+action.id+'/result',true);expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await response.json<any>()).upstream_status).toBe(201);
  expect((await read('actions/hidden-action',true)).agent_id).toBe(other.a.id);
  for(const route of ['actions/'+action.id,'actions/'+action.id+'/result'])expect((await request(route,false,'GET',undefined,{authorization:`Bearer ${other.t.token}`})).status).toBe(404);
  const deletion=await request('files/content?path=/mine/owner-inspection',true,'DELETE',undefined,{'if-match':`"${created.result_revision}"`,'x-confirm-revision':created.result_revision,'idempotency-key':key()});
  expect(deletion.status).toBe(200);
  const ownerFiles=await read('files?prefix=/mine/&limit=100',true);expect(ownerFiles.files.find((v:any)=>v.path==='/mine/owner-inspection').deleted_at).toEqual(expect.any(Number));
  const ownerPage=await read('files?prefix=/mine/&limit=1',true);expect(ownerPage.cursor).toEqual(expect.any(String));
  const nextFiles=await read('files?prefix=/mine/&limit=1&cursor='+encodeURIComponent(ownerPage.cursor),true);
  expect(nextFiles.files[0].path).not.toBe(ownerPage.files[0].path);
  expect((await request('files?prefix=/mine/&cursor='+encodeURIComponent(ownerPage.cursor))).status).toBe(400);
  const agentFiles=await read('files?prefix=/mine/');expect(agentFiles.files.some((v:any)=>v.path==='/mine/owner-inspection')).toBe(false);
  expect((await request('files/content?path=/mine/owner-inspection')).status).toBe(404);
 });
 it('never dispatches during bounded status waiting and refuses invalid waits',async()=>{
  const action=await send(),before=sends;
  const waiting=request('actions/'+action.id+'?wait_seconds=2');
  const review=await read('approvals/'+action.approval_id,true);
  expect((await request('approvals/'+action.approval_id+'/decision',true,'POST',{digest:review.digest,decision:'deny'})).status).toBe(200);
  const waited=await waiting;expect(waited.status).toBe(200);expect((await waited.json<any>()).status).toBe('denied');expect(sends).toBe(before);
  for(const wait of ['-1','21','0.5','bad'])expect((await request('actions/'+action.id+'?wait_seconds='+wait)).status).toBe(400);
 });
 it('enforces owner and agent credential separation on every completed route',async()=>{
  const action=await send();
  for(const [route,method,body] of [
   ['policy','GET',undefined],['policy','PUT',{expected_version:1,rules:[]}],['settings','GET',undefined],['settings','PATCH',{expected_version:1,quota_bytes:1}],
   ['files','GET',undefined],['secrets','GET',undefined],[`actions/${action.id}`,'GET',undefined],[`actions/${action.id}/result`,'GET',undefined],[`approvals/${action.approval_id}`,'GET',undefined],
  ] as const) {
   expect((await request(route,true,method,body,{authorization:`Bearer ${agent.t.token}`})).status).toBe(401);
   expect((await request(route,true,method,body,{authorization:''})).status).toBe(401);
   expect((await request(route,true,method,body,{origin:'https://evil.example'})).status).toBe(403);
  }
  for(const route of ['whoami','actions','secrets'])expect((await request(route,false,'GET',undefined,{authorization:`Bearer ${f.env.OWNER_TOKEN}`})).status).toBe(401);
  for(const route of ['actions/missing','actions/missing/result','approvals/missing'])expect((await request(route,true)).status).toBe(404);
  const version=(await settings()).version;
  for(const [route,method,body] of [['settings','PATCH',{expected_version:version,quota_bytes:1}],['policy','PUT',{expected_version:version,rules:[]}]] as const) {
   expect((await request(route,true,method,body,{'content-type':'text/plain'})).status).toBe(400);
   expect((await request(route,true,method,body,{'idempotency-key':''})).status).toBe(400);
  }
 });
 it('fails closed on protected reads when audit persistence fails',async()=>{
  const action=await upload('/mine/audit-read');
  await f.db.prepare("CREATE TRIGGER route_audit_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'injected'); END").run();
  try {
   for(const [route,owner] of [['whoami',false],['actions',false],['secrets',false],['policy',true],['settings',true],['files',true],['secrets',true],['actions/'+action.id,true],['actions/'+action.id+'/result',true]] as const) {
    const response=await request(route,owner);expect(response.status).toBe(503);
    expect(await response.json<any>()).toMatchObject({error:{code:'audit_unavailable'}});
   }
  }finally{await f.db.prepare('DROP TRIGGER route_audit_fail').run();}
 });
});
