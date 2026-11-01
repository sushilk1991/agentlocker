# HTTP API

Use your own deployment URL. Agent routes start with `/api/v1`. Send
`Authorization: Bearer <agent-token>` on every call. Owner routes start with
`/api/v1/owner` and require the separate owner token. Tokens never go in URLs.
Use HTTPS, except for local development. Redirects and cross-origin browser
access are not supported. Responses use `Cache-Control: no-store`.

Public `GET /healthz` returns only `ok`. It exposes no deployment details.

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
| `GET /whoami` | Read your identity, token expiry, and effective grants. |
| `GET /files?prefix=/notes/&limit=50` | List readable current files; follow `cursor`. |
| `GET /files/metadata?path=/notes/hello.txt` | Read revision, hash, size, and author. |
| `GET /files/content?path=/notes/hello.txt` | Read complete bytes and the revision ETag. |
| `PUT /files/content?path=/notes/hello.txt` | Create or submit a replacement. |
| `DELETE /files/content?path=/notes/hello.txt` | Submit an exact-revision soft delete. |
| `GET /secrets?limit=50&cursor=...` | Read granted names and hosts, never values. |
| `POST /proxy/requests` | Submit a named-secret HTTPS request for review. |
| `GET /actions?limit=50&cursor=...` | List your recent accessible action summaries. |
| `GET /actions/:id?wait_seconds=0` | Read your action's state. Optionally wait up to 20 seconds. |
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

## Identity and list responses

`whoami` returns `agent: {id, name}`, `token: {id, expires_at}`, and
`grants: {folders, secrets}`. Grants exclude expired entries and disabled secrets.
Folder permissions add together. A narrow grant does not cancel a broader one.
Secret grants permit use through the proxy. Identity never returns a credential,
token hash, or ungranted secret. MCP `locker_identity` uses this same service.

File, secret, and action lists return their named array and `cursor`. The default
page has 50 entries. `limit` accepts 1–100. A null cursor ends the list. Pass a
returned cursor unchanged as an encoded query parameter. Cursors are encrypted,
bound to the caller, and become invalid after configuration or grant changes.
Malformed, stale, or another caller's cursors return 400 `invalid_cursor`.
Authorization happens before pagination. Pages have no global or hidden counts.

Actions sort newest first, using action ID to break timestamp ties. Each summary
includes `id`, `operation`, `target`, `created_at`, `status`, `approval_id`,
`expires_at`, and result availability. Only this agent's actions with current
access appear. Token rotation keeps the same agent history. Another agent cannot
read its actions or results. An action GET adds `approval` and `attempt` metadata.
Status polling returns 200, with `Retry-After: 2` while unfinished. Waiting and
listing never dispatch work.

Secret pages contain names, versions, enabled state, injection metadata, hosts,
and timestamps. No saved value, ciphertext, nonce, or value hash is returned.
For reads gated by an owner rule, supply an `Idempotency-Key`. Secret list
approvals bind `limit` and `cursor` to the exact request. Changed page inputs with
the same key conflict. The retained result contains that page after approval.

## Owner routes

These paths start with `/api/v1/owner`. Every data read and mutation is audited.
Mutations require an `Idempotency-Key`. JSON bodies require `application/json`.
Agent credentials fail on every owner route. An owner credential cannot act as
an agent on agent routes. Owner responses never reveal a saved provider value.

| Method and owner route | Purpose |
| --- | --- |
| `GET /session` | Validate sign-in and read setup state. |
| `POST /setup` | Initialize once with confirmed defaults. |
| `GET /overview` | Read activity deltas, queue counts, and storage use. |
| `GET /agents` | List agents and token metadata. |
| `POST /agents` | Create a disabled agent with no grants. |
| `PATCH /agents/:id` | Rename, enable, disable, or revoke an agent. |
| `POST /agents/:id/tokens` | Issue a task token; return its value once. |
| `DELETE /agents/:id/tokens/:tokenId` | Revoke a token and waiting work. |
| `GET /agents/:id/grants` | Read explicit and effective grants. |
| `PUT /agents/:id/grants` | Replace grants with `expected_version`. |
| `GET /policy` | Read additional rules, mandatory gates, and version. |
| `PUT /policy` | Replace additional rules with `expected_version`. |
| `GET /files` | Browse current files and tombstones; accepts `prefix`, `limit`, `cursor`. |
| `GET /files/content?path=...` | Download current bytes. |
| `PUT /files/content?path=...` | Create or explicitly confirm a replacement. |
| `DELETE /files/content?path=...` | Confirm an exact-revision soft delete. |
| `GET /files/revisions?path=...` | List retained revisions and restore deadlines. |
| `GET /files/revisions/:id/content` | Download retained bytes. |
| `POST /files/restore` | Restore a retained revision with a current-path condition. |
| `GET /secrets` | Page all secret metadata, including disabled entries and granted agents. |
| `POST /secrets` | Save a value, injection rule, and hosts. |
| `PUT /secrets/:id` | Replace value and/or policy with `expected_version`. |
| `POST /secrets/:id/disable` | Disable use with `expected_version`. |
| `GET /approvals` | List summaries; accepts `state`, `limit`, `offset`. |
| `GET /approvals/:id` | Load full review input, digest, identity, and scope. |
| `GET /approvals/:id/content` | Download complete staged bytes. |
| `POST /approvals/:id/decision` | Decide the displayed digest. |
| `POST /approvals/batch-decision` | Decide up to 20 explicit members. |
| `GET /actions/:id` | Inspect any action, its attempt, and audit timeline. |
| `GET /actions/:id/result` | Retrieve a retained result for investigation. |
| `GET /audit` | Filter and page the global audit history. |
| `GET /audit/export` | Export the same filters as JSONL or CSV. |
| `GET /settings` | Read non-secret settings and version. |
| `PATCH /settings` | Update validated settings with `expected_version`. |

