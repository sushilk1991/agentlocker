import { all, assert, Context, LIMITS, NOW, one, Row } from './types';
import { active, requireFolder, requireOwner } from './auth';
import { audit } from './audit';
import { base64, bounded, canonical, open, path, seal, sha, unbase64 } from './security';
export { submitRestore as restore } from './file-actions';

export async function current(c: Context, p: string) {
 return one(c, `SELECT f.*,r.length,r.hash,r.media_type,r.object_key,r.agent_id,r.token_id,r.author_kind
  FROM files f JOIN file_revisions r ON r.id=f.current_revision_id
  WHERE f.path=? AND f.deleted_at IS NULL AND r.uploaded=1`, p);
}
export function fileMetadata(f: Row) {
 return {path: f.path, revision: f.current_revision_id, length: f.length, hash: f.hash,
  media_type: f.media_type, agent_id: f.agent_id, token_id: f.token_id,
  author_kind: f.author_kind, modified_at: f.modified_at, deleted_at: f.deleted_at ?? null};
}
export async function visibleFile(c: Context, p: string) {
 path(p); await requireFolder(c, p, 'read');
 const f = await current(c, p); assert(f, 'not_found_or_not_allowed', 404);
 await audit(c, 'file.metadata', p, 'allow', 'read', {metadata: {revision: f.current_revision_id, length: f.length, hash: f.hash}});
 return f;
}

// Internal content reader. Public callers must first enforce current-file or
// owner/history access. No route accepts an arbitrary agent revision ID.
export async function fileBytes(c: Context, revision: string, limit = LIMITS.file) {
 const r = await one(c, 'SELECT * FROM file_revisions WHERE id=? AND uploaded=1', revision);
 assert(r, 'content_unavailable', 503);
 assert(r.length <= limit, 'too_large', 413, 'Use the authenticated HTTP content endpoint for files above 1 MiB.');
 const obj = await c.env.FILES.get(r.object_key); assert(obj, 'content_unavailable', 503);
 const data = await bounded(obj.body as ReadableStream<Uint8Array>, limit);
 assert(data.length === r.length && await sha(data) === r.hash, 'content_integrity_error', 503);
 return {r, data};
}
export async function readFile(c: Context, p: string, limit = LIMITS.file) {
 path(p); await requireFolder(c, p, 'read');
 const f = await current(c, p); assert(f, 'not_found_or_not_allowed', 404);
 await audit(c, 'file.read', p, 'allow', 'intent', {metadata: {revision: f.current_revision_id}});
 const result = await fileBytes(c, f.current_revision_id, limit);
 // A credential revoked during the R2 read must not receive its bytes.
 await requireFolder(c, p, 'read');
 await audit(c, 'file.read', p, 'allow', 'read', {metadata: {revision: result.r.id, length: result.r.length, hash: result.r.hash}});
 return result;
}
export function download(data: Uint8Array, r: Row) {
 return new Response(data as Uint8Array<ArrayBuffer>, {headers: {
  'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="locker-file"',
  etag: '"' + r.id + '"', 'x-content-sha256': r.hash, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
 }});
}
export const pageLimit = (limit: number) => assert(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'invalid_limit');
const identity = (c: Context) => c.actor.kind === 'owner' ? 'owner' : `agent:${c.actor.agentId}`;

