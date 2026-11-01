export * from './types.js';
export { AgentLockerError, HttpClient, retryAfter } from './transport.js';
export type { ClientOptions } from './transport.js';
import { AgentLockerError, deadline, HttpClient, retryAfter, type ClientOptions } from './transport.js';
import { isTerminal, type Action, type CallOptions, type Envelope, type FileList, type FileMetadata,
 type Identity, type MutationOptions, type Page, type ProxyRequest, type SecretList, type WaitOptions, type WriteOptions } from './types.js';

export const newIdempotencyKey = () => crypto.randomUUID();
const query = (path: string, values: object) => {
 const params = new URLSearchParams();
 for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
 return '/api/v1/' + path + (params.size ? '?' + params : '');
};
const jsonBody = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const readOptions = (options: CallOptions): CallOptions => ({ ...options, idempotency_key: options.idempotency_key ?? newIdempotencyKey() });

/** Consume body once via body, bytes(), or json(). Cancel unused streams. */
export class Download {
 readonly kind = 'download';
 readonly request_id: string | null;
 readonly revision: string | null;
 readonly hash: string | null;
 readonly content_type: string;
 readonly length: number | null;
 readonly body: ReadableStream<Uint8Array> | null;
 constructor(private readonly response: Response) {
  this.request_id = response.headers.get('x-request-id');
  this.revision = response.headers.get('etag')?.replace(/^"|"$/g, '') ?? null;
  this.hash = response.headers.get('x-content-sha256');
  this.content_type = response.headers.get('content-type') ?? 'application/octet-stream';
  this.length = response.headers.has('content-length') ? Number(response.headers.get('content-length')) : null;
  this.body = response.body;
 }
 async bytes() { return new Uint8Array(await this.response.arrayBuffer()); }
 async json<T = unknown>(): Promise<T> { return await this.response.json() as T; }
}

export class AgentLocker {
 private readonly http: HttpClient;
 constructor(options: ClientOptions) { this.http = new HttpClient(options); }
 identity = (options: CallOptions = {}) => this.http.json<Identity>('/api/v1/whoami', undefined, options);
 files = {
  list: (prefix: string, page: Page = {}, options: CallOptions = {}) =>
   this.http.json<FileList | Action>(query('files', { prefix, ...page }), undefined, readOptions(options)),
  metadata: (path: string, options: CallOptions = {}) =>
   this.http.json<(Envelope & FileMetadata) | Action>(query('files/metadata', { path }), undefined, readOptions(options)),
  read: async (path: string, options: CallOptions = {}): Promise<Download | Action> => {
   const response = await this.http.request(query('files/content', { path }), undefined, readOptions(options));
   return response.status === 202 || (!response.headers.has('etag') && response.headers.get('content-type')?.split(';')[0] === 'application/json')
    ? await response.json() as Action : new Download(response);
  },
  write: (path: string, content: Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>, options: WriteOptions) => {
   const size = content instanceof Uint8Array ? content.byteLength : content instanceof ArrayBuffer ? content.byteLength : content instanceof Blob ? content.size : undefined;
   if (size !== undefined && size > 10 * 1024 * 1024) throw new AgentLockerError('too_large', 413, 'Files can contain at most 10 MiB.');
   if ((options.create_only === true) === (options.expected_revision !== undefined)) throw new AgentLockerError('revision_precondition_required', 400, 'Choose create_only or an expected_revision.');
   const headers: Record<string, string> = { 'content-type': options.media_type };
   if (options.expected_revision !== undefined) headers['if-match'] = revisionTag(options.expected_revision);
   else headers['if-none-match'] = '*';
   return this.http.json<Action>(query('files/content', { path }), { method: 'PUT', headers, body: content as BodyInit }, options);
  },
  delete: (path: string, expected_revision: string, options: MutationOptions) =>
   this.http.json<Action>(query('files/content', { path }), { method: 'DELETE', headers: { 'if-match': revisionTag(expected_revision) } }, options),
 };
 secrets = {
  list: (page: Page = {}, options: CallOptions = {}) => this.http.json<SecretList | Action>(query('secrets', page), undefined, readOptions(options)),
 };
 proxy = {
  request: (input: ProxyRequest, options: MutationOptions) => this.http.json<Action>('/api/v1/proxy/requests', jsonBody(input), options),
 };
 actions = {
  list: (page: Page = {}, options: CallOptions = {}) => this.http.json<Envelope & { actions: Action[]; cursor: string | null }>(query('actions', page), undefined, options),
  get: (id: string, options: CallOptions = {}) => this.http.json<Action>(query('actions/' + encodeURIComponent(id), {}), undefined, options),
  result: async (id: string, options: CallOptions = {}) => new Download(await this.http.request(query('actions/' + encodeURIComponent(id) + '/result', {}), undefined, options)),
  wait: async (id: string, options: WaitOptions = {}): Promise<Action> => {
   const timeout = options.timeout_ms ?? 60000;
   const scope = deadline(timeout, [this.http.signal, options.signal]);
   const end = Date.now() + timeout;
   let last: Action | undefined, step = 0;
   try {
    while (true) {
     let hint: number | undefined;
     try {
      const response = await this.http.request(query('actions/' + encodeURIComponent(id), {}), undefined,
       { ...options, timeout_ms: Math.min(this.http.timeout_ms, Math.max(0, end - Date.now())), signal: scope.signal });
      hint = retryAfter(response.headers.get('retry-after'));
      last = await response.json() as Action;
      if (isTerminal(last)) return last;
     } catch (error) {
      if (!(error instanceof AgentLockerError) || error.status !== 429) throw error;
      hint = error.retry_after_ms;
     }
     const remaining = end - Date.now();
     if (remaining <= 0) {
      if (last) return last;
      throw new AgentLockerError('wait_timeout', 0, 'Wait deadline reached. Server actions are unchanged.');
     }
     // Never poll faster than two seconds or the server's guidance.
     const backoff = Math.min(10000, 2000 * 1.5 ** step++);
     await pause(Math.min(remaining, Math.max(hint ?? 0, backoff * (1 + Math.random() * 0.2))), scope.signal);
     if (Date.now() >= end && last) return last;
    }
   } catch (error) {
    if (!options.signal?.aborted && !this.http.signal?.aborted && scope.signal.aborted && last) return last;
    if (error instanceof AgentLockerError && error.code === 'aborted')
     throw new AgentLockerError(error.code, error.status, error.message, error.request_id, id, last?.approval_id ?? undefined);
    throw error;
   } finally { scope.close(); }
  },
 };
}
function revisionTag(revision: string) {
 if (!/^[^"\s]{1,100}$/.test(revision)) throw new AgentLockerError('invalid_revision', 400, 'Provide an unquoted revision ID.');
 return '"' + revision + '"';
}
function pause(ms: number, signal: AbortSignal) {
 return new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new AgentLockerError('aborted', 0, 'Client waiting stopped. Server actions are unchanged.')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
 });
}
