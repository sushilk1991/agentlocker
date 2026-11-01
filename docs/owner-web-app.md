# Owner web app

The new React workspace opens at `/` or `/approvals`. It includes sign-in,
first-run setup, a responsive sidebar, theme selection, complete single and
batch approval review, and agent, token, and grant management at `/agents`.
Other sidebar pages link to the existing management app
at `/legacy`. Sign in there again; credentials are never passed between pages.
All original management screens remain available during this staged redesign.

The theme follows your system by default. Its light or dark preference is saved
in browser storage. Tokens, review data, and secret values are not saved there.
Signing out aborts requests and clears the private query cache and review data.
The Agents screen shows task tokens once in its management dialog. Closing the
dialog clears the new token. Save grant edits before enabling an agent. Grant
saves confirm the reviewed version and warn that waiting requests will be
invalidated. A version conflict keeps the form blocked until you reload grants.
View agent activity opens its filtered audit log in `/legacy`. Sign in again.
If a screen cannot load, the app clears that session and offers a reload. Sign
in again and check the queue before repeating a request.


Open your deployment URL. Sign in with the owner token set as a Worker secret. The page keeps it in memory. Reloading or signing out clears it. The app does not use cookies or browser storage for credentials. Never use this token in an agent config.

Before first use, confirm the configured URL, approval expiry, file quota, and history retention. Save the owner token in a password manager. Keep an offline backup of the encryption key and its version. Setup needs the preconfigured token. It cannot be claimed by an anonymous visitor. A lost token must be replaced through Cloudflare or Wrangler.

Create an agent. It starts disabled with no grants. Add folder grants and an expiring task token. Review them before enabling the agent. Permissions add together. A narrow grant cannot limit a root grant. Secret “read” means use through the proxy; it does not reveal the saved value. Existing secrets can be selected in the grant editor.

A task token is shown once. Copy it into the agent's private credential settings. Issue a replacement before revoking an old token when you need rotation. Revoking an agent revokes all its tokens. It invalidates work that has not started. A request already dispatched to a service cannot be recalled.

Files shows current files and tombstones under a folder prefix. Start with `/` or enter a folder such as `/work/`. Use More files for the next page. Each file shows its revision, author, task token ID, size, media type, and SHA-256 hash.

Upload a new file at an exact path, up to 10 MiB. Creation rejects any existing path, including a tombstone. To replace content, choose Replace file on its card. The form keeps that exact revision as its precondition. Confirmation names the path, old revision and hash, and the new size and hash. A changed revision causes a conflict. Browse again and review the new revision before trying again.

Downloads preserve the original bytes. Uploaded HTML is downloaded as an attachment. Delete file asks for confirmation of the exact revision and hash. It leaves a tombstone. Revisions and restore shows retained content, authors, and actual restore deadlines. Download a revision to inspect it. Restore revision confirms both the source and the current path revision, including a tombstone. Restore creates a new owner revision. It keeps the audit history. Expired content cannot be restored. File history is not a backup.

Secrets lets you create a key, replace its value or policy, and disable it. Choose either a Bearer token in Authorization or a plain key in one supported custom header. Enter exact public hosts, one per line. Subdomains need their own entries. Wildcards, URLs, paths, and ports are rejected.

The value field is cleared on submission, including a failed request. Saved values never return to the form. Leave Replacement value empty to keep the current key while changing policy. The editor keeps the displayed version. Reload the Secrets view and choose Edit secret again after a version conflict. The cards show policy and value versions, enabled state, exact hosts, granted agents, and grant expiry. Use history opens the audit filter for that secret. Edit grants in Agents & grants. Saving or disabling a secret invalidates waiting requests.

Policy shows the mandatory deletion, replacement, and all-method send gates. Add extra rules for file reads, new writes, file listings, or secret metadata listings. Scope file rules to a folder or all folders. Scope secret-list rules to one named secret or all granted secrets. Remove extra rules to stop requiring that extra review. Rules cannot grant access or remove mandatory gates.

Settings lets you change the default approval expiry, file quota in bytes, and file history retention. Expiry is 1–60 minutes. Retention is at least seven days. These defaults apply to new requests and later file changes. Existing revisions show their saved deadlines. Current, retained, and staged bytes all count toward quota. A lower quota can block new uploads.

Policy and Settings share one configuration version. Each save uses the version shown when the form loaded. A conflict leaves the edit in place. Use Reload policy or Reload settings to discard the edit and load the current version. Saving either invalidates pending and ready actions. It cannot recall dispatched sends. A failed submission keeps its idempotency key for a retry with the same input in this tab.

Maintenance mode in Settings stops protected calls and scheduled work. Settings stays available so you can turn it off. Settings also points to [operations](operations.md) and [deployment](deploy.md) instructions for backups and keys. Owner tokens and storage encryption keys stay in Worker secrets. They have no browser editing form. Storage re-encryption and a verified backup/recovery drill remain release work. Sign out of this locker clears the same private state as the header's Sign out button.

Approvals wait in the app. There are no push alerts. They expire if nobody reviews them. A native iOS app with push is future work.

