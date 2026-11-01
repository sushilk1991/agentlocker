# Approvals and the secrets proxy

Every agent delete, file replacement, and outbound request waits for the owner.
GET and HEAD requests also need approval. A grant alone does not authorize a send.
There are no push services or approval links in v1. The owner web app is a later
chunk. It will use the owner routes below at each deployment's own URL. A native
iOS app with push is future work.

## State and decisions

A submission returns HTTP 202 with `id`, `approval_id`, `status`, and `expires_at`.
The default lifetime is 15 minutes. It never grows when a request is retried or
read. The database clock decides expiry.

The owner loads `GET /api/v1/owner/approvals/:approvalId`. This returns the full
stored input and its digest, the agent, task label, and grants. Bodies are base64.
Use `GET /api/v1/owner/approvals/:approvalId/content` for the complete request or
staged file bytes. These endpoints never include an injected key. Downloads are
private attachments. Verify staged content before enabling approval in a client.

Send `POST /api/v1/owner/approvals/:approvalId/decision` with JSON:

```json
{"digest":"<the displayed digest>","decision":"approve","reason":"Reviewed"}
```

Use `deny` to refuse it. Decisions need the owner bearer token and an
`Idempotency-Key` header. A conditional transaction records one decision and its
audit event. A stale digest or second decision returns 409. Read the action again
to see the persisted winner. An agent cannot decide an approval.

For a batch, POST to `/api/v1/owner/approvals/batch-decision` with `members` (objects
with `id` and `digest`), `decision`, and optional `reason`. Select 1–20 distinct
approval IDs. Each member has an independent outcome and audit event. Results
share a batch ID. A conflict on one member does not authorize another member.

List approval summaries at `/api/v1/owner/approvals?state=pending`. Other states
are `approved`, `denied`, `expired`, `invalidated`, and `all`. Use `limit` (1–100)
and `offset` for pages. A scheduled sweep expires and invalidates queued work.
Decision and execution checks do not wait for that sweep.

| State | Meaning |
| --- | --- |
| pending | Waiting for the owner. |
| ready | Approved. Execution has not claimed it yet. |
| executing | One durable attempt has claimed it. |
| succeeded | Completed locally, or a complete upstream response was saved. |
| failed | A definite local failure. A send was not dispatched. |
| unknown | A send may have happened. No complete result was saved. |
| denied / expired / invalidated | Terminal. No new execution is allowed. |

Approval schedules execution with the Worker. The minute cron handles missed
ready work. Status and result GETs never execute anything. File changes and their
results commit together. For sends, the Worker saves a dispatch marker before
fetch. An abandoned send becomes `unknown` after 60 seconds. It is never replayed.
A late executor cannot overwrite a terminal reconciliation result. A dispatched
send can finish after the approval deadline.

Read status at `/api/v1/actions/:id`. Read retained results at
`/api/v1/actions/:id/result`. Owners use the same paths under `/api/v1/owner`.
Results need current permission and expire after 24 hours. A different valid token
for the same agent may read them. Another agent cannot. Expired payloads return
410 `result_expired`; the action summary and audit history remain.
Each scheduled sweep erases up to 100 expired payloads and skips rows already
cleared, so a backlog drains over successive runs.

## Secret setup and use

POST `/api/v1/owner/secrets` with `name`, `value`, `hosts`, `injection_header`, and
`scheme`. Names use letters, digits, dots, underscores, and hyphens. Values must
be nonempty printable ASCII, with no leading or trailing spaces. For example:

```json
{"name":"provider","value":"<key>","hosts":["api.example.com"],"injection_header":"Authorization","scheme":"bearer"}
```

`bearer` supports only Authorization with a fixed `Bearer ` prefix. `plain`
supports a named API-key header with no prefix. Cookie, forwarding, transport,
and content headers cannot be credential headers. Saved values have no read API,
including for the owner. Metadata never includes ciphertext, nonces, or a value
hash. A named-secret read grant means use inside this proxy.

PUT `/api/v1/owner/secrets/:id` with the reviewed configuration and
`expected_version`. Omit `value` to keep it. A new provider value increments its
value version. Every change increments its policy version. Disable through
`POST /api/v1/owner/secrets/:id/disable` with `expected_version`. Changes invalidate
outstanding work conservatively through the deployment policy version.

Provider key rotation means saving a replacement value here. Storage key rotation
is a separate maintenance task. Records carry an explicit encryption-key version;
the configured previous key can decrypt records with that version. There is no
silent key fallback. A bounded storage re-encryption workflow is future work in
the deployment/maintenance chunk. Keep offline encryption-key backups.

Agents POST `/api/v1/proxy/requests` with an `Idempotency-Key` header:

```json
{"secret":"provider","url":"https://api.example.com/v1/message","method":"POST","headers":{"content-type":"application/json"},"body_text":"{\"text\":\"hello\"}"}
```

Use `body_base64` instead of `body_text` for bytes. Never provide both. The request
body limit is 64 KiB; submitted headers have a 16 KiB limit. Methods are GET, HEAD,
POST, PUT, PATCH, DELETE, and OPTIONS. GET and HEAD have no body. Header values
cannot have leading or trailing whitespace that fetch would silently trim.

Only exact allowed public hostnames work. Case and IDNA normalize once. There are
no wildcard hosts, HTTP URLs, credentials in URLs, fragments, IP literals, internal
names, arbitrary ports, redirects, or cookie jars. Authorization, cookies,
forwarding headers, transport headers, and injection conflicts are rejected.
The request's normalized URL, query order, header values, and bytes stay fixed.

Only allow trusted service hosts. Their ownership and DNS are trusted. A trusted
host receives the key. Literal occurrences of that key in response headers and
body bytes are redacted before encrypted storage or delivery, including across
stream chunks. Authentication and cookie response headers are removed. An upstream
that encodes or transforms the key can bypass literal redaction. This proxy does
not promise containment against a malicious allowed service.

A complete 3xx/4xx/5xx response is `succeeded`, with a separate `upstream_status`.
Redirects do not cause a second fetch. Results contain that status, filtered
headers, and base64 response bytes. The network deadline is 20 seconds. Interrupted
or oversized responses (over 256 KiB) become `unknown`. Do not resend an unknown
action automatically. Check the provider first.

## Digests and retries

Canonical JSON sorts object keys lexically, preserves arrays, omits undefined
object fields, and uses JSON string/number encoding. SHA-256 covers this object:
`{input, config_version, agent_id, token_id}`. File inputs include exact revisions,
lengths and hashes. Proxy input includes normalized request fields, decoded body
hash and canonical base64, secret ID/name/value version, and injection rule. The
action also records the secret policy version. Host/grant/rule changes advance
`config_version`. Decisions and claims recheck those versions and current rights.

Inputs use AES-256-GCM with fresh 96-bit nonces. The authenticated context is
`[deployment_id, record_type, record_id, value_version, key_version]`. Secrets,
queued inputs, and results use distinct record types. D1 rejects input changes.

Submission retry mappings last seven days and belong to an identity. The same key
and input returns the same action without extending expiry. Changed input returns
409. Equivalent decoded base64 bytes deduplicate. After seven days the key may
create a new action. Never treat a lost or unknown send as safe to submit again.
A retry that finds a terminal action returns HTTP 200 with its recorded state.
Only unfinished actions return 202 and `Retry-After`. HTTP 200 does not turn a
denied, failed, expired, or unknown action into a successful operation.
