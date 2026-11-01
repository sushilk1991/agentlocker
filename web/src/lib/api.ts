export type ActionState = 'pending' | 'ready' | 'executing' | 'succeeded' | 'failed' | 'unknown' | 'denied' | 'expired' | 'invalidated';
export interface Session {
 setup_complete: boolean; public_origin: string; approval_ttl: number; quota_bytes: number; retention_ms: number;
}
export interface Overview {
 pending_count: number; oldest_pending_at: number | null; pending_version: string; event_cursor: number;
 warnings: string[]; storage: {bytes: number; quota_bytes: number};
 audit_storage: {last_event_id: number; estimated_bytes: number};
}
export interface Approval {
 approval_id: string; id: string; agent_name: string; token_label: string; operation: string;
 target: string; status: ActionState; approval_state: 'pending' | 'approved' | 'denied' | 'expired' | 'invalidated'; created_at: number; expires_at: number;
}
export interface ReviewInput {
 [key: string]: unknown;
 operation?: string; path?: string; expected_revision?: string | null; revision?: string;
 hash?: string; length?: number; previous_hash?: string; previous_length?: number;
 secret?: string; injection_header?: string; scheme?: string; value_version?: number;
 request?: {url: string; method: string; headers: Record<string, string>; body_base64: string; body_hash: string};
}
export interface Review {
 id: string; approval_id: string; status: ActionState; operation: string; target: string; digest: string;
 created_at: number; expires_at: number; agent: {name: string; description: string}; token: {label: string; expires_at: number};
 input: ReviewInput; digest_context: {config_version: number; agent_id: string; token_id: string};
 scope: {folders: {prefix: string; expires_at: number | null; read: number; write: number; delete: number}[]; secrets: unknown[]} | null;
}
export interface DecisionResult {
 batch_id?: string; results: {approval_id: string; id?: string; status?: ActionState; error_code?: string}[];
}
export type Member = {id: string; digest: string};
export interface AgentToken {id: string; label: string; prefix: string; created_at: number; expires_at: number; revoked_at: number | null}
export interface Agent {
 id: string; name: string; description: string; status: 'enabled' | 'disabled' | 'revoked'; version: number;
 created_at: number; revoked_at: number | null; tokens: AgentToken[];
}
export interface FolderGrant {prefix: string; read: boolean; write: boolean; delete: boolean; expires_at: number | null}
export interface KeyGrant {secret_id: string; read: true; expires_at: number | null}
type StoredFolderGrant = Omit<FolderGrant, 'read' | 'write' | 'delete'> & {read: number; write: number; delete: number};
type StoredKeyGrant = Omit<KeyGrant, 'read'> & {read: number; name: string; enabled: number};
export interface AgentGrants {
 version: number; folders: StoredFolderGrant[]; secrets: StoredKeyGrant[];
 effective: {folders: StoredFolderGrant[]; secrets: StoredKeyGrant[]};
}
export interface KeyMetadata {id: string; name: string; enabled: boolean; hosts: string[]}
export interface KeyDetails extends KeyMetadata {
 version: number; value_version: number; injection_header: string; scheme: 'bearer' | 'plain'; created_at: number; updated_at: number;
 agents: {id: string; name: string; status: string; expires_at: number | null}[];
}
export interface KeyInput {name: string; hosts: string[]; injection_header: string; scheme: 'bearer' | 'plain'; enabled: boolean; value?: string}
export interface FileEntry {
 path: string; revision: string; length: number | null; hash: string | null; media_type: string | null;
 agent_id: string | null; token_id: string | null; author_kind: string | null; modified_at: number; deleted_at: number | null;
}
export interface FileRevision extends Pick<FileEntry, 'revision' | 'length' | 'hash' | 'media_type' | 'agent_id' | 'token_id' | 'author_kind'> {
 created_at: number; restore_deadline: number | null; current: number;
}
export interface FileResult {id: string; status: ActionState; result_revision: string; request_id: string}
export interface AuditEvent {
 id: number; timestamp: number; actor_name: string; actor_kind: string; operation: string; target: string;
 decision: string; result: string; reason_code: string; request_id: string; action_id: string | null;
 token_id: string | null; agent_id: string | null; approval_id: string | null; attempt_id: string | null; batch_id: string | null; metadata: string;
}
export interface Settings extends Omit<Session, 'setup_complete'> {version: number; maintenance: boolean; updated_at: number}
export interface PolicyRule {operation: 'file.read' | 'file.write' | 'files.list' | 'secrets.list'; prefix?: string | null; secret_id?: string | null}
export interface Policy {version: number; mandatory: string[]; rules: PolicyRule[]}

export class ApiError extends Error {
 readonly name = 'ApiError';
 constructor(readonly status: number, message: string, readonly code?: string, readonly requestId?: string) {
  super(message + (requestId ? ' · Request ' + requestId : ''));
 }
}

