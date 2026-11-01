import type { CallOptions } from './types.js';

export class AgentLockerError extends Error {
 readonly name = 'AgentLockerError';
 constructor(public readonly code: string, public readonly status: number,
  message: string, public readonly request_id?: string, public readonly action_id?: string,
  public readonly approval_id?: string, public readonly retry_after_ms?: number) { super(message); }
}
export interface ClientOptions {
 base_url: string; token: string; fetch?: typeof globalThis.fetch; timeout_ms?: number; signal?: AbortSignal;
}
export function retryAfter(value: string | null): number | undefined {
 if (!value) return;
 const delay = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
 return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
export function deadline(ms: number, signals: (AbortSignal | undefined)[]) {
 if (!Number.isFinite(ms) || ms < 0) throw new AgentLockerError('invalid_timeout', 0, 'Timeout must be a nonnegative number.');
 const controller = new AbortController();
 const abort = () => controller.abort();
 for (const signal of signals) { if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }); }
 const timer = setTimeout(abort, ms);
 return { signal: controller.signal, close() { clearTimeout(timer); for (const signal of signals) signal?.removeEventListener('abort', abort); } };
}
/** Low-level authenticated transport, also used by the explicitly namespaced owner CLI. */
export class HttpClient {
 readonly base_url: string;
 private readonly token: string;
 private readonly fetcher: typeof globalThis.fetch;
 readonly timeout_ms: number;
 readonly signal?: AbortSignal;
 constructor(options: ClientOptions) {
  let url: URL;
  try { url = new URL(options.base_url); }
  catch { throw new AgentLockerError('invalid_url', 0, 'Provide a valid deployment origin.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
   (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
   throw new AgentLockerError('invalid_url', 0, 'Use an HTTPS deployment origin, or HTTP localhost for development.');
  }
  if (!options.token || /[^\x21-\x7e]/.test(options.token)) throw new AgentLockerError('invalid_token', 0, 'Provide a bearer token.');
  this.base_url = url.origin; this.token = options.token; this.fetcher = options.fetch ?? globalThis.fetch;
  this.timeout_ms = options.timeout_ms ?? 30000; this.signal = options.signal;
 }
 async request(path: string, init: RequestInit = {}, options: CallOptions = {}): Promise<Response> {
  if (!path.startsWith('/api/v1/') || path.includes('\\') || /[\r\n]/.test(path)) throw new AgentLockerError('invalid_path', 0, 'Use an API path.');
  const url = new URL(path, this.base_url);
  if (url.origin !== this.base_url || !url.pathname.startsWith('/api/v1/')) throw new AgentLockerError('invalid_path', 0, 'Use an API path.');
  const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${this.token}`);
  if (options.idempotency_key !== undefined) {
   if (!/^[\x20-\x7e]{16,128}$/.test(options.idempotency_key)) throw new AgentLockerError('invalid_idempotency_key', 0, 'Use 16 to 128 printable ASCII characters.');
   headers.set('idempotency-key', options.idempotency_key);
  }
  const scope = deadline(options.timeout_ms ?? this.timeout_ms, [this.signal, options.signal]);
  try {
   // Node requires duplex for streaming uploads. Fetch runtimes that do not need it ignore it.
   const response = await this.fetcher(url, { ...init, headers, signal: scope.signal, redirect: 'manual',
    ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
   if (!response.ok) {
    let error: { error?: { code?: string; message?: string }; request_id?: string; action_id?: string; approval_id?: string } = {};
    try { const value = await response.json(); if (value && typeof value === 'object') error = value; } catch { /* Keep non-JSON gateway responses out of errors. */ }
    throw new AgentLockerError(error.error?.code ?? 'http_error', response.status,
     error.error?.message ?? 'The request failed.', error.request_id ?? response.headers.get('x-request-id') ?? undefined,
     error.action_id, error.approval_id, retryAfter(response.headers.get('retry-after')));
   }
   if (!response.body) { scope.close(); return response; }
   const reader = response.body.getReader();
   const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
     try { const next = await reader.read(); if (next.done) { scope.close(); controller.close(); } else controller.enqueue(next.value); }
     catch { scope.close(); controller.error(new AgentLockerError(scope.signal.aborted ? 'aborted' : 'network_error', 0, 'The response was interrupted.')); }
    },
    async cancel(reason) { scope.close(); await reader.cancel(reason); },
   });
   return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
   scope.close();
   if (error instanceof AgentLockerError) throw error;
   throw new AgentLockerError(scope.signal.aborted ? 'aborted' : 'network_error', 0,
    scope.signal.aborted ? 'The client request was aborted or timed out. Server actions are unchanged.' : 'The connection failed. The server outcome may be unknown.');
  }
 }
 async json<T>(path: string, init?: RequestInit, options?: CallOptions): Promise<T> {
  const response = await this.request(path, init, options);
  try { return await response.json() as T; }
  catch (error) { if (error instanceof AgentLockerError) throw error; throw new AgentLockerError('invalid_response', response.status, 'Expected a JSON response.', response.headers.get('x-request-id') ?? undefined); }
 }
}
