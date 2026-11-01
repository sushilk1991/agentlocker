# File API

This chunk adds file storage and HTTP routes. The owner approval screen and
scheduled action dispatch come in the approvals chunk. Until then, agent delete,
replacement, and rule-gated requests stay pending. There is no approval shortcut.

All protected routes use a bearer token. Agent routes start with `/api/v1`.
Owner routes start with `/api/v1/owner`. Each deployment has its own origin.
Responses are private and use `Cache-Control: no-store`.

## Current files

- `GET /files?prefix=/notes/&limit=50`: list readable files. Follow `cursor` for
  another page. The maximum page size is 100. Owner listings include tombstones.
- `GET /files/metadata?path=/notes/a.txt`: get the current revision, SHA-256 hash,
  byte length, media type, author, and modification time.
- `GET /files/content?path=/notes/a.txt`: download the current bytes. The response
  includes a quoted revision ETag and `X-Content-SHA256`. Downloads use an
  attachment disposition and a safe binary content type, including for HTML.
- `PUT /files/content?path=/notes/a.txt`: upload up to 10 MiB. Send a content type,
  an idempotency key, and one revision condition.
- `DELETE /files/content?path=/notes/a.txt`: request a soft delete. Send an exact
  revision condition and an idempotency key. There is no recursive delete.

Logical paths go in query parameters. Encode them once with `encodeURIComponent`
or an equivalent URL builder. Paths start with `/`. Folder prefixes end with `/`.
Traversal, double slashes, percent signs in logical paths, and control characters
are rejected. Prefix matching respects folder boundaries.

To create, send `If-None-Match: *`. To replace or delete, send
`If-Match: "<revision>"`. A blind write is rejected. A tombstone still occupies its
path; restore it as owner. Agents can read only current files. Unknown and
ungranted files return the same `not_found_or_not_allowed` error.

A successful write returns an action with `status: "succeeded"` and
`result_revision`. Agent replacements and deletes return HTTP 202 with `pending`,
`id`, `approval_id`, and `expires_at`. The request has made no visible file change.
Poll `GET /api/v1/actions/<id>` to read its state. Polling never executes it.
Owner rules can also make list, metadata, read, and new-write requests pending.
Include an idempotency key on those reads. Pending reads return an action instead
of file data. Approval decisions and their execution belong to the next chunk.

Owner replacement uploads also need `X-Confirm-Content-SHA256` with the uploaded
bytes' SHA-256 hash. Owner deletes need `X-Confirm-Revision` matching `If-Match`.
These explicit submissions authorize the owner's direct action.

## Retries and storage limits

Every mutation needs `Idempotency-Key`: 16 to 128 printable ASCII characters.
Keep the same key and exact input when retrying one logical request. Keys are
scoped to the agent identity, or to the owner. Mappings last seven days. Matching
retries return the same action and current state. Changed input returns 409.
After expiry the key may create a new action. A returned failure stays failed
under that key. It does not silently upload again.

Each write reserves space before uploading. Current files, retained revisions,
and staged uploads all count toward the default 1 GiB quota. Replacements and
restores need room for another revision. Quota exhaustion returns 429 with
`quota_exceeded`. It never removes history to make room.

Uploads use immutable, private R2 keys. D1 holds logical paths and current
revision pointers. An upload failure cannot publish bytes. A failed final commit
leaves a charged staged object. Only a successful conditional commit changes the
pointer, action result, retention, and audit result together. Competing writes
against one revision cannot both publish.

## History and restore

These routes require the owner token:

- `GET /files/revisions?path=/notes/a.txt&limit=50`: retained revision metadata,
  author, and actual `restore_deadline`. Follow `cursor` for another page.
- `GET /files/revisions/<revision>/content`: inspect retained bytes.
- `POST /files/restore`: JSON with `source_revision` and `expected_revision`.
  Send an idempotency key. The expected revision must match the path's current
  pointer, including a tombstone pointer. Restore creates a new owner revision
  with the same bytes. It does not rewind audit history.

Superseded and deleted contents remain for at least seven days. A current file
has no restore deadline. Expired history cannot be restored, even if physical
cleanup has not run yet. Tombstones remain visible to the owner after their
contents expire.

The Worker checks cleanup once per hour, using a batch of at most 50 revisions.
Live actions and retained action results pin their content. Abandoned uploads
remain charged for at least 24 hours. Failed R2 deletion keeps the reservation
charged until cleanup succeeds. Maintenance mode stops cleanup.

Retention does not protect against loss of the Cloudflare account, D1, or R2.
Separate backup and export instructions belong to the deployment chunk. Native
iOS approval notifications are future work. V1 has no push or ntfy integration.
