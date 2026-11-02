import { staticAsset } from './web';
import { handleMcp } from './mcp';
import { ownerSession, setupOwner, listAgents, agentGrants, overview } from './owner';
import { patchSettings, readPolicy, readSettings, replacePolicy } from './owner-config';
import { readAudit, exportAudit } from './audit-query';
import { createAgent, issueToken, replaceGrants, revokeToken, setAgentStatus } from './agents';
import { authenticate, checkSchema, identity, rate, ready, requireOwner } from './auth';
import { audit } from './audit';
import { submitWrite, submitDelete, submitRestore, idempotencyKey } from './file-actions';
import { actionResult, approvalContent, batchDecision, decideApproval, executeAction, getAction, listActions, listApprovals, ownerAction, reviewApproval, sweepActions, waitForAction } from './approvals';
import { submitProxy } from './proxy';
import { disableSecret, gateSecretList, listSecrets, saveSecret } from './secrets';
import { cleanupFiles } from './file-cleanup';
import { gateFileRead } from './file-read-actions';
import { download, fileMetadata, listFiles, pageLimit, readFile, retainedContent, revisions, visibleFile } from './files';
import { bounded, path, sha, validateConfig } from './security';
import { assert, Context, Env, json, LIMITS, LockerError, opaqueId, TERMINAL, one, settings } from './types';