// One client per sign-in. Credentials, retry keys and request lifetimes never
// enter browser storage or Query keys. Failed mutations retain their exact key.
export class OwnerApi {
 private token: string;
 private controller = new AbortController();
 private mutationKeys = new Map<string, string>();
 constructor(token: string, private unauthorized: () => void) { this.token = token; }
 get active() { return !this.controller.signal.aborted; }
 dispose() { this.token = ''; this.controller.abort(); this.mutationKeys.clear(); }
 private async request<T>(path: string, options: {body?: unknown; bytes?: Uint8Array; headers?: Record<string, string>; signal?: AbortSignal; raw?: boolean; method?: string; action?: boolean} = {}): Promise<T> {
  const {body, bytes, signal, raw, method = 'GET'} = options;
  const digest = async (data: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)), b => b.toString(16).padStart(2, '0')).join('');
  // Retained retry signatures contain hashes only, including for failed key saves.
  const signature = method === 'GET' ? '' : await digest(new TextEncoder().encode(JSON.stringify([method, path, body, options.headers, bytes ? await digest(bytes) : null])));
  this.controller.signal.throwIfAborted();
  const headers: Record<string, string> = {authorization: 'Bearer ' + this.token, ...options.headers};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
   if (!this.mutationKeys.has(signature)) this.mutationKeys.set(signature, crypto.randomUUID());
   headers['idempotency-key'] = this.mutationKeys.get(signature)!;
  }
  const response = await fetch('/api/v1/owner/' + path, {
   method, headers, body: bytes ? bytes as Uint8Array<ArrayBuffer> : body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', redirect: 'error',
   signal: signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal,
  });
  this.controller.signal.throwIfAborted();
  if (!response.ok) {
   const data = await response.json().catch(() => null) as {error?: {message?: string; code?: string}; request_id?: string} | null;
   this.controller.signal.throwIfAborted();
   if (response.status === 401) this.unauthorized();
   const hints: Record<string, string> = {
    revision_conflict: 'The file revision has changed. Browse the folder again and review the current revision.',
    version_conflict: 'This version has changed. Reload this view and review your edits before saving.',
    invalid_cursor: 'This list has changed. Reload it from the first page.',
   };
   const code = data?.error?.code, message = data?.error?.message;
   throw new ApiError(response.status, (code && (!message || message === code.replaceAll('_', ' ')) ? hints[code] : undefined) || message || `Request failed (${response.status})`, code, data?.request_id);
  }
  const result = raw ? response : await response.json();
  this.controller.signal.throwIfAborted();
  if (options.action && result.status !== 'succeeded') throw new Error(`Action ${result.id}: ${result.status}. Check its audit history before retrying. · Request ${result.request_id}`);
  if (method !== 'GET') this.mutationKeys.delete(signature);
  return result as T;
 }
 session() { return this.request<Session>('session'); }
 setup(body: Pick<Session, 'approval_ttl' | 'quota_bytes' | 'retention_ms'>) { return this.request<Session>('setup', {method: 'POST', body}); }
 overview(cursor: number, version: string, signal: AbortSignal) { return this.request<Overview>(`overview?cursor=${cursor}&pending_version=${encodeURIComponent(version)}`, {signal}); }
 approvals(state: string, offset: number, signal: AbortSignal) { return this.request<{approvals: Approval[]}>(`approvals?state=${encodeURIComponent(state)}&limit=50&offset=${offset}`, {signal}); }
 review(id: string, signal: AbortSignal) { return this.request<Review>(`approvals/${encodeURIComponent(id)}`, {signal}); }
 async content(id: string, signal: AbortSignal) {
  const response = await this.request<Response>(`approvals/${encodeURIComponent(id)}/content`, {raw: true, signal});
  const bytes = new Uint8Array(await response.arrayBuffer());
  this.controller.signal.throwIfAborted(); signal.throwIfAborted(); return bytes;
 }
 action(id: string, signal: AbortSignal) { return this.request<{status: ActionState}>(`actions/${encodeURIComponent(id)}`, {signal}); }
 decide(members: Member[], decision: 'approve' | 'deny', reason: string) {
  return this.request<DecisionResult>('approvals/batch-decision', {method: 'POST', body: {members, decision, reason}});
 }
 revokeAgent(id: string) { return this.request<{updated: boolean}>(`agents/${encodeURIComponent(id)}`, {method: 'PATCH', body: {status: 'revoked'}}); }
 agents(signal: AbortSignal) {return this.request<{agents: Agent[]}>('agents', {signal});}
 createAgent(name: string, description: string) {return this.request<Pick<Agent, 'id' | 'name' | 'status'>>('agents', {method: 'POST', body: {name, description}});}
 setAgentStatus(id: string, status: Agent['status']) {return this.request<{updated: boolean}>(`agents/${encodeURIComponent(id)}`, {method: 'PATCH', body: {status}});}
 issueToken(id: string, label: string, lifetime_ms: number) {return this.request<AgentToken & {token: string}>(`agents/${encodeURIComponent(id)}/tokens`, {method: 'POST', body: {label, lifetime_ms}});}
 revokeToken(agentId: string, tokenId: string) {return this.request<{revoked: boolean}>(`agents/${encodeURIComponent(agentId)}/tokens/${encodeURIComponent(tokenId)}`, {method: 'DELETE'});}
 grants(id: string, signal: AbortSignal) {return this.request<AgentGrants>(`agents/${encodeURIComponent(id)}/grants`, {signal});}
 saveGrants(id: string, expected_version: number, folders: FolderGrant[], secrets: KeyGrant[]) {
  return this.request<{version: number}>(`agents/${encodeURIComponent(id)}/grants`, {method: 'PUT', body: {expected_version, folders, secrets}});
 }
 files(prefix: string, cursor: string | null, signal: AbortSignal) {return this.request<{files: FileEntry[]; cursor: string | null}>('files?' + new URLSearchParams({prefix, limit: '50', ...(cursor ? {cursor} : {})}), {signal});}
 revisions(path: string, cursor: string | null, signal: AbortSignal) {return this.request<{revisions: FileRevision[]; cursor: string | null}>('files/revisions?' + new URLSearchParams({path, limit: '50', ...(cursor ? {cursor} : {})}), {signal});}
 upload(path: string, bytes: Uint8Array, mediaType: string, revision?: string, digest?: string) {
  return this.request<FileResult>('files/content?' + new URLSearchParams({path}), {method: 'PUT', bytes, action: true, headers: {'content-type': mediaType,
   ...(revision ? {'if-match': '"' + revision + '"', 'x-confirm-content-sha256': digest!} : {'if-none-match': '*'})}});
 }
 deleteFile(file: FileEntry) {return this.request<FileResult>('files/content?' + new URLSearchParams({path: file.path}), {method: 'DELETE', action: true, headers: {'if-match': '"' + file.revision + '"', 'x-confirm-revision': file.revision}});}
 restore(source_revision: string, expected_revision: string) {return this.request<FileResult>('files/restore', {method: 'POST', action: true, body: {source_revision, expected_revision}});}
 async fileDownload(path: string, revision?: string) {return this.blob(revision ? `files/revisions/${encodeURIComponent(revision)}/content` : 'files/content?' + new URLSearchParams({path}));}
 keys(cursor: string | null, signal: AbortSignal) {return this.request<{secrets: KeyDetails[]; cursor: string | null}>('secrets?' + new URLSearchParams({limit: '50', ...(cursor ? {cursor} : {})}), {signal});}
 saveKey(input: KeyInput, target?: Pick<KeyDetails, 'id' | 'version'>) {return this.request<Omit<KeyDetails, 'agents'>>(target ? 'secrets/' + encodeURIComponent(target.id) : 'secrets', {method: target ? 'PUT' : 'POST', body: {...input, ...(target ? {expected_version: target.version} : {})}});}
 disableKey(id: string, expected_version: number) {return this.request<Omit<KeyDetails, 'agents'>>(`secrets/${encodeURIComponent(id)}/disable`, {method: 'POST', body: {expected_version}});}
 audit(params: string, cursor: number | null, signal: AbortSignal) {return this.request<{events: AuditEvent[]; next_cursor: number | null}>('audit?' + params + (cursor ? '&cursor=' + cursor : ''), {signal});}
 exportAudit(params: string, format: 'jsonl' | 'csv') {return this.blob('audit/export?' + params + '&format=' + format);}
 private async blob(path: string) {const response = await this.request<Response>(path, {raw: true}); const blob = await response.blob(); this.controller.signal.throwIfAborted(); return blob;}
 settings(signal: AbortSignal) {return this.request<Settings>('settings', {signal});}
 saveSettings(expected_version: number, input: Pick<Settings, 'approval_ttl' | 'quota_bytes' | 'retention_ms' | 'maintenance'>) {return this.request<{version: number}>('settings', {method: 'PATCH', body: {expected_version, ...input}});}
 policy(signal: AbortSignal) {return this.request<Policy>('policy', {signal});}
 savePolicy(expected_version: number, rules: PolicyRule[]) {return this.request<{version: number}>('policy', {method: 'PUT', body: {expected_version, rules}});}
 async allKeys(signal: AbortSignal) {
  const keys: KeyMetadata[] = []; let cursor: string | null = null;
  do {
   const page: {secrets: KeyMetadata[]; cursor: string | null} = await this.request('secrets?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), {signal});
   keys.push(...page.secrets); cursor = page.cursor;
  } while (cursor);
  return keys;
 }
}
