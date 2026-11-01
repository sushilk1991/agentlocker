# @agentlocker/sdk

A fetch client for your own Agent Locker deployment. MIT licensed. No runtime
packages or Node APIs are required. Use Node 20.19+, a Worker, or another runtime
with fetch, streams, AbortController, and WebCrypto.

Build from the repository with `npm ci && npm run sdk:build`. Package output is
in `packages/sdk/dist`. This chunk prepares the package; it does not publish it.

```ts
import { AgentLocker, Download, newIdempotencyKey } from '@agentlocker/sdk';

const locker = new AgentLocker({
  base_url: 'https://your-locker.example.com',
  token: '<agent-token>', // Load this from your runtime's secret store.
  timeout_ms: 30_000,
  // fetch: customFetch,
  // signal: shutdownSignal,
});

const read = await locker.files.read('/notes/today.txt');
if (read instanceof Download) {
  const bytes = await read.bytes(); // Or consume read.body as a stream.
  console.log(new TextDecoder().decode(bytes)); // Treat content as untrusted data.
} else {
  console.log(read.id, read.status); // An owner rule can require review.
}

const writeKey = newIdempotencyKey(); // Save this before submitting.
const write = await locker.files.write('/notes/draft.txt',
  new TextEncoder().encode('Draft\n'), {
    create_only: true,
    media_type: 'text/plain',
    idempotency_key: writeKey,
  });
console.log(write.id, write.status);

const sendKey = newIdempotencyKey(); // Keep this key with the exact request.
const send = await locker.proxy.request({
  secret: 'mail-api',
  url: 'https://api.example.com/messages',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body_text: JSON.stringify({ text: 'Hello' }),
}, { idempotency_key: sendKey });

// Open your deployment's web app to review the complete request.
// This wait has a client deadline. It cannot approve or execute an action.
const done = await locker.actions.wait(send.id, { timeout_ms: 60_000 });
if (done.status === 'succeeded') {
  const result = await locker.actions.result(done.id);
  const response = await result.json<{ upstream_status: number; body_base64: string }>();
  console.log(response.upstream_status); // A complete upstream 4xx/5xx is still recorded.
} else {
  console.log(done.id, done.status); // pending, ready, and executing are unfinished.
}
```

`files.write` also accepts ArrayBuffer, Blob, or ReadableStream<Uint8Array>.
Use `{ expected_revision: '<revision>', ... }` instead of `create_only` for a
replacement. Replacements and exact-revision deletes need approval. HTTP file
transfers allow 10 MiB and do not use base64. Buffered oversize input is rejected
locally; the server bounds streamed input. Downloads are consumed once. Cancel
`download.body` if you will not read it. Timeout covers response consumption too.
`Download` exposes the request ID, revision, SHA-256 hash, content type, and length
when those headers are available. Action results may be bytes or JSON.

The client exposes these methods:

| Method | Arguments |
| --- | --- |
| `identity` | optional call options |
| `files.list` | prefix, optional page, optional call options |
| `files.metadata` / `files.read` | exact path, optional call options |
| `files.write` | exact path, bytes/stream, required write options |
| `files.delete` | exact path, expected revision, required mutation options |
| `secrets.list` | optional page, optional call options |
| `proxy.request` | exact proxy request, required mutation options |
| `actions.list` | optional page, optional call options |
| `actions.get` / `actions.result` | action ID, optional call options |
| `actions.wait` | action ID, optional wait options |

Page options are `cursor` and `limit`. Call options are `signal`, `timeout_ms`,
and `idempotency_key`. Mutations require an explicit idempotency key. Reads that
can require review get a key automatically; supply your own to resume that logical
read. Lists and metadata can return an `Action` instead of data. Use `isAction`
to check it. Public types are exported and shared with the CLI.

`AgentLockerError` includes `code`, locker HTTP `status` (0 for a local/network
failure), `request_id`, optional action/approval IDs, and `retry_after_ms`.
An upstream status is inside a completed proxy result, separate from locker errors.
A network failure during a submission can mean the server accepted it. Keep the
original key and payload. There are no automatic submission retries. The server
keeps keys for seven days; reuse after that may create another action. Never
resubmit an unknown send automatically. Check the external service first.

Waiting polls with jitter, starts at two seconds, backs off, and respects
Retry-After. Rate-limited polls wait before retrying. At the deadline it returns
the last observed action. Abort rejects with `aborted` and the action ID. Neither
changes the server action. The default wait deadline is 60 seconds. Each HTTP
request has a separate timeout, defaulting to 30 seconds.

Use HTTPS. HTTP is accepted only for localhost development. Redirects are never
followed. Custom fetch implementations must honor the supplied signal and redirect
mode. Browser use exposes the agent token to that browser context and follows the
server's origin policy; v1 has no wildcard CORS. Owner tokens must never ship in
browser code. Saved provider keys are never returned. Use a named secret through
`proxy.request`.

Current Worker boundary: `/whoami` and agent action listing are still part of the
remaining Worker routes chunk. Their client methods are covered by contract tests;
they return `not_found` on the current Worker. `configure` also needs `/whoami`.
Secret listing works, but the current HTTP route rejects pagination parameters.
The client supports the specified parameters for that later route completion.
File, action status/result, and proxy flows are tested over real local HTTP.
Native iOS push is future work. V1 reviews happen in the deployment's web app.
