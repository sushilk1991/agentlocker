# HTTP API

Use your own deployment URL. Agent routes start with `/api/v1`. Send
`Authorization: Bearer <agent-token>` on every call. Owner routes start with
`/api/v1/owner` and require the separate owner token. Tokens never go in URLs.
Use HTTPS, except for local development. Redirects and cross-origin browser
access are not supported. Responses use `Cache-Control: no-store`.

The CLI and SDK use these same routes. They do not bypass grants or audit
writing. [MCP](mcp.md) calls the same shared services through `/mcp`.

## First file

Give a test agent read and write access to `/notes/`, issue a task token, and
enable the agent. Set `AGENTLOCKER_URL` to the locker origin and load
`AGENTLOCKER_TOKEN` through your private runtime settings. The example below
uses Node's fetch so the token does not appear in command arguments. It creates
a new file only. Run it from a trusted local session, not a shared log collector.

```sh
node --input-type=module <<'NODE'
import { randomUUID } from 'node:crypto';
const url = new URL('/api/v1/files/content', process.env.AGENTLOCKER_URL);
url.searchParams.set('path', '/notes/hello.txt');
const key = randomUUID();
console.log('Keep this idempotency key:', key);
const response = await fetch(url, {
  method: 'PUT',
  redirect: 'manual',
  headers: {
    authorization: `Bearer ${process.env.AGENTLOCKER_TOKEN}`,
    'content-type': 'text/plain',
    'if-none-match': '*',
    'idempotency-key': key,
  },
  body: 'Hello from my agent.\n',
});
console.log(response.status, await response.json());
NODE
```

Keep that key and exact input for an uncertain submission. A second new key
against the same path is a separate create and fails its revision condition.
Use the CLI or SDK for routine transfers and waits.

## Routes available now

| Method and agent route | Purpose |
| --- | --- |
| `GET /files?prefix=/notes/&limit=50` | List readable current files; follow `cursor`. |
| `GET /files/metadata?path=/notes/hello.txt` | Read revision, hash, size, and author. |
| `GET /files/content?path=/notes/hello.txt` | Read complete bytes and the revision ETag. |
| `PUT /files/content?path=/notes/hello.txt` | Create or submit a replacement. |
| `DELETE /files/content?path=/notes/hello.txt` | Submit an exact-revision soft delete. |
| `GET /secrets` | Read granted names and hosts, never values. |
| `POST /proxy/requests` | Submit a named-secret HTTPS request for review. |
| `GET /actions/:id` | Read your action's state. |
| `GET /actions/:id/result` | Fetch your retained result after completion. |

This table omits the `/api/v1` prefix. Paths go in query parameters and must be
encoded once. Folder prefixes end in `/`. Use `If-None-Match: *` for a create.
Use the exact quoted ETag as `If-Match` for replacements and deletes. Include
`Idempotency-Key` for mutations. Keys must be 16–128 printable ASCII characters.
Use the same key for the same logical request; changing its inputs returns 409.
Mappings last seven days. A key reused after that can create another action.

HTTP files allow 10 MiB. The [file reference](file-api.md) covers binary
downloads, owner history and restore, tombstones, quota, and revision conflicts.
The [proxy reference](approvals-and-proxy.md) covers JSON bodies, secret setup,
allowed hosts, limits, and complete approval decisions. The
[owner guide](owner-web-app.md) covers agent/grant management and audit exports.

Current route gaps: `GET /api/v1/whoami` and `GET /api/v1/actions` are not
implemented. HTTP secret listing rejects `limit` and `cursor` until its routing
is completed. Do not infer working routes from the SDK surface or the release
requirements. MCP identity and paginated secret tools are tested separately.

## Results and errors

An immediate completed file write returns HTTP 200 with its action ID, status,
and result revision. Pending, ready, and executing actions return HTTP 202 and
`Retry-After: 2`. Pending submissions include `id`, `approval_id`, and `expires_at`.
Terminal retries return HTTP 200 with the saved state. Polling never dispatches.

Review takes place in the owner web app. Agent replacements, deletes, and all
proxy methods need approval. Rules can also gate reads and new files. A gated
read returns an action instead of content; fetch its retained result after
success. Results expire after 24 hours and still require current permission.

`pending` waits for review. `ready` waits for execution. `executing` has started.
`succeeded` means completion was observed. `failed`, `denied`, `expired`,
`invalidated`, and `unknown` are terminal. An unknown send can already have had
external effects. Do not automatically retry it. A completed proxy result has
its own `upstream_status`, separate from the locker's HTTP status.

Errors are JSON with `request_id` and `error: { code, message }`. Save the request
ID when investigating a failure. Common cases include 401 for an invalid token,
404 `not_found_or_not_allowed`, 409 for stale versions or changed idempotency
input, 410 for expired results, 413 for oversized input, and 429 for quota or rate
limits. Respect `Retry-After` when present. An unavailable schema or configuration
keeps protected routes closed with 503.

Treat returned bytes and text as untrusted data. Avoid logging private file or
response bodies. Saved provider keys have no retrieval endpoint. Select a named
secret in a proxy request instead of putting a key in headers or payloads.
