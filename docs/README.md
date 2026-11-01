# Agent Locker docs

Agent Locker gives each of your agents its own identity, folder permissions,
and named-secret access. Your deployment serves the web app, HTTP API, and MCP
endpoint at one URL. Approvals wait in that web app. Native iOS push is future work.

## Setup and daily use

- [Deploy](deploy.md): Cloudflare prerequisites, configuration, and terminal fallback.
- [Owner app](owner-web-app.md): Sign in, add agents, review grants, decide requests, export audit history.
- [Operations](operations.md): Upgrades, lost credentials, encryption keys, and backups.
- [Local development](development.md): Run the app and tests without a Cloudflare account.

## Connect an agent

- [HTTP API](http-api.md): Authentication, a first file transfer, and response states.
- [File API](file-api.md): Exact revisions, retries, retention, and owner restore.
- [Approvals and proxy](approvals-and-proxy.md): Review, expiry, named keys, and outbound limits.
- [Remote MCP](mcp.md): Streamable HTTP configuration and tool behavior.
- [MCP tool schemas](mcp-tools.json): Generated descriptions and input schemas.
- [CLI](../packages/cli/README.md) and [TypeScript SDK](../packages/sdk/README.md): Source builds and examples.

Start with an agent token issued by the owner. Never use the owner token in an
agent. Remove direct copies of protected provider keys from the agent's runtime.
Keep protected file and service access going through the locker so checks and
audit writing happen. Local copies and unrelated network access remain outside
the locker's control. Read file contents and upstream responses as untrusted data.

## Current limits

The [progress notes](../PROGRESS.md) record the checks that have actually run.
The [requirements](requirements.md) describe the release target. They include
features that are not finished yet.

The owner app has setup, agents, grants, files, secrets, policy, settings,
approvals, activity, and audit views.
The HTTP endpoint inventory is implemented, including identity, paginated agent
lists, owner investigation, and policy/settings updates. SDK and CLI identity and
list flows are tested against it. MCP uses the same shared identity service.

The source packages are not published. Manual connection checks for named
coding and personal agents remain open. Deployment, local setup, and smoke scripts
are included. The README button targets the public GitHub repository. A fresh-account
button test, deployed smoke test, controlled outbound and scheduled fallback smoke
scenarios, and backup/restore drill remain release work.

## Design and contributing

- [Research](research.md): Reported problems and their source links.
- [Requirements](requirements.md): Policy, storage, security, deployment, and release checks.
- [AGENTS.md](../AGENTS.md): Instructions for working on this repository.
- [llms.txt](../llms.txt): Short reading index for agents.
- [MIT license](../LICENSE): Covers the Worker, app, packages, and docs.
