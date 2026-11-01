# Progress

## Done
- Read docs/research.md and the complete v1 requirements.
- Confirmed browser approvals only. Native iOS push is future work.

## Chunk 01 — Worker core complete (01 Nov 2026)
- Reviewed the research and the requirements for identity, grants, D1, and audit writing.
- Reviewed the existing owner and agent authentication, hashed tokens, expiry and revocation checks, folder and named-secret grants, and audit writer. No code changes were needed in this review.
- Confirmed owner-only mutations, canonical path checks, independent grant permissions, grant expiry, version conflicts, and atomic rollback when a grant or audit write fails.
- Reviewed migrations 0001 and 0002, including schema compatibility, upgrade preservation, permanent revocation, and append-only audit triggers.
- Verification: `npx tsc --noEmit` passed. `npx vitest run` passed **81/81 tests across 5/5 files**: auth 18, grants 16, audit 15, migrations 6, paths 26. These are the observed counts; the resume note listed 75.
- Used the existing tests unchanged. D1 tests ran against local Miniflare with the production migrations. `fileParallelism` remains false. No local socket failure occurred, so no rerun was needed.
- Stopped at this chunk. HTTP routing, file/secret services, approvals UI, MCP client tests, SDK, CLI, and deployment checks remain for later chunks. No push or deployment was run.

## Chunk 02 — File API complete (01 Nov 2026)
- Read the research and the file, policy, storage, HTTP, idempotency, and test requirements for this chunk.
- Added Worker file routes for scoped listing, metadata, binary reads, conditional writes, exact-revision soft deletes, owner revision history/downloads, and owner restore. Downloads are private attachments with revision ETags and SHA-256 hashes. Owner replacement and delete routes require explicit confirmation headers.
- Added immutable private R2 staging and D1 quota reservations before upload. Publication commits the exact revision pointer, retention, action result, and audit result together. Concurrent writes against one revision cannot both publish. Failed uploads and failed final commits leave no visible file change and keep reserved bytes charged.
- Added seven-day default history retention, owner restore with a current-path precondition, restore deadlines, and bounded hourly cleanup. Cleanup preserves current content, live staged actions, and retained action results. Failed R2 deletion keeps the quota reservation. Tombstones remain after their contents expire.
- Added seven-day identity-scoped idempotency mappings with concurrent retry deduplication and changed-input conflicts. Restore retries still resolve after source history expires.
- Agent replacements and deletes persist pending approvals. Owner-rule-gated reads, listings, metadata, and new writes also persist pending actions. Parent listings cannot bypass a child-folder review rule. The file mutation executor rechecks the action digest, content integrity, exact revision, policy, original credential, grant, and expiry before commit.
- Added migration 0003 and schema version 3. It preserves schema-2 current and historical revision metadata, guards immutable revision content and encrypted file inputs, and supports atomic conditional commit checks.
- Added docs/file-api.md with route, revision, retry, quota, retention, and pending-action behavior in plain words. Native iOS push remains future work; no push or ntfy was added.
- Verification: `npx tsc --noEmit` and `git diff --check` passed. `npx vitest run` passed **134/134 tests across 8/8 files**: files 23, file actions 10, file HTTP 19, migrations 7, auth 18, grants 16, audit 15, paths 26. Tests use real local D1/R2 and production migrations. HTTP tests run the bundled Worker through Miniflare, including a lossless 10 MiB transfer and the over-limit case. Failure injection covers upload, audit/commit, and cleanup failures. No workerd socket flakiness occurred. `fileParallelism` remains false and every Miniflare runtime is disposed.
- Handoff boundary: the shared approval decision/claim/expiry engine, execution/result retrieval for rule-gated reads, immediate/scheduled approval dispatch, and owner web app remain for later chunks. There is no HTTP approval shortcut. Tests authorize pending mutations only through their database fixture before calling the internal file executor. MCP/SDK/CLI, complete owner routes, setup, and deployment checks are unchanged future chunks.
- Stopped at this chunk. No git push or deployment was run.

## Chunk 03 — Approvals and secrets proxy complete (01 Nov 2026)
- Read the research and the requirements for secret containment, proxy validation, exact approval, states, expiry, result retention, HTTP responses, and tests. This checkout already contained the first implementation of this chunk. Reviewed it, ran its tests, and fixed the issues below.
- Confirmed pending deletes, replacements, and all proxy methods, including GET and HEAD. Owner-only POST decisions bind the displayed digest to immutable encrypted input. Decision and execution transactions recheck database time, original credentials, grants, policy, file revisions, and secret versions. Individual and bounded batch decisions retain their audit records.
- Confirmed separate approval and execution states, one-winner claims, immediate dispatch with scheduled fallback, dispatch markers before fetch, terminal reconciliation to unknown for abandoned sends, and protection against late completions. Status and result reads never dispatch. Approved file mutations and rule-gated reads use the shared engine.
- Confirmed AES-GCM secret storage and encrypted queued inputs/results. Saved values have no retrieval endpoint. Named grants permit proxy use only. The proxy validates exact public hosts, injects the selected credential, disables redirects, bounds requests/responses, strips credential and cookie headers, and redacts literal key echoes across response chunks. Timeout and incomplete responses remain unknown and are never automatically retried.
- Fixed bounded payload cleanup so successive sweeps skip already-cleared records and drain the backlog. A real D1 regression uses 105 expired actions and verifies that metadata survives while encrypted inputs/results are erased.
- Fixed response filtering to remove legacy cookie headers and headers named by upstream Connection. Extended the secret-never-leaked test to cover these headers alongside body/header echoes, stored results, audit events, and captured logs.
- Fixed terminal submission retries to return HTTP 200 with the recorded state, without Retry-After. Pending/ready/executing responses remain 202. A bundled Worker HTTP test verifies a denied retry retains the action and deadline without sending.
- Reviewed migration 0004 and schema version 4, and updated docs/approvals-and-proxy.md. No push service or approval links were added. The owner web app and native iOS push remain separate later work.
- Verification: `npx tsc --noEmit`, `npx vitest run`, and `git diff --check` passed. Full suite: **193/193 tests across 11/11 files**: approvals 13, proxy 40, approval HTTP 6, files 23, file actions 10, file HTTP 19, migrations 7, auth 18, grants 16, audit 15, paths 26. New regression assertions failed before their fixes and passed afterward. Tests use real local D1/R2 and production migrations; HTTP tests run the bundled Worker. No local workerd socket failure occurred. `fileParallelism` remains false and test runtimes are disposed.
- Stopped at this chunk. No git push or deployment was run.

## In progress
- Remaining Worker routes, owner web app, MCP, SDK, and CLI.
- Browser checks and tests with the official MCP client over HTTP.

## Next
- Continue with the next bounded chunk for the remaining services and clients. Shared approval execution is connected to stored file actions.
- Run type checking and tests for each chunk. Browser checks and the real wrangler dev MCP client test belong to their later chunks.
- Record exact counts and release checks that need a disposable Cloudflare account.
- No git push or production deployment in this task.

## Runner change (01 Nov 2026, 04:30 IST)
- Requirements doc complete (sections 12 deploy, 13 testing, 14 success criteria).
- Build now runs in 8 small chunks via /workspace/alrun/run.sh (resumable, 45m timeout, stall watchdog, local git commit after each chunk). Status: /workspace/alrun/runner.log.
