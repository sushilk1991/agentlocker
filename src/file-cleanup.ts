import { audit, auditStatement } from './audit';
import { requireOwner } from './auth';
import { all, assert, Context, NOW, settings, statement } from './types';

// A live action pins its staged upload. A completed read/result may pin any
// revision through result_expires_at. Current pointers protect tombstones until
// their deadline, and always protect visible files.
const eligible = (alias: string) => `${alias}.retain_until IS NOT NULL AND ${alias}.retain_until<=${NOW}
 AND NOT EXISTS(SELECT 1 FROM files f WHERE f.current_revision_id=${alias}.id AND f.deleted_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM actions a WHERE
  (a.id=${alias}.action_id AND (a.status IN('pending','ready','executing') OR COALESCE(a.result_expires_at,a.updated_at+86400000)>${NOW}))
  OR (a.result_revision=${alias}.id AND (a.status IN('pending','ready','executing') OR a.result_expires_at>${NOW})))`;

export async function storageUsage(c: Context) {
 requireOwner(c);
 const s = await settings(c);
 const rows = await all(c, `SELECT COALESCE(SUM(length),0) AS bytes,COALESCE(SUM(CASE WHEN published_at IS NULL THEN length ELSE 0 END),0) AS staged_bytes FROM file_revisions`);
 await audit(c, 'files.usage', '/', 'allow', 'read');
 return {bytes:Number(rows[0].bytes),staged_bytes:Number(rows[0].staged_bytes), quota_bytes: s.quota_bytes, retention_ms: s.retention_ms};
}

export async function cleanupFiles(c: Context, limit = 50) {
 requireOwner(c); assert(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'invalid_limit');
 const s = await settings(c); assert(!s.maintenance, 'maintenance', 503);
 const candidates = await all(c, `SELECT r.* FROM file_revisions r WHERE ${eligible('r')} ORDER BY r.retain_until,r.id LIMIT ?`, limit);
 let removed = 0;
 for (const r of candidates) {
  // Take the revision out of circulation before R2 deletion. Restores recheck
  // uploaded inside their conditional commit. Keep its bytes charged if R2 fails.
  const result = await c.env.DB.batch([
   statement(c, `UPDATE file_revisions AS r SET uploaded=0 WHERE id=? AND ${eligible('r')}
    AND EXISTS(SELECT 1 FROM settings WHERE id=1 AND maintenance=0)`, r.id),
   auditStatement(c, 'file.cleanup', '/', 'allow', 'intent', {metadata: {revision: r.id, length: r.length, hash: r.hash}}),
  ]);
  if (!result[0].meta.changes) continue;
  const references = await all(c, 'SELECT id FROM file_revisions WHERE object_key=? AND id!=?', r.object_key, r.id);
  if (!references.length) await c.env.FILES.delete(r.object_key);
  await c.env.DB.batch([
   // Keep the tombstone/path precondition even after bytes expire.
   statement(c, `DELETE FROM file_revisions WHERE id=? AND uploaded=0 AND ${eligible('file_revisions')}
    AND EXISTS(SELECT 1 FROM settings WHERE id=1 AND maintenance=0)`, r.id),
   auditStatement(c, 'file.cleanup', '/', 'allow', 'removed', {metadata: {revision: r.id, length: r.length, hash: r.hash}}),
  ]);
  removed++;
 }
 // Uploads are always reserved in D1 before R2, so abandoned reservations cover
 // interrupted uploads too. No unbounded R2 bucket scan is needed.
 return {removed};
}
