/** Public HTTP wire types. Times are Unix milliseconds. */
export interface Envelope { request_id: string }
export interface FolderGrant {
 prefix: string; read: boolean | number; write: boolean | number; delete: boolean | number; expires_at?: number | null;
}
export interface SecretGrant { secret_id: string; read: true | 1; expires_at?: number | null }
export interface Identity extends Envelope {
 agent: { id: string; name: string }; token: { id: string; expires_at: number };
 grants: { folders: FolderGrant[]; secrets: {id: string; name: string; read: boolean | number; expires_at: number | null}[] };
}
export interface FileMetadata {
 path: string; revision: string; length: number; hash: string; media_type: string;
 agent_id: string | null; token_id: string | null; author_kind: string;
 modified_at: number; deleted_at: number | null;
}
export interface SecretMetadata {
 id: string; name: string; version: number; value_version: number; enabled: boolean;
 injection_header: string; scheme: 'bearer' | 'plain'; hosts: string[]; created_at: number; updated_at: number;
}
export type ActionStatus = 'pending' | 'ready' | 'executing' | 'succeeded' | 'failed' | 'denied' | 'expired' | 'invalidated' | 'unknown';
interface ActionFields extends Envelope {
 id: string; approval_id: string | null; expires_at: number; result_revision?: string | null;
 result_available?: boolean; error_code?: string;
 result?: { kind?: string; upstream_status?: number; [key: string]: unknown };
 approval?: { state: string; decided_at: number | null } | null;
 attempt?: { state: string; claimed_at: number; dispatch_started_at: number | null; completed_at: number | null; upstream_status: number | null } | null;
}
/** Each state is a separate member, so checking status narrows the union. */
export type Action = { [S in ActionStatus]: ActionFields & { status: S } }[ActionStatus];
/** List entries share the page's request ID and include the operation and target. */
export type ActionSummary = { [S in ActionStatus]: Omit<ActionFields, 'request_id'> & {
 status: S; operation: string; target: string; created_at: number;
} }[ActionStatus];
export type FileList = Envelope & { files: FileMetadata[]; cursor: string | null };
export type SecretList = Envelope & { secrets: SecretMetadata[]; cursor: string | null };
export interface Page { cursor?: string; limit?: number }
export interface CallOptions { signal?: AbortSignal; timeout_ms?: number; idempotency_key?: string }
export type MutationOptions = CallOptions & { idempotency_key: string };
export type WriteOptions = MutationOptions & { media_type: string } & (
 { create_only: true; expected_revision?: never } | { expected_revision: string; create_only?: never }
);
export interface WaitOptions extends CallOptions { timeout_ms?: number }
export interface ProxyRequest {
 secret: string; url: string; method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
 headers?: Record<string, string>; body_text?: string; body_base64?: string;
}
export interface ProxyResult { upstream_status: number; headers: Record<string, string>; body_base64: string }
export const isAction = (value: unknown): value is Action => !!value && typeof value === 'object' &&
 'status' in value && ['pending','ready','executing','succeeded','failed','denied','expired','invalidated','unknown'].includes(String(value.status));
export const isTerminal = (action: Action) => !['pending', 'ready', 'executing'].includes(action.status);
