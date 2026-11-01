import { auditStatement } from './audit';
import { bump, requireOwner } from './auth';
import { path, sha } from './security';
import { assert, Context, LockerError, NOW, one, opaqueId, Row, statement } from './types';

const DAY = 86400000;
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\p{Cc}]/u.test(value);

async function agent(c: Context, id: string) {
 requireOwner(c);
 const row = await one(c, 'SELECT * FROM agents WHERE id=?', id);
 assert(row, 'not_found', 404);
 return row;
}

export async function createAgent(c: Context, name: string, description = '') {
 requireOwner(c);
 assert(text(name, 100) && typeof description === 'string' && description.length <= 1000, 'invalid_agent');
 const id = opaqueId();
 await c.env.DB.batch([
  statement(c, `INSERT INTO agents(id,name,description,created_at) VALUES(?,?,?,${NOW})`, id, name, description),
  auditStatement(c, 'agent.create', id, 'allow', 'created'),
 ]);
 return {id, name, description, status: 'disabled', version: 1};
}

export async function issueToken(c: Context, agentId: string, label: string, lifetimeMs = DAY) {
 const a = await agent(c, agentId);
 assert(a.status !== 'revoked', 'agent_revoked', 409);
 assert(text(label, 100), 'invalid_token_label');
 assert(Number.isSafeInteger(lifetimeMs) && lifetimeMs > 0 && lifetimeMs <= 30 * DAY, 'invalid_token_lifetime');
 const token = 'al_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
 const id = opaqueId(), hash = await sha(token), prefix = token.slice(0, 11);
 const result = await c.env.DB.batch<Row>([
  statement(c, `INSERT INTO agent_tokens(id,agent_id,token_hash,prefix,label,created_at,expires_at)
   SELECT ?,id,?,?,?,${NOW},${NOW}+? FROM agents WHERE id=? AND status!='revoked'
   RETURNING id,agent_id,prefix,label,created_at,expires_at`, id, hash, prefix, label, lifetimeMs, agentId),
  // An id check ties the audit event to the insertion if revocation won the race.
  statement(c, `INSERT INTO audit_events(request_id,actor_kind,actor_name,operation,target,decision,result,reason_code)
   SELECT ?,'owner','Owner','token.create',?,'allow','created','created' WHERE EXISTS(SELECT 1 FROM agent_tokens WHERE id=?)`, c.requestId, id, id),
 ]);
 assert(result[0].results.length === 1, 'agent_revoked', 409);
 // The caller must deliver this response once, with Cache-Control: no-store.
 return {...result[0].results[0], token};
}

// Invalidating work is part of the same batch as changing its authority.
function invalidateStatements(c: Context, condition: string, args: string[], reason: string) {
 return [
  statement(c, `UPDATE actions SET status='invalidated',error_code=?,updated_at=${NOW},result_expires_at=${NOW}+86400000
   WHERE status IN('pending','ready') AND ${condition}`, reason, ...args),
  statement(c, `INSERT INTO audit_events(request_id,action_id,approval_id,actor_kind,actor_name,operation,target,decision,result,reason_code)
   SELECT ?,a.id,p.id,'system','System','approval.invalidated',a.target,'deny','invalidated',?
   FROM actions a JOIN approvals p ON p.action_id=a.id WHERE a.status='invalidated' AND p.state='pending'`, c.requestId, reason),
  statement(c, `UPDATE approvals SET state='invalidated',decided_at=${NOW},decision_request_id=?
   WHERE state='pending' AND action_id IN(SELECT id FROM actions WHERE status='invalidated')`, c.requestId),
 ];
}

export async function revokeToken(c: Context, agentId: string, tokenId: string) {
 await agent(c, agentId);
 assert(await one(c, 'SELECT id FROM agent_tokens WHERE id=? AND agent_id=?', tokenId, agentId), 'not_found', 404);
 await c.env.DB.batch([
  statement(c, `UPDATE agent_tokens SET revoked_at=COALESCE(revoked_at,${NOW}) WHERE id=? AND agent_id=?`, tokenId, agentId),
  ...invalidateStatements(c, 'token_id=?', [tokenId], 'credential_revoked'),
  auditStatement(c, 'token.revoke', tokenId, 'allow', 'revoked'),
 ]);
}