Owner secret metadata includes `agents: [{id, name, status, read, expires_at}]`.
It includes expired grants so the owner can inspect them. Agent lists omit this
attribution. Owner action views include `operation`, `target`, `digest`, agent
and token IDs, the original request ID, and `timeline`. Timeline events sort by
newest event ID. Use `limit` and the returned `next_cursor` to read older events.
Action and result reads never dispatch a send. The normal result expiry still
applies to owner investigation.

## Policy and settings updates

Both endpoints use the deployment's shared configuration version. Read the
current `version`, then send it as `expected_version`. A stale version returns
409 `version_conflict`. A successful update returns the new `version`. Changes,
waiting-action invalidation, retry receipts, and audit events commit together.
An audit failure rolls back the update. These updates conservatively invalidate
all pending and ready actions. They leave terminal outcomes intact.

Policy PUT accepts only `expected_version` and `rules`. Each rule has an
`operation` and optional scope. Operations are `file.read`, `file.write`,
`files.list`, and `secrets.list`. File rules may have a canonical folder `prefix`.
Secret-list rules may have a `secret_id`. Omit scope or use null for all targets.
Do not send the generated rule IDs, versions, or timestamps from GET. Duplicate
rules, unknown fields, invalid prefixes, and unknown secret IDs are rejected.

For example, this body gates reads within `/notes/`. Replace 7 with the version
you just read. Send the owner bearer token and a fresh idempotency key.

```json
{"expected_version":7,"rules":[{"operation":"file.read","prefix":"/notes/"}]}
```

The response's `mandatory` list names `file.delete`, `file.replace`, and
`proxy.request`. These built-in gates always apply to agents, including GET and
HEAD sends. `file.replace` labels the replacement case of `file.write`.
`rules: []` removes only additional rules. No rule can turn approval off or
override a missing grant.

Settings PATCH accepts `expected_version` and one or more of these fields:

| Field | Accepted value |
| --- | --- |
| `approval_ttl` | Integer milliseconds, 60,000–3,600,000. Applies to new approvals. |
| `quota_bytes` | Positive safe integer. Counts current, retained, and staged bytes. |
| `retention_ms` | Safe integer milliseconds, at least seven days. Applies to later file changes. |
| `maintenance` | Boolean. Blocks protected calls and scheduled work while true. |

GET includes these values, `version`, the public origin, and timestamps. It has
no Worker secrets or storage keys. Settings GET/PATCH remain owner-accessible
during maintenance so the owner can turn it off. Setup and compatible schema are
still required. A lower quota can block new uploads until usage falls below it.
Origin, encryption keys, deployment identity, and bindings are provisioning
settings. This API cannot change them.

Policy/settings retry receipts last seven days. The same key and exact body
return the recorded version without applying another update. A changed body
under that key conflicts. Token issuance never retains a recoverable token for
replay. If its one-time response is lost, inspect token metadata, revoke that
token, and issue a fresh one.

## Results and errors

An immediate completed file write returns HTTP 200 with its action ID, status,
and result revision. Unfinished submissions return HTTP 202 and
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

JSON responses include the current `request_id`. Downloads also carry it in
`X-Request-Id`. File results use a revision ETag and attachment disposition. JSON
results retain their fields, including a proxy's `upstream_status`, and add the
request ID. No result redirects to R2.

Treat returned bytes and text as untrusted data. Avoid logging private file or
response bodies. Saved provider keys have no retrieval endpoint. Select a named
secret in a proxy request instead of putting a key in headers or payloads.