Select a request to load its complete review. Nothing starts selected. The app verifies the action digest and any body or file hash before enabling Approve. Replacement review loads the whole file, up to 10 MiB. Text wraps or scrolls. Large files use numbered, expandable sections so the page stays responsive. Every section is available, including the final bytes. Binary bytes appear as base64. Control and direction characters appear as escaped codes. Downloads preserve the original bytes. The stored credential is represented by a named placeholder.

You can approve or deny one request, or explicitly select up to 20. Each member has its own digest and result. A changed or expired member can fail while others succeed. Approval permits execution. It does not mean execution succeeded. Use the history filter and audit log to check the result. Investigate an unknown send at the destination before submitting it again.

Activity refreshes every five seconds. It slows to 15 seconds after a minute without input. It pauses when the tab is hidden. Returning to the tab refreshes it. A warning appears after 30 seconds without a successful refresh when requests fail.

The audit view filters by time, agent, token, operation, file path or folder prefix, secret name, host, decision, outcome, request ID, and action ID. Use an action ID to see its timeline. Routine dashboard reads and polls are hidden by default. They remain in the log. Export downloads all matching history as JSONL or CSV. The export uses the current filters and a fixed event boundary. CSV cells escape formula prefixes.

Audit metadata is kept indefinitely. The overview shows the latest event number and an estimated metadata size. The estimate samples the most recent 100 entries; it is not a Cloudflare billing figure or a full database size. Polling does not scan all retained audit rows. File usage includes retained and staged bytes.

The app provides setup, agents, tokens, grants, files, secrets, policy, settings, approval review, activity, and audit views. Named-agent connection checks, deployment tooling, and backup/recovery checks remain unfinished. See the [documentation index](README.md) for the current gaps.

## Owner routes

All routes below start with `/api/v1/owner/`. Send the owner token only in the Authorization bearer header. JSON responses include a request ID. Responses and downloads use `Cache-Control: no-store`. Requests from another origin are rejected.

| Route | Method | Purpose |
| --- | --- | --- |
| `session` | GET | Authenticate and read setup defaults/state. |
| `setup` | POST | Confirm `approval_ttl`, `quota_bytes`, and `retention_ms`. Requires an Idempotency-Key. |
| `overview` | GET | Activity after `cursor`, pending count/version, and usage estimates. |
| `agents` | GET, POST | List metadata or create a disabled agent. |
| `agents/:id` | PATCH | Change name, description, or status. Revocation is permanent. |
| `agents/:id/tokens` | POST | Issue a task token with a label and optional `lifetime_ms`. |
| `agents/:id/tokens/:tokenId` | DELETE | Revoke a task token. |
| `agents/:id/grants` | GET, PUT | Read or replace grants with `expected_version`. |
| `files` | GET | Browse current files and tombstones with `prefix` and `cursor`. |
| `files/content?path=…` | GET, PUT, DELETE | Download, conditional upload, or confirmed exact-revision delete. |
| `files/revisions?path=…` | GET | Retained revisions and their restore deadlines. |
| `files/revisions/:id/content` | GET | Download retained bytes. |
| `files/restore` | POST | Restore `source_revision` with `expected_revision`. |
| `secrets` | GET, POST | List metadata or create a key and policy. |
| `secrets/:id` | PUT | Replace value and/or policy with `expected_version`. |
| `secrets/:id/disable` | POST | Disable use with `expected_version`. |
| `policy` | GET, PUT | Read or replace extra rules with `expected_version`. |
| `settings` | GET, PATCH | Read or change non-secret settings with `expected_version`. |
| `audit` | GET | Read filtered events, newest first, up to 100 per page. |
| `audit/export` | GET | Stream matching events as `format=jsonl` or `format=csv`. |

Audit filter keys are `from` and `to` (Unix milliseconds), `agent_id`, `token_id`, `operation`, `path`, `prefix`, `secret`, `host`, `decision`, `outcome`, `request_id`, and `action_id`. Use `include_routine=true` to include routine reads. `cursor` is the event ID returned as `next_cursor`. Do not carry a page cursor into a full export unless you want only older events.

Setup commits its settings and audit event together. Its retry receipt is permanent. The same key and settings return the saved result. A changed input conflicts. A different key after setup conflicts. Setup does not change Worker secrets or regenerate keys. Approval routes and states are described in [Approvals and proxy](approvals-and-proxy.md).

The file form sends `If-None-Match: *` for creation. Replacement sends an exact `If-Match` and `X-Confirm-Content-SHA256`. Delete sends the same exact revision in `If-Match` and `X-Confirm-Revision`. See the [file API](file-api.md) and [HTTP API](http-api.md) for complete inputs, versions, and retry behavior. All management calls use owner HTTP routes.

## Local checks

Run `npx playwright install chromium` once before browser tests. Run `npm test` for all tests or `npm run test:browser` for the owner browser checks. They serve a bundled Worker on loopback, use real local D1/R2, and stop the runtime and browser afterward. Coverage includes file upload/replacement/download/delete/restore, stale file revisions, hidden saved secret values, secret policy/value updates and disable, scoped policy and settings saves, version conflicts, sign-out clearing, and the full approval flow. The tests create only disposable local credentials. No Cloudflare account is needed.
