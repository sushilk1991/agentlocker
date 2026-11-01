import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { callTool, toolDefinitions } from '../src/mcp-tools';
import { database } from './helpers';
import { approve, key, setupAgent, CANARY } from './approval-helpers';
import { executeAction } from '../src/approvals';
import { saveSecret } from '../src/secrets';
import { replaceGrants } from '../src/agents';

describe('published MCP argument schemas',()=> {
 const validator=new AjvJsonSchemaValidator();
 const examples:Record<string,Record<string,unknown>>={
  locker_identity:{},locker_files_list:{prefix:'/mine/'},locker_file_read:{path:'/mine/file'},
  locker_file_write:{path:'/mine/file',text:'hi',media_type:'text/plain',create_only:true,idempotency_key:'test-key-12345678'},
  locker_file_delete:{path:'/mine/file',expected_revision:'revision',idempotency_key:'test-key-12345678'},
  locker_secrets_list:{},locker_proxy_request:{secret:'provider',url:'https://api.example.com/send',method:'GET',idempotency_key:'test-key-12345678'},
  locker_action_get:{action_id:'action'},locker_action_result:{action_id:'action'},
 };
 for(const tool of toolDefinitions())it(`${tool.name} accepts its example and rejects extra arguments`,()=> {
  const validate=validator.getValidator(tool.inputSchema);
  expect(validate(examples[tool.name]).valid).toBe(true);
  expect(validate({...examples[tool.name],actor_id:'forged'}).valid).toBe(false);
 });
 it('describes exclusive content, revision preconditions, and the proxy body',()=> {
  const write=validator.getValidator(toolDefinitions().find(t=>t.name==='locker_file_write')!.inputSchema),a=examples.locker_file_write;
  expect(write({...a,base64:'YQ=='}).valid).toBe(false);
  expect(write({...a,expected_revision:'revision'}).valid).toBe(false);
  const {text,...noContent}=a;expect(write(noContent).valid).toBe(false);
  const proxy=validator.getValidator(toolDefinitions().find(t=>t.name==='locker_proxy_request')!.inputSchema);
  expect(proxy({...examples.locker_proxy_request,body_text:'a',body_base64:'YQ=='}).valid).toBe(false);
 });
});

