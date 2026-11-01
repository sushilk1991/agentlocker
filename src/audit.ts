import { assert, Context, LockerError, statement } from './types';

export interface AuditExtra {
 actionId?: string; approvalId?: string; attemptId?: string; batchId?: string;
 status?: number; reason?: string;
 metadata?: Record<string, string | number | boolean | null>;
}

// Only summaries belong here. Full requests and responses use encrypted action records.
const metadataFields = new Set([
 'revision', 'source_revision', 'length', 'hash', 'secret_id', 'secret_name',
 'secret_version', 'method', 'hostname', 'digest', 'upstream_status',
 'original_request_id', 'decision_request_id', 'version', 'expires_at',
]);

export function auditStatement(c: Context, operation: string, target: string, decision: string, result: string, extra: AuditExtra = {}) {
 for (const value of [operation, decision, result, extra.reason ?? result]) {
  assert(/^[a-zA-Z0-9_.-]{1,100}$/.test(value), 'invalid_audit_field');
 }
 const metadata = extra.metadata ?? {};
 for (const [key, value] of Object.entries(metadata)) {
  assert(metadataFields.has(key), 'invalid_audit_metadata');
  assert(value === null || typeof value === 'boolean' ||
   (typeof value === 'number' && Number.isFinite(value)) ||
   (typeof value === 'string' && value.length <= 256), 'invalid_audit_metadata');
 }
 assert(target.length <= 1024 && !/[\p{Cc}]/u.test(target) && !target.includes('://'), 'invalid_audit_target');
 const serialized = JSON.stringify([c.requestId, c.actor, operation, target, decision, result, extra]);
 assert(!/al_[0-9a-f]{64}|Bearer\s+/i.test(serialized), 'sensitive_audit_field');
 for (const secret of [c.env.OWNER_TOKEN, c.env.LOCKER_ENCRYPTION_KEY, c.env.PREVIOUS_ENCRYPTION_KEY]) {
  assert(!secret || !serialized.includes(secret), 'sensitive_audit_field');
 }
 return statement(c, `INSERT INTO audit_events(request_id,action_id,approval_id,attempt_id,batch_id,actor_kind,agent_id,token_id,actor_name,operation,target,decision,result,http_status,reason_code,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  c.requestId, extra.actionId, extra.approvalId, extra.attemptId, extra.batchId,
  c.actor.kind, c.actor.agentId, c.actor.tokenId, c.actor.name, operation, target,
  decision, result, extra.status, extra.reason ?? result, JSON.stringify(metadata));
}

export async function audit(c: Context, operation: string, target: string, decision: string, result: string, extra: AuditExtra = {}) {
 const entry = auditStatement(c, operation, target, decision, result, extra);
 try { await entry.run(); }
 catch { throw new LockerError('audit_unavailable', 503); }
}
