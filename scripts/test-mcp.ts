import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { mcpRuntime, pause } from './mcp-test-runtime';

const CANARY='disposable-provider-'+crypto.randomUUID();
const captured:{path:string;authorization:string|undefined;body:string}[]=[];
const upstream=createServer(async(req,res)=> {
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
 captured.push({path:req.url!,authorization:req.headers.authorization,body:Buffer.concat(chunks).toString()});
 if(req.url==='/unknown') {res.end('x'.repeat(256*1024+1));return;}
 res.writeHead(201,{'content-type':'text/plain','x-key-echo':CANARY,'set-cookie':CANARY});
 res.end('echo '+CANARY);
});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
let runtime:Awaited<ReturnType<typeof mcpRuntime>>|undefined;
const clients:Client[]=[];
const key=()=>crypto.randomUUID();
let checks=0;
const checked=(name:string)=>{checks++;console.log('PASS '+name);};
try {
 runtime=await mcpRuntime(`http://127.0.0.1:${(upstream.address() as {port:number}).port}`);
 const r=runtime;await r.start();
 async function http(route:string,token:string,method='GET',body?:unknown,extra:Record<string,string>={}) {
  return fetch(r.origin+'/api/v1/'+route,{method,headers:{authorization:`Bearer ${token}`,'idempotency-key':key(),...(body===undefined?{}:{'content-type':'application/json'}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
 }
 async function owner(route:string,method='GET',body?:unknown) {
  const response=await http('owner/'+route,r.owner,method,body);
  assert(response.ok,`Owner ${route}: ${response.status} ${await response.clone().text()}`);
  return response.json() as Promise<any>;
 }
 async function agent(name:string,prefix:string,secretId?:string) {
  const a=await owner('agents','POST',{name});
  await owner(`agents/${a.id}/grants`,'PUT',{expected_version:1,folders:[{prefix,read:true,write:true,delete:true}],secrets:secretId?[{secret_id:secretId,read:true}]:[]});
  await owner(`agents/${a.id}`,'PATCH',{status:'enabled'});
  return {a,t:await owner(`agents/${a.id}/tokens`,'POST',{label:'real-mcp-test',lifetime_ms:3600000})};
 }
 async function connect(token?:string,inspect?: (request:Request)=>void) {
  const client=new Client({name:'agentlocker-real-test',version:'1.0.0'});
  clients.push(client);
  const transport=new StreamableHTTPClientTransport(new URL(r.origin+'/mcp'),{
   requestInit:{headers:token?{authorization:`Bearer ${token}`} : {}},
   fetch:async(input,init)=>{const request=new Request(input,init);inspect?.(request);return fetch(request);},
  });
  await client.connect(transport);
  assert.equal(transport.protocolVersion,LATEST_PROTOCOL_VERSION);
  assert.equal(transport.sessionId,undefined);
  return client;
 }
 async function call(client:Client,name:string,args:Record<string,unknown>={}) {
  const result=await client.callTool({name,arguments:args});
  assert(!JSON.stringify(result).includes(CANARY),'provider credential in MCP result');
  assert(!result.isError,JSON.stringify(result));assert(result.structuredContent);
  return result.structuredContent as any;
 }
 async function rejected(client:Client,name:string,args:Record<string,unknown>,code:string) {
  const result=await client.callTool({name,arguments:args});
  assert.equal(result.isError,true);assert.equal((result.structuredContent as any)?.error.code,code);return result;
 }
 async function terminal(client:Client,id:string) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline) {
   const a=await call(client,'locker_action_get',{action_id:id});
   if(!['pending','ready','executing'].includes(a.status))return a;
   await pause(150);
  }
  throw new Error('Action did not finish: '+id);
 }
 async function decision(action:any,decision:'approve'|'deny') {
  const review=await owner('approvals/'+action.approval_id);
  return owner(`approvals/${action.approval_id}/decision`,'POST',{digest:review.digest,decision});
 }
 await owner('setup','POST',{approval_ttl:60000,quota_bytes:1024**3,retention_ms:7*86400000});
 const secret=await owner('secrets','POST',{name:'provider',value:CANARY,hosts:['api.example.com'],injection_header:'Authorization',scheme:'bearer'});
 const first=await agent('First','/mine/',secret.id),second=await agent('Second','/other/');
 for(const token of [undefined,'invalid',r.owner])await assert.rejects(()=>connect(token),{code:401});
 const seen:{method:string;version:string|null;authorization:string|null}[]=[];
 let includeCredential=true;
 const client=await connect(first.t.token,request=>{
  if(!includeCredential) {
   request.headers.delete('authorization');
   request.headers.set('mcp-session-id','claimed-authenticated-session');
  }
  if(request.method==='POST')seen.push({method:request.method,version:request.headers.get('mcp-protocol-version'),authorization:request.headers.get('authorization')});
 });
 const other=await connect(second.t.token);
 const tools=await client.listTools();
 assert.deepEqual(tools,JSON.parse(await readFile(new URL('../docs/mcp-tools.json',import.meta.url),'utf8')));
 assert.equal(tools.tools.length,9);
 const schemas=new AjvJsonSchemaValidator();
 for(const tool of tools.tools) {
  assert.equal(tool.inputSchema.type,'object');assert.equal(tool.inputSchema.additionalProperties,false);
  assert(tool.description && tool.description.length>40);assert(tool.annotations);
  for(const annotation of ['readOnlyHint','destructiveHint','idempotentHint','openWorldHint'] as const)assert.equal(typeof tool.annotations[annotation],'boolean');
  const validate=schemas.getValidator(tool.inputSchema);
  assert.equal(validate({unexpected:true}).valid,false);
 }
 assert.equal(tools.tools.find(t=>t.name==='locker_proxy_request')!.annotations!.openWorldHint,true);
 assert.equal(tools.tools.find(t=>t.name==='locker_file_delete')!.annotations!.destructiveHint,true);
 assert(seen.length>=3);assert(seen.slice(1).every(s=>s.version===LATEST_PROTOCOL_VERSION&&s.authorization===`Bearer ${first.t.token}`));
 includeCredential=false;
 await assert.rejects(()=>client.listTools(),{code:401});
 await assert.rejects(()=>client.callTool({name:'locker_identity',arguments:{}}),{code:401});
 includeCredential=true;
 for(const method of ['GET','DELETE']) {
  const response=await fetch(r.origin+'/mcp',{method,headers:{authorization:`Bearer ${first.t.token}`,accept:'text/event-stream'}});
  assert.equal(response.status,405);assert.equal(response.headers.get('allow'),'POST');
 }
 // Supplement the real client's negotiation with malformed/raw protocol checks.
 async function rpc(body:unknown,token?:string,headers:Record<string,string>={}) {
  return fetch(r.origin+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(token?{authorization:`Bearer ${token}`} : {}),...headers},body:JSON.stringify(body)});
 }
 for(const token of [undefined,'invalid'])assert.equal((await rpc({jsonrpc:'2.0',id:1,method:'tools/list'},token)).status,401);
 const notification=await rpc({jsonrpc:'2.0',method:'notifications/initialized'},first.t.token);
 assert.equal(notification.status,202);assert.equal(await notification.text(),'');
 assert.equal((await rpc({jsonrpc:'2.0',id:1,method:'tools/list'},first.t.token,{'mcp-protocol-version':'1900-01-01'})).status,400);
 assert.equal((await rpc({jsonrpc:'2.0',id:1,method:'tools/list'},first.t.token,{origin:'https://evil.example.com'})).status,403);
 assert.equal((await rpc({jsonrpc:'2.0',id:1,method:'tools/list'},first.t.token,{accept:'text/event-stream'})).status,406);
 assert.equal((await rpc({jsonrpc:'2.0',id:1,method:'tools/list'},first.t.token,{'content-type':'text/plain'})).status,415);
 const protocolError=await (await rpc({jsonrpc:'2.0',id:1,method:'not-a-method'},first.t.token)).json() as any;
 assert.equal(protocolError.error.code,-32601);
 checked('real client negotiation, discovery, bearer on every request, and protocol responses');

 const identity=await call(client,'locker_identity');assert.equal(identity.agent.id,first.a.id);assert.equal(identity.token.expires_at,first.t.expires_at);
 assert(!JSON.stringify(identity).includes(first.t.token));
 const writeArgs={path:'/mine/binary',base64:Buffer.from([0,255,1,128,13,10,0]).toString('base64'),media_type:'application/octet-stream',create_only:true,idempotency_key:key()};
 const written=await call(client,'locker_file_write',writeArgs);assert.equal(written.status,'succeeded');
 const retry=await call(client,'locker_file_write',writeArgs);assert.equal(retry.id,written.id);
 const read=await call(client,'locker_file_read',{path:writeArgs.path});assert.equal(read.content,writeArgs.base64);assert.equal(read.revision,written.result_revision);
 const metadata=await (await http('files/metadata?path=/mine/binary',first.t.token)).json() as any;
 assert.equal(metadata.revision,read.revision);assert.equal(metadata.hash,read.hash);
 const bytes=await (await http('files/content?path=/mine/binary',first.t.token)).arrayBuffer();assert.equal(Buffer.from(bytes).toString('base64'),read.content);
 const listed=await call(client,'locker_files_list',{prefix:'/'});assert.deepEqual(listed.files.map((f:any)=>f.path),['/mine/binary']);
 assert.deepEqual((await call(other,'locker_files_list',{prefix:'/'})).files,[]);
 const secrets=await call(client,'locker_secrets_list');assert.deepEqual(secrets.secrets.map((s:any)=>s.name),['provider']);assert.deepEqual((await call(other,'locker_secrets_list')).secrets,[]);
 for(const [tool,args,code] of [
  ['locker_identity',{actor_id:second.a.id},'invalid_arguments'],
  ['locker_file_read',{path:123},'invalid_arguments'],
  ['locker_file_read',{path:'/mine/../other/key'},'invalid_path'],
  ['locker_file_read',{path:'/other/private'},'not_found_or_not_allowed'],
  ['locker_file_read',{path:'/mine/binary',owner_token:r.owner},'invalid_arguments'],
  ['locker_file_write',{...writeArgs,base64:undefined,text:'x',expected_revision:read.revision},'revision_precondition_required'],
  ['locker_action_get',{action_id:written.id,wait_seconds:21},'invalid_arguments'],
 ] as const)await rejected(client,tool,args,code);
 await rejected(other,'locker_action_get',{action_id:written.id},'not_found_or_not_allowed');
 const boundary=await call(client,'locker_file_write',{path:'/mine/inline',text:'x'.repeat(1024*1024),media_type:'text/plain',create_only:true,idempotency_key:key()});assert.equal(boundary.status,'succeeded');
 const inlineRead=await call(client,'locker_file_read',{path:'/mine/inline'});assert.equal(inlineRead.length,1024*1024);
 const tooLarge=await rejected(client,'locker_file_write',{path:'/mine/large',text:'x'.repeat(1024*1024+1),media_type:'text/plain',create_only:true,idempotency_key:key()},'inline_limit_exceeded');
 assert.match((tooLarge.structuredContent as any).error.message,/PUT \/api\/v1\/files\/content/);
 const upload=await fetch(r.origin+'/api/v1/files/content?path=/mine/http-large',{method:'PUT',headers:{authorization:`Bearer ${first.t.token}`,'if-none-match':'*','content-type':'application/octet-stream','idempotency-key':key()},body:Buffer.alloc(1024*1024+1,255)});assert(upload.ok);
 const largeRead=await rejected(client,'locker_file_read',{path:'/mine/http-large'},'inline_limit_exceeded');assert.match((largeRead.structuredContent as any).error.message,/\/api\/v1\/files\/content\?path=/);
 checked('identity, scoped files and secrets, binary bytes, strict inputs, idempotency, and 1 MiB boundary');

 const deletion=await call(client,'locker_file_delete',{path:'/mine/binary',expected_revision:read.revision,idempotency_key:key()});
 assert.equal(deletion.status,'pending');assert(deletion.approval_id && deletion.expires_at>Date.now());
 const deleteReview=await owner('approvals/'+deletion.approval_id);assert.equal(deleteReview.input.expected_revision,read.revision);assert.equal(deleteReview.target,'/mine/binary');
 assert.equal((await call(client,'locker_file_read',{path:'/mine/binary'})).revision,read.revision);
 const sendArgs={secret:'provider',url:'https://api.example.com/send',method:'POST',body_text:'send exactly this',idempotency_key:key()};
 const send=await call(client,'locker_proxy_request',sendArgs);
 assert.equal(send.status,'pending');assert.equal(captured.length,0);
 assert.equal((await call(client,'locker_action_get',{action_id:send.id,wait_seconds:1})).status,'pending');
 await rejected(other,'locker_action_get',{action_id:send.id},'not_found_or_not_allowed');
 assert.equal((await decision(deletion,'approve')).status,'ready');
 const deleted=await terminal(client,deletion.id);assert.equal(deleted.status,'succeeded');assert.equal(deleted.approval.state,'approved');
 await rejected(client,'locker_file_read',{path:'/mine/binary'},'not_found_or_not_allowed');
 assert.equal((await http('files/content?path=/mine/binary',first.t.token)).status,404);
 const history=await owner('files/revisions?path=/mine/binary');assert(history.revisions.some((revision:any)=>revision.revision===read.revision&&!revision.current));
 assert.equal((await decision(send,'approve')).status,'ready');
 const sent=await terminal(client,send.id);assert.equal(sent.status,'succeeded');assert.equal(sent.attempt.state,'succeeded');
 assert.deepEqual(captured,[{path:'/send',authorization:'Bearer '+CANARY,body:'send exactly this'}]);
 const result=await call(client,'locker_action_result',{action_id:send.id});
 assert.equal(result.result.upstream_status,201);assert.equal(Buffer.from(result.result.body_base64,'base64').toString(),'echo [REDACTED]');
 assert(!result.result.headers['set-cookie']);
 const httpResponse=await http(`actions/${send.id}/result`,first.t.token);
 const {request_id:httpRequestId,...httpResult}=await httpResponse.json() as any;
 const {request_id:mcpRequestId,...mcpResult}=result.result;
 assert.equal(httpRequestId,httpResponse.headers.get('x-request-id'));
 assert.equal(mcpRequestId,result.request_id);
 assert.deepEqual(mcpResult,httpResult);
 await rejected(other,'locker_action_result',{action_id:send.id},'not_found_or_not_allowed');
 const replay=await call(client,'locker_proxy_request',sendArgs);assert.equal(replay.id,send.id);assert.equal(replay.status,'succeeded');assert.equal(captured.length,1);
 const denied=await call(client,'locker_proxy_request',{...sendArgs,url:'https://api.example.com/denied',idempotency_key:key()});
 assert.equal((await decision(denied,'deny')).status,'denied');assert.equal((await terminal(client,denied.id)).status,'denied');
 const expiring=await call(client,'locker_proxy_request',{...sendArgs,url:'https://api.example.com/expired',idempotency_key:key()});
 const expiry=await fetch(r.origin+'/__test__/expire',{method:'POST',headers:{authorization:`Bearer ${r.control}`,'content-type':'application/json'},body:JSON.stringify({id:expiring.id})});assert(expiry.ok);
 assert.equal((await terminal(client,expiring.id)).status,'expired');
 const unknown=await call(client,'locker_proxy_request',{...sendArgs,url:'https://api.example.com/unknown',idempotency_key:key()});
 await decision(unknown,'approve');
 const uncertain=await terminal(client,unknown.id);assert.equal(uncertain.status,'unknown');assert.equal(uncertain.approval.state,'approved');
 await rejected(client,'locker_action_result',{action_id:unknown.id},'result_not_ready');
 for(let i=0;i<2;i++)assert.equal((await call(client,'locker_action_get',{action_id:unknown.id})).status,'unknown');
 assert.equal(captured.length,2);
 checked('pending deletes and sends, exact owner decisions, retained results, denial, expiry, and unknown without replay');

 const audit=await owner('audit?limit=100&action_id='+encodeURIComponent(send.id));
 assert(audit.events.some((e:any)=>e.operation==='proxy.dispatch'&&e.agent_id===first.a.id&&e.action_id===send.id));
 assert(audit.events.some((e:any)=>e.operation==='approval.decision'&&e.result==='ready'));
 assert(audit.events.some((e:any)=>e.operation==='proxy.result'&&e.result==='succeeded'));
 assert(!JSON.stringify(audit).includes(CANARY));
 const pending=await call(client,'locker_proxy_request',{...sendArgs,url:'https://api.example.com/restart-pending',idempotency_key:key()});
 await r.stop();await r.start();
 assert.equal((await call(client,'locker_action_get',{action_id:pending.id})).status,'pending');
 assert.equal((await call(client,'locker_action_get',{action_id:send.id})).status,'succeeded');
 assert.equal((await call(client,'locker_action_get',{action_id:unknown.id})).status,'unknown');
 assert.equal(captured.length,2);
 const persisted=await owner('audit?limit=100&action_id='+encodeURIComponent(send.id));
 for(const event of audit.events)assert(persisted.events.some((e:any)=>e.id===event.id));
 await owner(`agents/${first.a.id}/tokens/${first.t.id}`,'DELETE');
 await assert.rejects(()=>client.listTools(),{code:401});
 await assert.rejects(()=>client.callTool({name:'locker_identity',arguments:{}}),{code:401});
 const pendingOwner=await owner('actions/'+pending.id);assert.equal(pendingOwner.status,'invalidated');
 assert.equal((await call(other,'locker_identity')).agent.id,second.a.id);assert.equal(captured.length,2);
 assert(!r.logs().includes(CANARY));assert(!r.logs().includes(r.owner));
 checked('HTTP parity, audit evidence, restart persistence without replay, and immediate token revocation');
 console.log(`Real MCP client test passed (${checks} groups). SDK 1.32.2; protocol ${LATEST_PROTOCOL_VERSION}.`);
} finally {
 await Promise.allSettled(clients.map(client=>client.close()));
 await runtime?.dispose();
 upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));
}
