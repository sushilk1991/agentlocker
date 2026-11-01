import { authenticate, rate, ready, requireOwner } from './auth';
import { audit } from './audit';
import { submitWrite, submitDelete, submitRestore, fileAction } from './file-actions';
import { cleanupFiles } from './file-cleanup';
import { gateFileRead } from './file-read-actions';
import { download, fileMetadata, listFiles, pageLimit, readFile, retainedContent, revisions, visibleFile } from './files';
import { bounded, path, sha, validateConfig } from './security';
import { assert, Context, Env, json, LIMITS, LockerError, opaqueId } from './types';

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
 const response = json({request_id: c.requestId, ...action}, action.status === 'succeeded' ? 200 : 202);
 if (action.status !== 'succeeded') response.headers.set('retry-after', '2');
 return response;
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext) {
 const c: Context = {env, ctx, actor: {kind: 'anonymous', name: 'Anonymous'}, requestId: opaqueId()};
 let target = '/', operation = 'files.request';
 let response: Response;
 try {
  const url = new URL(request.url);
  if (url.pathname === '/healthz' && request.method === 'GET') return new Response('ok');
  validateConfig(env);
  assert(url.pathname.startsWith('/api/v1/'), 'not_found', 404);
  const owner = url.pathname.startsWith('/api/v1/owner/');
  c.actor = await authenticate(c, request, owner);
  await ready(c);
  if (c.actor.kind === 'agent') {
   await rate(c, `token:${c.actor.tokenId}`, 'file', 120);
   await rate(c, `agent:${c.actor.agentId}`, 'file', 240);
   if (request.method !== 'GET') await rate(c, `agent:${c.actor.agentId}`, 'mutation', 20);
  }
  const route = owner ? url.pathname.replace('/api/v1/owner', '') : url.pathname.replace('/api/v1', '');
  if (route === '/files' && request.method === 'GET') {
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
  } else if (/^\/actions\/[^/]+$/.test(route) && request.method === 'GET') {
   query(url, []); operation = 'action.get';
   response = json({request_id: c.requestId, ...await fileAction(c, route.split('/')[2])});
  } else throw new LockerError('not_found', 404);
 } catch (error) {
  let failure = error instanceof LockerError ? error : new LockerError('storage_unavailable', 503);
  try { await audit(c, operation, target, 'deny', failure.code, {status: failure.status}); }
  catch { failure = new LockerError('audit_unavailable', 503); }
  response = json({error: {code: failure.code, message: failure.message}, request_id: c.requestId}, failure.status);
  if (failure.status === 429) response.headers.set('retry-after', '60');
 }
 response.headers.set('cache-control', 'no-store');
 response.headers.set('x-content-type-options', 'nosniff');
 response.headers.set('x-request-id', c.requestId);
 return response;
}

export default {
 fetch: handleRequest,
 async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
  // File cleanup runs hourly, with a bounded batch. Other scheduled work belongs
  // to the later approvals chunk.
  if (new Date(controller.scheduledTime).getUTCMinutes() !== 0) return;
  const c: Context = {env, ctx, actor: {kind: 'owner', name: 'System'}, requestId: opaqueId()};
  validateConfig(env); await ready(c); await cleanupFiles(c);
 },
};