describe('MCP calls use the shared D1/R2 policy and approval services',()=> {
 let f:Awaited<ReturnType<typeof database>>,agent:Awaited<ReturnType<typeof setupAgent>>,other:Awaited<ReturnType<typeof setupAgent>>;
 beforeAll(async()=>{f=await database();agent=await setupAgent(f);other=await setupAgent(f,false);});
 afterAll(async()=>{await f?.runtime.dispose();});
 async function call(name:string,input:Record<string,unknown>,c=agent.c) {
  const result=await callTool(c,name,input);
  expect(result).not.toHaveProperty('isError',true);
  return result.structuredContent as any;
 }
 it('does not reflect rejected arguments, and records the attempted tool and path',async()=> {
  const bad=await callTool(agent.c,'locker_identity',{provider_key:CANARY});
  expect(bad).toMatchObject({isError:true,structuredContent:{error:{code:'invalid_arguments'}}});
  expect(JSON.stringify(bad)).not.toContain(CANARY);
  const denied=await callTool(agent.c,'locker_file_read',{path:'/outside/private'});
  expect(denied).toMatchObject({isError:true,structuredContent:{error:{code:'not_found_or_not_allowed'}}});
  const event=await f.db.prepare("SELECT * FROM audit_events WHERE operation='mcp.locker_file_read' AND decision='deny' ORDER BY id DESC LIMIT 1").first<any>();
  expect(event).toMatchObject({agent_id:agent.a.id,token_id:agent.t.id,target:'/outside/private'});
 });
 it('requires approval for replacement and returns the exact completed file revision',async()=> {
  const initial=await call('locker_file_write',{path:'/mine/replace',text:'before',media_type:'text/plain',create_only:true,idempotency_key:key()});
  const replacement=await call('locker_file_write',{path:'/mine/replace',base64:'AP+A',media_type:'application/octet-stream',expected_revision:initial.result_revision,idempotency_key:key()});
  expect(replacement.status).toBe('pending');
  expect((await call('locker_file_read',{path:'/mine/replace'})).content).toBe(btoa('before'));
  await approve(f,replacement);await executeAction(f.context(),replacement.id);
  const status=await call('locker_action_get',{action_id:replacement.id});expect(status.status).toBe('succeeded');
  const read=await call('locker_file_read',{path:'/mine/replace'});expect(read).toMatchObject({content:'AP+A',revision:status.result_revision,length:3});
 });
 it('bounds decoded bytes for base64 and UTF-8 and gives the HTTP alternative for oversized strings',async()=> {
  const input={path:'/mine/oversized',media_type:'application/octet-stream',create_only:true,idempotency_key:key()};
  for(const content of [{base64:Buffer.alloc(1024*1024+1).toString('base64')},{text:'😀'.repeat(262145)},{text:'x'.repeat(2*1024*1024)}]) {
   const result=await callTool(agent.c,'locker_file_write',{...input,...content});
   expect(result).toMatchObject({isError:true,structuredContent:{error:{code:'inline_limit_exceeded',status:413,message:expect.stringContaining('/api/v1/files/content')}}});
  }
  const malformed=await callTool(agent.c,'locker_file_write',{...input,base64:'not%base64'});
  expect(malformed).toMatchObject({isError:true,structuredContent:{error:{code:'invalid_base64'}}});
  const count=await f.db.prepare("SELECT COUNT(*) AS count FROM actions WHERE target='/mine/oversized'").first<any>();expect(count.count).toBe(0);
 });
 it('waits on gated reads, preserves binary results, and gives the HTTP result route above the inline limit',async()=> {
  const created=await call('locker_file_write',{path:'/mine/gated/file',base64:'AP+A',media_type:'application/octet-stream',create_only:true,idempotency_key:key()});
  await f.db.prepare("INSERT INTO approval_rules VALUES('mcp-read','file.read','/mine/gated/',NULL,1,0)").run();
  const input={path:'/mine/gated/file',idempotency_key:key()};
  const pending=await call('locker_file_read',input);expect(pending.status).toBe('pending');expect(pending).not.toHaveProperty('content');
  expect((await call('locker_file_read',input)).id).toBe(pending.id);
  const waiting=call('locker_action_get',{action_id:pending.id,wait_seconds:2});
  await approve(f,pending);await executeAction(f.context(),pending.id);
  expect((await waiting).status).toBe('succeeded');
  const result=await call('locker_action_result',{action_id:pending.id});expect(result).toMatchObject({content:'AP+A',revision:created.result_revision,length:3,encoding:'base64'});
  // Stage through the HTTP-sized service to test a large approved result.
  const {submitWrite}=await import('../src/file-actions');
  await submitWrite(f.context(),'/mine/gated/large',new Uint8Array(1024*1024+1),'application/octet-stream',null,key());
  const large=await call('locker_file_read',{path:'/mine/gated/large',idempotency_key:key()});
  await approve(f,large);await executeAction(f.context(),large.id);
  const tooLarge=await callTool(agent.c,'locker_action_result',{action_id:large.id});
  expect(tooLarge).toMatchObject({isError:true,structuredContent:{error:{code:'inline_limit_exceeded',message:expect.stringContaining(`/api/v1/actions/${large.id}/result`)}}});
 });
 it('pages only granted secret metadata and binds cursors to the agent and policy',async()=> {
  const s=await saveSecret(f.context(),{name:'z-second',value:CANARY,hosts:['api.example.com'],injection_header:'Authorization',scheme:'bearer'});
  const a=await f.db.prepare('SELECT version FROM agents WHERE id=?').bind(agent.a.id).first<any>();
  await replaceGrants(f.context(),agent.a.id,a.version,[{prefix:'/mine/',read:true,write:true,delete:true}],[{secret_id:agent.secret!.id,read:true},{secret_id:s.id,read:true}]);
  const page=await call('locker_secrets_list',{limit:1});expect(page.secrets).toHaveLength(1);expect(page.cursor).toEqual(expect.any(String));
  const next=await call('locker_secrets_list',{limit:1,cursor:page.cursor});expect(next.secrets).toHaveLength(1);expect(next.cursor).toBeNull();
  expect(next.secrets[0].id).not.toBe(page.secrets[0].id);expect(JSON.stringify([page,next])).not.toContain(CANARY);
  const denied=await callTool(other.c,'locker_secrets_list',{cursor:page.cursor});expect(denied).toMatchObject({isError:true,structuredContent:{error:{code:'invalid_cursor'}}});
  await f.db.prepare("INSERT INTO approval_rules VALUES('mcp-secret-list','secrets.list',NULL,NULL,1,0)").run();
  const input={limit:1,idempotency_key:key()},pending=await call('locker_secrets_list',input);expect(pending.status).toBe('pending');
  expect((await call('locker_secrets_list',input)).id).toBe(pending.id);
  const changed=await callTool(agent.c,'locker_secrets_list',{...input,limit:2});expect(changed).toMatchObject({isError:true,structuredContent:{error:{code:'idempotency_conflict'}}});
  await approve(f,pending);await executeAction(f.context(),pending.id);
  const result=await call('locker_action_result',{action_id:pending.id});expect(result.result.secrets).toHaveLength(1);expect(result.result.cursor).toEqual(expect.any(String));
  await f.db.prepare('UPDATE settings SET config_version=config_version+1').run();
  await f.db.prepare("DELETE FROM approval_rules WHERE id='mcp-secret-list'").run();
  const stale=await callTool(agent.c,'locker_secrets_list',{cursor:page.cursor});expect(stale).toMatchObject({isError:true,structuredContent:{error:{code:'invalid_cursor'}}});
 });
 it('ends an aborted wait without changing or discarding the pending action',async()=> {
  const input={path:'/mine/abort-wait',text:'keep this',media_type:'text/plain',create_only:true,idempotency_key:key()};
  const written=await call('locker_file_write',input);
  const pending=await call('locker_file_delete',{path:input.path,expected_revision:written.result_revision,idempotency_key:key()});
  const controller=new AbortController();
  const waiting=callTool(agent.c,'locker_action_get',{action_id:pending.id,wait_seconds:20},controller.signal);
  controller.abort();
  expect(await waiting).toMatchObject({structuredContent:{id:pending.id,status:'pending'}});
  expect(await call('locker_action_get',{action_id:pending.id})).toMatchObject({id:pending.id,status:'pending'});
  expect(await call('locker_file_read',{path:input.path})).toMatchObject({content:btoa('keep this'),revision:written.result_revision});
 });
 it('fails closed when an audit write fails before releasing a tool result',async()=> {
  await f.db.prepare("CREATE TRIGGER mcp_audit_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'test_audit_failure'); END").run();
  try {
   const result=await callTool(agent.c,'locker_identity',{});
   expect(result).toMatchObject({isError:true,structuredContent:{error:{code:'audit_unavailable',status:503}}});expect(result.structuredContent).not.toHaveProperty('grants');
  } finally {await f.db.prepare('DROP TRIGGER mcp_audit_fail').run();}
 });
});
