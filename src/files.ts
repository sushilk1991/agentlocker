import { all, assert, Context, LIMITS, NOW, one, opaqueId, Row, settings, statement } from './types';
import { audit, auditStatement, folderAllowed, requireFolder } from './auth';
import { base64, bounded, bytes, matches, path, sha } from './security';
export async function current(c: Context,p: string) {return one(c,'SELECT f.*,r.length,r.hash,r.media_type,r.object_key,r.agent_id,r.token_id,r.author_kind FROM files f JOIN file_revisions r ON r.id=f.current_revision_id WHERE f.path=? AND f.deleted_at IS NULL',p);}
export async function visibleFile(c: Context,p: string) {path(p);await requireFolder(c,p,'read');const f=await current(c,p);assert(f,'not_found_or_not_allowed',404);return f;}
export function fileMetadata(f: Row) {return {path:f.path,revision:f.current_revision_id,length:f.length,hash:f.hash,media_type:f.media_type,agent_id:f.agent_id,token_id:f.token_id,author_kind:f.author_kind,modified_at:f.modified_at};}
export async function fileBytes(c: Context,revision: string,limit=LIMITS.file) {
 const r=await one(c,'SELECT * FROM file_revisions WHERE id=? AND uploaded=1',revision);assert(r,'content_unavailable',503);assert(r.length<=limit,'too_large',413,'Use the authenticated HTTP content endpoint for files above 1 MiB.');
 const obj=await c.env.FILES.get(r.object_key);assert(obj,'content_unavailable',503);const data=await bounded(obj.body as ReadableStream<Uint8Array>,limit);assert(data.length===r.length&&await sha(data)===r.hash,'content_integrity_error',503);return {r,data};
}
export function download(data: Uint8Array,r: Row) {return new Response(data as Uint8Array<ArrayBuffer>,{headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="locker-file"','etag':'"'+r.id+'"','x-content-sha256':r.hash,'x-content-type-options':'nosniff'}});}
export async function listFiles(c: Context,prefix: string,limit: number,cursor?: string) {
 path(prefix,true);let after='';if(cursor){try{const x=JSON.parse(atob(cursor));assert(x.prefix===prefix && typeof x.after==='string','invalid_cursor');after=path(x.after);}catch{assert(false,'invalid_cursor');}}
 const gs=c.actor.kind==='owner'?null:(await all(c,`SELECT prefix FROM folder_grants WHERE agent_id=? AND read=1 AND (expires_at IS NULL OR expires_at>${NOW})`,c.actor.agentId)).map(x=>x.prefix);
 const condition=gs?.length?' AND ('+gs.map(()=> 'substr(f.path,1,length(?))=?').join(' OR ')+')':gs?' AND 0':'';
 const args=gs?.flatMap(g=>[g,g])||[];
 const rows=await all(c,`SELECT f.*,r.length,r.hash,r.media_type,r.agent_id,r.token_id,r.author_kind FROM files f JOIN file_revisions r ON r.id=f.current_revision_id WHERE f.deleted_at IS NULL AND substr(f.path,1,length(?))=? AND f.path>? ${condition} ORDER BY f.path LIMIT ?`,prefix,prefix,after,...args,limit+1);
 const next=rows.length>limit?rows[limit-1].path:null;
 return {files:rows.slice(0,limit).map(fileMetadata),cursor:next?btoa(JSON.stringify({prefix,after:next})):null};
}
export async function stage(c: Context,actionId: string,p: string,data: Uint8Array,mediaType: string) {
 assert(data.length<=LIMITS.file,'too_large',413);assert(mediaType.length<=200&&!/[\r\n]/.test(mediaType),'invalid_media_type');
 const s=await settings(c),fileId=(await one(c,'SELECT id FROM files WHERE path=?',p))?.id||opaqueId(),id=opaqueId(),objectKey=`staged/${actionId}/${id}`,hash=await sha(data);
 await c.env.DB.batch([
 statement(c,`INSERT OR IGNORE INTO files(id,path,created_at,modified_at) VALUES(?,?,${NOW},${NOW})`,fileId,p),
 statement(c,`INSERT INTO file_revisions(id,file_id,object_key,hash,length,media_type,author_kind,agent_id,token_id,action_id,created_at,retain_until) SELECT ?,id,?,?,?,?,?,?,?,?,${NOW},${NOW}+86400000 FROM files WHERE path=?`,id,objectKey,hash,data.length,mediaType,c.actor.kind,c.actor.agentId,c.actor.tokenId,actionId,p),
 auditStatement(c,'file.stage',p,'allow','reserved',{actionId,metadata:{revision:id,length:data.length,hash}})
 ]);
 await c.env.FILES.put(objectKey,data);await statement(c,'UPDATE file_revisions SET uploaded=1 WHERE id=?',id).run();
 return {revision:id,hash,length:data.length,media_type:mediaType,file_id:fileId,retain_ms:s.retention_ms};
}
export async function restore(c: Context,id: string,expected: string|null) {
 const r=await one(c,'SELECT r.*,f.path,f.current_revision_id FROM file_revisions r JOIN files f ON f.id=r.file_id WHERE r.id=? AND r.uploaded=1 AND (r.retain_until IS NULL OR r.retain_until>CAST(unixepoch(\'subsec\')*1000 AS INTEGER))',id);assert(r,'not_found_or_not_allowed',404);assert(r.current_revision_id===expected,'revision_conflict',409);
 const {data}=await fileBytes(c,id),newId=opaqueId(),s=await settings(c),key=`files/${r.file_id}/${newId}`;
 await statement(c,`INSERT INTO file_revisions(id,file_id,object_key,hash,length,media_type,author_kind,created_at,retain_until) VALUES(?,?,?,?,?,?,'owner',${NOW},${NOW}+86400000)`,newId,r.file_id,key,r.hash,r.length,r.media_type).run();
 await c.env.FILES.put(key,data);
 const result=await c.env.DB.batch([
 statement(c,`UPDATE files SET current_revision_id=?,deleted_at=NULL,modified_at=${NOW} WHERE id=? AND current_revision_id IS ?`,newId,r.file_id,expected),
 statement(c,`UPDATE file_revisions SET uploaded=1,retain_until=NULL WHERE id=? AND EXISTS(SELECT 1 FROM files WHERE current_revision_id=?)`,newId,newId),
 statement(c,`UPDATE file_revisions SET retain_until=${NOW}+? WHERE id=? AND EXISTS(SELECT 1 FROM files WHERE current_revision_id=?)`,s.retention_ms,expected,newId),
 auditStatement(c,'file.restore',r.path,'allow','restored',{metadata:{revision:newId,source_revision:id,length:r.length,hash:r.hash}})
 ]);assert(result[0].meta.changes===1,'revision_conflict',409);return {revision:newId,path:r.path,hash:r.hash};
}
