import { Context, LockerError, statement } from './types';

// D1 batches roll back on constraint failure. Check changes() immediately after
// the conditional UPDATE, before any pointer, retention, or audit result changes.
export function changedOne(c: Context) {
 return [statement(c, 'INSERT INTO file_commit_guard(ok) VALUES(changes())'),
  statement(c, 'DELETE FROM file_commit_guard')];
}
export function storageError(error: unknown): never {
 if (error instanceof LockerError) throw error;
 const message = String(error);
 if (message.includes('quota_exceeded')) throw new LockerError('quota_exceeded', 429);
 if (message.includes('pending_limit')) throw new LockerError('pending_limit', 429);
 if (message.includes('file_commit_conflict')) throw new LockerError('revision_or_policy_conflict', 409);
 throw new LockerError('storage_unavailable', 503);
}