export async function setAgentStatus(c: Context, agentId: string, status: 'enabled' | 'disabled' | 'revoked') {
 await agent(c, agentId);
 assert(['enabled', 'disabled', 'revoked'].includes(status), 'invalid_agent_status');
 await c.env.DB.batch([
  statement(c, `UPDATE agents SET status=?,version=version+1,revoked_at=CASE WHEN ?='revoked' THEN COALESCE(revoked_at,${NOW}) ELSE revoked_at END WHERE id=?`, status, status, agentId),
  ...(status === 'revoked' ? [statement(c, `UPDATE agent_tokens SET revoked_at=COALESCE(revoked_at,${NOW}) WHERE agent_id=?`, agentId)] : []),
  ...(status !== 'enabled' ? invalidateStatements(c, 'agent_id=?', [agentId], 'agent_disabled') : []),
  auditStatement(c, 'agent.status', agentId, 'allow', status),
 ]);
}

export interface FolderGrant {prefix: string; read: boolean; write: boolean; delete: boolean; expires_at?: number | null}
export interface SecretGrant {secret_id: string; read: true; expires_at?: number | null}

export async function replaceGrants(c: Context, agentId: string, expectedVersion: number, folders: FolderGrant[], secrets: SecretGrant[]) {
 const a = await agent(c, agentId);
 assert(a.status !== 'revoked', 'agent_revoked', 409);
 assert(Number.isSafeInteger(expectedVersion) && expectedVersion >= 1, 'invalid_version');
 assert(Array.isArray(folders) && Array.isArray(secrets) && folders.length <= 100 && secrets.length <= 100, 'invalid_grants');
 const seen = new Set<string>();
 const expiry = (value: unknown) => assert(value == null || (Number.isSafeInteger(value) && Number(value) > 0), 'invalid_grant_expiry');
 for (const g of folders) {
  assert(g && typeof g === 'object', 'invalid_grant');
  path(g.prefix, true);
  assert(['read','write','delete'].every(k => typeof g[k as keyof FolderGrant] === 'boolean'), 'invalid_grant');
  expiry(g.expires_at);
  assert(!seen.has(g.prefix), 'duplicate_grant'); seen.add(g.prefix);
 }
 seen.clear();
 for (const g of secrets) {
  assert(g && typeof g.secret_id === 'string' && g.read === true, 'invalid_grant');
  expiry(g.expires_at);
  assert(!seen.has(g.secret_id), 'duplicate_grant'); seen.add(g.secret_id);
 }
 try {
  await c.env.DB.batch([
   // agent_version_step aborts the whole batch for a stale expected version.
   statement(c, 'UPDATE agents SET version=? WHERE id=?', expectedVersion + 1, agentId),
   statement(c, 'DELETE FROM folder_grants WHERE agent_id=?', agentId),
   statement(c, 'DELETE FROM secret_grants WHERE agent_id=?', agentId),
   ...folders.map(g => statement(c, `INSERT INTO folder_grants(id,agent_id,prefix,read,write,"delete",expires_at,version,created_at) VALUES(?,?,?,?,?,?,?,?,${NOW})`, opaqueId(), agentId, g.prefix, +g.read, +g.write, +g.delete, g.expires_at, expectedVersion + 1)),
   ...secrets.map(g => statement(c, `INSERT INTO secret_grants(id,agent_id,secret_id,read,expires_at,version,created_at) VALUES(?,?,?,1,?,?,${NOW})`, opaqueId(), agentId, g.secret_id, g.expires_at, expectedVersion + 1)),
   bump(c),
   // Config version is conservative: all work checked against an older policy is stale.
   ...invalidateStatements(c, 'config_version!=(SELECT config_version FROM settings WHERE id=1)', [], 'policy_changed'),
   auditStatement(c, 'grants.replace', agentId, 'allow', 'updated', {metadata: {version: expectedVersion + 1}}),
  ]);
 } catch (error) {
  if (String(error).includes('version_conflict')) throw new LockerError('version_conflict', 409);
  throw error;
 }
 return {version: expectedVersion + 1};
}
