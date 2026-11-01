# Owner web app

Open your deployment URL. Sign in with the owner token set as a Worker secret. The page keeps it in memory. Reloading or signing out clears it. The app does not use cookies or browser storage for credentials. Never use this token in an agent config.

Before first use, confirm the configured URL, approval expiry, file quota, and history retention. Save the owner token in a password manager. Keep an offline backup of the encryption key and its version. Setup needs the preconfigured token. It cannot be claimed by an anonymous visitor. A lost token must be replaced through Cloudflare or Wrangler.

Create an agent. It starts disabled with no grants. Add folder grants and an expiring task token. Review them before enabling the agent. Permissions add together. A narrow grant cannot limit a root grant. Secret “read” means use through the proxy; it does not reveal the saved value. Existing secrets can be selected in the grant editor.

A task token is shown once. Copy it into the agent's private credential settings. Issue a replacement before revoking an old token when you need rotation. Revoking an agent revokes all its tokens. It invalidates work that has not started. A request already dispatched to a service cannot be recalled.

Approvals wait in the app. There are no push alerts. They expire if nobody reviews them. A native iOS app with push is future work.

Select a request to load its complete review. Nothing starts selected. The app verifies the action digest and any body or file hash before enabling Approve. Replacement review loads the whole file, up to 10 MiB. Text wraps or scrolls. Large files use numbered, expandable sections so the page stays responsive. Every section is available, including the final bytes. Binary bytes appear as base64. Control and direction characters appear as escaped codes. Downloads preserve the original bytes. The stored credential is represented by a named placeholder.

You can approve or deny one request, or explicitly select up to 20. Each member has its own digest and result. A changed or expired member can fail while others succeed. Approval permits execution. It does not mean execution succeeded. Use the history filter and audit log to check the result. Investigate an unknown send at the destination before submitting it again.

Activity refreshes every five seconds. It slows to 15 seconds after a minute without input. It pauses when the tab is hidden. Returning to the tab refreshes it. A warning appears after 30 seconds without a successful refresh when requests fail.

The audit view filters by time, agent, token, operation, file path or folder prefix, secret name, host, decision, outcome, request ID, and action ID. Use an action ID to see its timeline. Routine dashboard reads and polls are hidden by default. They remain in the log. Export downloads all matching history as JSONL or CSV. The export uses the current filters and a fixed event boundary. CSV cells escape formula prefixes.

Audit metadata is kept indefinitely. The overview shows the latest event number and an estimated metadata size. The estimate samples the most recent 100 entries; it is not a Cloudflare billing figure or a full database size. Polling does not scan all retained audit rows. File usage includes retained and staged bytes.

The app provides setup, agents, tokens, grants, approval review, activity, and audit views. File and secret management screens, policy/settings forms, and named-agent connection checks remain unfinished. Existing file and secret APIs still work. See the [documentation index](README.md) for the current gaps.

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
| `audit` | GET | Read filtered events, newest first, up to 100 per page. |
| `audit/export` | GET | Stream matching events as `format=jsonl` or `format=csv`. |

Audit filter keys are `from` and `to` (Unix milliseconds), `agent_id`, `token_id`, `operation`, `path`, `prefix`, `secret`, `host`, `decision`, `outcome`, `request_id`, and `action_id`. Use `include_routine=true` to include routine reads. `cursor` is the event ID returned as `next_cursor`. Do not carry a page cursor into a full export unless you want only older events.

Setup commits its settings and audit event together. Its retry receipt is permanent. The same key and settings return the saved result. A changed input conflicts. A different key after setup conflicts. Setup does not change Worker secrets or regenerate keys. Approval routes and states are described in [Approvals and proxy](approvals-and-proxy.md).

## Local checks

Run `npx playwright install chromium` once before browser tests. Run `npm test` for all tests or `npm run test:browser` for the owner browser checks. They serve a bundled Worker on loopback, use real local D1/R2, and stop the runtime and browser afterward. The tests create only disposable local credentials. No Cloudflare account is needed.