export async function listFiles(c: Context, prefix: string, limit = 50, cursor?: string, tombstones = false) {
 path(prefix, true); pageLimit(limit); await active(c);
 if (tombstones) requireOwner(c);
 const version = await one(c, 'SELECT config_version FROM settings WHERE id=1');
 let after = '';
 if (cursor) {
  try {
   assert(cursor.length <= 8192, 'invalid_cursor');
   const envelope = JSON.parse(new TextDecoder().decode(unbase64(cursor)));
   const value = JSON.parse(await open(c.env, 'files.cursor', identity(c), 1, envelope.cipher, envelope.nonce, envelope.keyVersion));
   assert(value.prefix === prefix && value.version === version?.config_version && value.tombstones === tombstones, 'invalid_cursor');
   after = path(value.after);
  } catch { assert(false, 'invalid_cursor'); }
 }
 const gs = c.actor.kind === 'owner' ? null : (await all(c, `SELECT prefix FROM folder_grants
  WHERE agent_id=? AND read=1 AND (expires_at IS NULL OR expires_at>${NOW})`, c.actor.agentId)).map(x => x.prefix);
 const condition = gs?.length ? ' AND (' + gs.map(() => 'substr(f.path,1,length(?))=?').join(' OR ') + ')' : gs ? ' AND 0' : '';
 const rows = await all(c, `SELECT f.*,r.length,r.hash,r.media_type,r.agent_id,r.token_id,r.author_kind
  FROM files f LEFT JOIN file_revisions r ON r.id=f.current_revision_id
  WHERE ${tombstones ? '(f.deleted_at IS NOT NULL OR r.uploaded=1)' : 'r.uploaded=1 AND f.deleted_at IS NULL'}
  AND substr(f.path,1,length(?))=? AND f.path>? ${condition} ORDER BY f.path LIMIT ?`,
 prefix, prefix, after, ...(gs?.flatMap(g => [g,g]) ?? []), limit + 1);
 const next = rows.length > limit ? base64(new TextEncoder().encode(JSON.stringify(await seal(c.env, 'files.cursor', identity(c), 1,
  canonical({prefix, after: rows[limit - 1].path, version: version?.config_version, tombstones}))))) : null;
 await active(c);
 await audit(c, 'files.list', prefix, 'allow', 'listed');
 return {files: rows.slice(0, limit).map(fileMetadata), cursor: next};
}

export async function revisions(c: Context, p: string, limit = 50, cursor?: string) {
 requireOwner(c); path(p); pageLimit(limit);
 let created = Number.MAX_SAFE_INTEGER, after = '';
 if (cursor) {
  try {
   assert(cursor.length <= 8192, 'invalid_cursor');
   const envelope = JSON.parse(new TextDecoder().decode(unbase64(cursor)));
   const value = JSON.parse(await open(c.env, 'files.revisions.cursor', p, 1, envelope.cipher, envelope.nonce, envelope.keyVersion));
   assert(Number.isSafeInteger(value.created) && typeof value.after === 'string', 'invalid_cursor');
   created = value.created; after = value.after;
  } catch { assert(false, 'invalid_cursor'); }
 }
 const rows = await all(c, `SELECT r.id AS revision,r.hash,r.length,r.media_type,r.author_kind,r.agent_id,r.token_id,
  r.created_at,r.retain_until AS restore_deadline,(r.id=f.current_revision_id AND f.deleted_at IS NULL) AS current
  FROM file_revisions r JOIN files f ON f.id=r.file_id WHERE f.path=? AND r.uploaded=1 AND r.published_at IS NOT NULL
  AND (r.retain_until IS NULL OR r.retain_until>${NOW}) AND (r.created_at<? OR (r.created_at=? AND r.id<?))
  ORDER BY r.created_at DESC,r.id DESC LIMIT ?`, p, created, created, after, limit + 1);
 const last = rows[limit - 1];
 const next = rows.length > limit ? base64(new TextEncoder().encode(JSON.stringify(await seal(c.env, 'files.revisions.cursor', p, 1,
  canonical({created: last.created_at, after: last.revision}))))) : null;
 await audit(c, 'file.revisions', p, 'allow', 'listed');
 return {revisions: rows.slice(0, limit), cursor: next};
}
export async function retainedContent(c: Context, id: string) {
 requireOwner(c);
 const r = await one(c, `SELECT r.*,f.path FROM file_revisions r JOIN files f ON f.id=r.file_id WHERE r.id=?
  AND r.uploaded=1 AND r.published_at IS NOT NULL AND (r.retain_until IS NULL OR r.retain_until>${NOW})`, id);
 assert(r, 'not_found_or_not_allowed', 404);
 await audit(c, 'file.revision.read', r.path, 'allow', 'intent', {metadata: {revision: id}});
 const result = await fileBytes(c, id);
 await audit(c, 'file.revision.read', r.path, 'allow', 'read', {metadata: {revision: id, length: r.length, hash: r.hash}});
 return result;
}
