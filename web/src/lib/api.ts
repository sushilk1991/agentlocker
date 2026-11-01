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
 target: string; status: ActionState; created_at: number; expires_at: number;
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

// One client per sign-in. Credentials, retry keys and request lifetimes never
// enter browser storage or Query keys. Failed mutations retain their exact key.
export class OwnerApi {
 private token: string;
 private controller = new AbortController();
 private mutationKeys = new Map<string, string>();
 constructor(token: string, private unauthorized: () => void) { this.token = token; }
 get active() { return !this.controller.signal.aborted; }
 dispose() { this.token = ''; this.controller.abort(); this.mutationKeys.clear(); }
 private async request<T>(path: string, options: {body?: unknown; signal?: AbortSignal; raw?: boolean; method?: string} = {}): Promise<T> {
  const {body, signal, raw, method = 'GET'} = options;
  const signature = JSON.stringify([method, path, body]);
  const headers: Record<string, string> = {authorization: 'Bearer ' + this.token};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
   if (!this.mutationKeys.has(signature)) this.mutationKeys.set(signature, crypto.randomUUID());
   headers['idempotency-key'] = this.mutationKeys.get(signature)!;
  }
  const response = await fetch('/api/v1/owner/' + path, {
   method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', redirect: 'error',
   signal: signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal,
  });
  this.controller.signal.throwIfAborted();
  if (!response.ok) {
   const data = await response.json() as {error?: {message?: string}; request_id?: string};
   if (response.status === 401) this.unauthorized();
   throw new Error((data.error?.message || 'Request failed') + (data.request_id ? ' · Request ' + data.request_id : ''));
  }
  const result = raw ? response : await response.json();
  this.controller.signal.throwIfAborted();
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
}