function precondition(request: Request, create: boolean) {
 const match = request.headers.get('if-match'), none = request.headers.get('if-none-match');
 if (create && none === '*' && match === null) return null;
 assert(none === null && match !== null && /^"[^"\s]{1,100}"$/.test(match), 'revision_precondition_required');
 return match.slice(1, -1);
}
function query(url: URL, allowed: string[]) {
 for (const key of url.searchParams.keys()) assert(allowed.includes(key) && url.searchParams.getAll(key).length === 1, 'invalid_query');
}
function actionResponse(c: Context, action: {status: string}) {
 const unfinished = !TERMINAL.has(action.status);
 const response = json({request_id: c.requestId, ...action}, unfinished ? 202 : 200);
 if (unfinished) response.headers.set('retry-after', '2');
 return response;
}
async function bodyJson(request: Request,allowed?: string[]) {
 assert(request.headers.get('content-type')?.split(';')[0]==='application/json','invalid_content_type');
 let value;
 try {value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bounded(request.body,128*1024)));}
 catch(error) {if(error instanceof LockerError)throw error;throw new LockerError('invalid_json');}
 assert(value&&typeof value==='object'&&!Array.isArray(value)&&(!allowed||Object.keys(value).every(k=>allowed.includes(k))),'invalid_input');
 return value;
}
function dispatch(c: Context,id: string) {
 c.ctx.waitUntil(executeAction({...c,actor:{kind:'owner',name:'System'}},id).catch(()=>{}));
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext) {
 const url = new URL(request.url);
 const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
 if (url.protocol === 'http:' && !local) {
  url.protocol = 'https:';
  return Response.redirect(url.href, 308);
 }
 const c: Context = {env, ctx, actor: {kind: 'anonymous', name: 'Anonymous'}, requestId: opaqueId()};
 let target = '/', operation = 'files.request';
 let response: Response;
 try {
  if (url.pathname === '/healthz' && request.method === 'GET') return new Response('ok');
  const asset = await staticAsset(request,env);
  if (asset) return asset;
  validateConfig(env);
  if(url.pathname==='/mcp') {
   operation='mcp.request';target='/mcp';query(url,[]);
   c.actor=await authenticate(c,request,false);
   await ready(c);
   await rate(c,`token:${c.actor.tokenId}`,'file',120);
   await rate(c,`agent:${c.actor.agentId}`,'file',240);
   return secureResponse(await handleMcp(c,request),c);
  }
  assert(url.pathname.startsWith('/api/v1/'), 'not_found', 404);
  const owner = url.pathname.startsWith('/api/v1/owner/');
  c.actor = await authenticate(c, request, owner);
  const route = owner ? url.pathname.replace('/api/v1/owner', '') : url.pathname.replace('/api/v1', '');
  if(owner && (route==='/session'||route==='/setup')) {
   query(url,[]); operation=route==='/session'?'owner.session':'owner.setup';
   if(route==='/session' && request.method==='GET') response=json({request_id:c.requestId,...await ownerSession(c)});
   else if(route==='/setup' && request.method==='POST') response=json({request_id:c.requestId,...await setupOwner(c,await bodyJson(request,['approval_ttl','quota_bytes','retention_ms']),request.headers.get('idempotency-key')!)});
   else throw new LockerError('method_not_allowed',405);
   return secureResponse(response,c);
  }
  // Settings remain available to the owner so maintenance can be turned off.
  if(owner && route==='/settings') {
   await checkSchema(c);assert((await settings(c)).setup_complete,'setup_required',503);
  } else await ready(c);
  if (c.actor.kind === 'agent') {
   await rate(c, `token:${c.actor.tokenId}`, 'file', 120);
   await rate(c, `agent:${c.actor.agentId}`, 'file', 240);
   if (request.method !== 'GET') await rate(c, `agent:${c.actor.agentId}`, 'mutation', 20);
  }
  if(!owner && route==='/whoami' && request.method==='GET') {
   query(url,[]);operation='identity.read';response=json({request_id:c.requestId,...await identity(c)});
  } else if(!owner && route==='/actions' && request.method==='GET') {
   query(url,['cursor','limit']);operation='actions.list';
   response=json({request_id:c.requestId,...await listActions(c,Number(url.searchParams.get('limit')??50),url.searchParams.get('cursor')??undefined)});
  } else if(owner && route==='/policy' && request.method==='GET') {
   query(url,[]);operation='policy.read';response=json({request_id:c.requestId,...await readPolicy(c)});
  } else if(owner && route==='/policy' && request.method==='PUT') {
   query(url,[]);operation='policy.update';const input=await bodyJson(request,['expected_version','rules']);
   response=json({request_id:c.requestId,...await replacePolicy(c,input.expected_version,input.rules,request.headers.get('idempotency-key')!)});
  } else if(owner && route==='/settings' && request.method==='GET') {
   query(url,[]);operation='settings.read';response=json({request_id:c.requestId,...await readSettings(c)});
  } else if(owner && route==='/settings' && request.method==='PATCH') {
   query(url,[]);operation='settings.update';const {expected_version,...input}=await bodyJson(request,['expected_version','approval_ttl','quota_bytes','retention_ms','maintenance']);
   response=json({request_id:c.requestId,...await patchSettings(c,expected_version,input,request.headers.get('idempotency-key')!)});
  } else if(owner && route==='/overview' && request.method==='GET') {
   query(url,['cursor','pending_version']);operation='owner.overview';
   response=json({request_id:c.requestId,...await overview(c,Number(url.searchParams.get('cursor')??0))});
  } else if(owner && route==='/agents' && request.method==='GET') {
   query(url,[]);operation='agents.list';response=json({request_id:c.requestId,...await listAgents(c)});
  } else if(owner && route==='/agents' && request.method==='POST') {
   query(url,[]);operation='agent.create';idempotencyKey(request.headers.get('idempotency-key')!);const input=await bodyJson(request,['name','description']);
   response=json({request_id:c.requestId,...await createAgent(c,input.name,input.description)},201);
  } else if(owner && /^\/agents\/[^/]+$/.test(route) && request.method==='PATCH') {
   query(url,[]);operation='agent.status';idempotencyKey(request.headers.get('idempotency-key')!);const input=await bodyJson(request,['name','description','status']);
   assert(Object.keys(input).length,'invalid_input');const id=route.split('/')[2];
   const a=await one(c,'SELECT status FROM agents WHERE id=?',id);assert(a,'not_found',404);
   await setAgentStatus(c,id,input.status??a.status,input);response=json({request_id:c.requestId,updated:true});
  } else if(owner && /^\/agents\/[^/]+\/tokens$/.test(route) && request.method==='POST') {
   query(url,[]);operation='token.create';idempotencyKey(request.headers.get('idempotency-key')!);const input=await bodyJson(request,['label','lifetime_ms']);
   response=json({request_id:c.requestId,...await issueToken(c,route.split('/')[2],input.label,input.lifetime_ms)},201);
  } else if(owner && /^\/agents\/[^/]+\/tokens\/[^/]+$/.test(route) && request.method==='DELETE') {
   query(url,[]);operation='token.revoke';idempotencyKey(request.headers.get('idempotency-key')!);await revokeToken(c,route.split('/')[2],route.split('/')[4]);response=json({request_id:c.requestId,revoked:true});
  } else if(owner && /^\/agents\/[^/]+\/grants$/.test(route) && request.method==='GET') {
   query(url,[]);operation='grants.read';response=json({request_id:c.requestId,...await agentGrants(c,route.split('/')[2])});
  } else if(owner && /^\/agents\/[^/]+\/grants$/.test(route) && request.method==='PUT') {
   query(url,[]);operation='grants.replace';idempotencyKey(request.headers.get('idempotency-key')!);const input=await bodyJson(request,['expected_version','folders','secrets']);
   response=json({request_id:c.requestId,...await replaceGrants(c,route.split('/')[2],input.expected_version,input.folders,input.secrets)});
  } else if(owner && route==='/audit' && request.method==='GET') {
   operation='audit.list';response=json({request_id:c.requestId,...await readAudit(c,url.searchParams)});
  } else if(owner && route==='/audit/export' && request.method==='GET') {
   operation='audit.export';response=await exportAudit(c,url.searchParams);
  } else if (route === '/proxy/requests' && request.method === 'POST' && !owner) {
   query(url,[]); operation='proxy.request';
   response=actionResponse(c,await submitProxy(c,await bodyJson(request),request.headers.get('idempotency-key')!));
  } else if(route==='/secrets' && request.method==='GET') {
   query(url,['cursor','limit']); operation='secrets.list';
   const limit=Number(url.searchParams.get('limit')??50),cursor=url.searchParams.get('cursor')??undefined;pageLimit(limit);
   const gated=await gateSecretList(c,request.headers.get('idempotency-key'),{limit,cursor});
   response=gated?actionResponse(c,gated):json({request_id:c.requestId,...await listSecrets(c,limit,cursor)});
  } else if(owner && route==='/secrets' && request.method==='POST') {
   query(url,[]); operation='secret.save'; idempotencyKey(request.headers.get('idempotency-key')!);
   response=json({request_id:c.requestId,...await saveSecret(c,await bodyJson(request) as any)},201);
  } else if(owner && /^\/secrets\/[^/]+$/.test(route) && request.method==='PUT') {
   query(url,[]); operation='secret.save'; idempotencyKey(request.headers.get('idempotency-key')!);
   const {expected_version,...input}=await bodyJson(request);
   response=json({request_id:c.requestId,...await saveSecret(c,input as any,route.split('/')[2],expected_version)});
  } else if(owner && /^\/secrets\/[^/]+\/disable$/.test(route) && request.method==='POST') {
   query(url,[]); operation='secret.disable'; idempotencyKey(request.headers.get('idempotency-key')!);
   const input=await bodyJson(request,['expected_version']);
   response=json({request_id:c.requestId,...await disableSecret(c,route.split('/')[2],input.expected_version)});
  } else if(owner && route==='/approvals' && request.method==='GET') {
   query(url,['state','limit','offset']); operation='approvals.list';
   response=json({request_id:c.requestId,...await listApprovals(c,url.searchParams.get('state')??'pending',Number(url.searchParams.get('limit')??50),Number(url.searchParams.get('offset')??0))});
  } else if(owner && route==='/approvals/batch-decision' && request.method==='POST') {
   query(url,[]); operation='approval.decision'; idempotencyKey(request.headers.get('idempotency-key')!);
   const input=await bodyJson(request,['members','decision','reason']);
   const result=await batchDecision(c,input.members,input.decision,input.reason);
   for(const a of result.results)if('status' in a && a.status==='ready')dispatch(c,a.id);
   response=json({request_id:c.requestId,...result});
  } else if(owner && /^\/approvals\/[^/]+\/decision$/.test(route) && request.method==='POST') {
   query(url,[]); operation='approval.decision'; idempotencyKey(request.headers.get('idempotency-key')!);
   const input=await bodyJson(request,['digest','decision','reason']);
   const result=await decideApproval(c,route.split('/')[2],input.digest,input.decision,input.reason);
   if(result.status==='ready')dispatch(c,result.id);
   response=json({request_id:c.requestId,...result});
  } else if(owner && /^\/approvals\/[^/]+\/content$/.test(route) && request.method==='GET') {
   query(url,[]); operation='approval.content'; response=await approvalContent(c,route.split('/')[2]);
  } else if(owner && /^\/approvals\/[^/]+$/.test(route) && request.method==='GET') {
   query(url,[]); operation='approval.review'; response=json({request_id:c.requestId,...await reviewApproval(c,route.split('/')[2])});
  } else if (route === '/files' && request.method === 'GET') {
   query(url, ['prefix','cursor','limit']);
   target = path(url.searchParams.get('prefix') ?? '/', true); operation = 'files.list';
   const limit = Number(url.searchParams.get('limit') ?? 50); pageLimit(limit);
   const cursor = url.searchParams.get('cursor') ?? undefined;
   const gated = await gateFileRead(c, 'files.list', target, request.headers.get('idempotency-key'), {limit, cursor});
   response = gated ? actionResponse(c, gated) : json({request_id: c.requestId, ...await listFiles(c, target, limit, cursor, owner)});
  } else if (route === '/files/metadata' && request.method === 'GET') {
   query(url, ['path']); target = path(url.searchParams.get('path')!); operation = 'file.metadata';
   const gated = await gateFileRead(c, 'file.read', target, request.headers.get('idempotency-key'), {metadata: true});
   response = gated ? actionResponse(c, gated) : json({request_id: c.requestId, ...fileMetadata(await visibleFile(c, target))});
  } else if (route === '/files/content') {
   query(url, ['path']); target = path(url.searchParams.get('path')!);
   operation = request.method === 'GET' ? 'file.read' : request.method === 'DELETE' ? 'file.delete' : 'file.write';
   if (request.method === 'GET') {
    const gated = await gateFileRead(c, 'file.read', target, request.headers.get('idempotency-key'));
    if (gated) response = actionResponse(c, gated);
    else { const {data, r} = await readFile(c, target); response = download(data, r); }
   } else if (request.method === 'PUT') {
    const expected = precondition(request, true), key = request.headers.get('idempotency-key')!;
    const media = request.headers.get('content-type'); assert(media, 'content_type_required');
    const length = request.headers.get('content-length');
    if (length !== null) assert(/^\d+$/.test(length) && Number(length) <= LIMITS.file, 'too_large', 413);
    const data = await bounded(request.body, LIMITS.file);
    if (owner && expected !== null) assert(request.headers.get('x-confirm-content-sha256') === await sha(data), 'confirmation_required', 409);
    response = actionResponse(c, await submitWrite(c, target, data, media, expected, key));
   } else if (request.method === 'DELETE') {
    const expected = precondition(request, false)!;
    if (owner) assert(request.headers.get('x-confirm-revision') === expected, 'confirmation_required', 409);
    response = actionResponse(c, await submitDelete(c, target, expected, request.headers.get('idempotency-key')!));
   } else throw new LockerError('method_not_allowed', 405);
  } else if (owner && route === '/files/revisions' && request.method === 'GET') {
   query(url, ['path','limit','cursor']); target = path(url.searchParams.get('path')!); operation = 'file.revisions';
   response = json({request_id: c.requestId, ...await revisions(c, target, Number(url.searchParams.get('limit') ?? 50), url.searchParams.get('cursor') ?? undefined)});
  } else if (owner && /^\/files\/revisions\/[^/]+\/content$/.test(route) && request.method === 'GET') {
   query(url, []); operation = 'file.revision.read';
   const {data, r} = await retainedContent(c, route.split('/')[3]); response = download(data, r);
  } else if (owner && route === '/files/restore' && request.method === 'POST') {
   query(url, []); requireOwner(c); operation = 'file.restore';
   assert(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'invalid_content_type');
   const data = await bounded(request.body, 4096);
   let input; try { input = JSON.parse(new TextDecoder().decode(data)); } catch { throw new LockerError('invalid_json'); }
   assert(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(k => ['source_revision','expected_revision'].includes(k)) &&
    typeof input.source_revision === 'string' && (input.expected_revision === null || typeof input.expected_revision === 'string'), 'invalid_restore');
   response = actionResponse(c, await submitRestore(c, input.source_revision, input.expected_revision, request.headers.get('idempotency-key')!));
  } else if (/^\/actions\/[^/]+\/result$/.test(route) && request.method==='GET') {
   query(url,[]); operation='action.result.read'; response=await actionResult(c,route.split('/')[2]);
  } else if (/^\/actions\/[^/]+$/.test(route) && request.method === 'GET') {
   query(url, owner?['cursor','limit']:['wait_seconds']); operation = 'action.get';
   const id=route.split('/')[2];
   const result=owner?await ownerAction(c,id,url.searchParams):await waitForAction(c,await getAction(c,id),Number(url.searchParams.get('wait_seconds')??0),request.signal);
   response = json({request_id: c.requestId, ...result});
   if(!TERMINAL.has(result.status))response.headers.set('retry-after','2');
  } else throw new LockerError('not_found', 404);
 } catch (error) {
  let failure = error instanceof LockerError ? error : String(error).includes('UNIQUE constraint failed: agents.name') ? new LockerError('agent_name_exists',409) : new LockerError('storage_unavailable', 503);
  try { await audit(c, operation, target, 'deny', failure.code, {status: failure.status}); }
  catch { failure = new LockerError('audit_unavailable', 503); }
  response = json({error: {code: failure.code, message: failure.message}, request_id: c.requestId}, failure.status);
  if (failure.status === 429) response.headers.set('retry-after', '60');
 }
 return secureResponse(response,c);
}

function secureResponse(response: Response,c: Context) {
 response.headers.set('cache-control', 'no-store');
 response.headers.set('x-content-type-options', 'nosniff');
 response.headers.set('referrer-policy','no-referrer');
 response.headers.set('content-security-policy',"default-src 'none'; frame-ancestors 'none'");
 response.headers.set('x-request-id', c.requestId);
 return response;
}

export default {
 fetch: handleRequest,
 async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
  const c: Context = {env, ctx, actor: {kind: 'owner', name: 'System'}, requestId: opaqueId()};
  validateConfig(env); await ready(c); await sweepActions(c);
  if (new Date(controller.scheduledTime).getUTCMinutes() === 0) await cleanupFiles(c);
 },
};
