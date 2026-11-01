# Agent Locker

Files and keys for one person running several AI agents.

Give each agent its own login. Grant access to a folder or a named key. See who
read a file, changed it, or asked to send a request. Deletes, replacements, and
outbound requests wait for your approval in the web app at your deployment URL.

Each owner runs a separate Cloudflare Worker with D1 and a private R2 bucket.
There is no shared service or inbox. The code and docs use the [MIT license](LICENSE).

This is a work in progress. The file API, approvals, encrypted secrets proxy,
owner web app, remote MCP server, SDK, and CLI have local tests. The app includes
file history and restore, secret management, policy, settings, and approval review.
The React workspace includes approvals, agents, task tokens, grants, files, keys,
audit, policy, and settings.
Use the sidebar on desktop or the navigation button on a phone. The app follows
your system theme. You can choose light or dark in the navigation. The pending
count and last refresh time stay visible as you move between screens.
Deployment scripts and a local smoke check are included. A fresh-account
Cloudflare deployment check is still needed.
See [PROGRESS.md](PROGRESS.md).

## Deploy your own

You need a Cloudflare account with permission to create Workers, D1, and R2.
Enable R2 first. Its subscription checkout may require payment details, even
when your use fits the free allowance. See [Cloudflare's R2 setup guide](https://developers.cloudflare.com/r2/get-started/).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sushilk1991/agentlocker)

1. Click the button. Connect GitHub and choose your Worker and storage names.
2. Fill in `OWNER_TOKEN` with `openssl rand -hex 32` output. Fill in
   `LOCKER_ENCRYPTION_KEY` with separate `openssl rand -base64 32` output.
   Run these commands on a private terminal. Save the token in a password
   manager. Keep an offline copy of the encryption key and its version, `1`.
3. Confirm the commands, including `npm run deploy`. Cloudflare provisions D1
   and R2. The script applies migrations, deploys, and sets the assigned origin.
4. Open the printed URL. Sign in with the owner token and confirm setup defaults.
5. Create a disabled agent, grant a narrow folder, issue a task token, then
   review its grants and enable it. Keep the web app open for approvals.

The [deployment guide](docs/deploy.md) covers terminal login, safe retries,
and the opt-in smoke test. Fresh-account button deployment remains unverified.

## What an agent can do

- Read and write files under its granted folder prefixes.
- Request deletion of one exact file revision.
- Use a named key to send an HTTPS request to an allowed host.
- Poll its own requests and fetch retained results.

Saved provider keys stay inside the Worker. Agents never retrieve their values.
The Worker decrypts a key, adds it to the outgoing request, and records the
result. All sends need review, including GET and HEAD. The allowed service
receives the key, so only allow hosts you trust.

Folder read, write, and delete permissions are separate. Grants add together.
An agent cannot change its grants, approve its own requests, or edit the audit
log. Owners can revoke one agent without replacing every agent's credentials.

Approvals persist until decided or expired. The default deadline is 15 minutes.
Keep the web app open to review them. V1 has no phone push, ntfy, approval
webhook, or approval links. A native iOS app with push is future work.

Agent Locker controls access through its interfaces. It cannot stop an agent
from using a key or file it already has elsewhere. Remove direct copies of
protected keys from agent configs and environments. Move protected file access
and service calls through the locker. Use separate upstream credentials with
the narrowest permissions the service supports.

## Connect an agent

Create a disabled agent in the owner app. Give it a narrow folder grant, such as
`/notes/`. Issue an expiring task token. Review the grants, then enable the agent.
Save its token in the agent runtime's private credential settings. Never give
an agent your owner token, encryption key, or Cloudflare credentials.

| Interface | Start here |
| --- | --- |
| Remote MCP | Streamable HTTP at `/mcp`, with an agent bearer header on every request. [Tools and connection example](docs/mcp.md). |
| HTTP | Bearer-authenticated routes under `/api/v1`. [Routes and examples](docs/http-api.md). |
| CLI | Build from source, then run `node packages/cli/dist/index.js`. [Commands and exit codes](packages/cli/README.md). |
| TypeScript | Fetch client with no runtime dependencies. [SDK examples](packages/sdk/README.md). |

Use the same scoped agent identity across interfaces. There is no MCP OAuth flow
in v1. A client must support remote Streamable HTTP with bearer headers, or use
HTTP or the CLI. Manual checks for named coding and personal agent clients are
still pending. The SDK and CLI have not been published to npm.

Pending means the action is waiting. It does not mean the file changed or the
request was sent. Approval and execution are separate. An `unknown` send may
have reached the service; check there before sending again. Never retry it
automatically. [States, retries, and limits](docs/approvals-and-proxy.md).

## Work on the code

Use Node 20.19 or newer and npm. From a clean checkout:

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run test:mcp
npm run test:browser
npm run build
```

`npm test` includes unit, local D1/R2 integration, and browser tests. The MCP
check uses the real official client against a disposable local Worker. The build
command is a Wrangler dry-run. These commands do not deploy. Chromium may need
system libraries on a fresh Linux machine.
`npm run test:browser` runs the Chromium flows at 1280px and 390px in light and
dark. It saves screenshots beside the checkout in `../agentlocker-shots/`.

See [local development](docs/development.md) for running your own local locker.
Read [AGENTS.md](AGENTS.md) before changing the code.

## Read more

- [Documentation index](docs/README.md) and [agent reading index](llms.txt).
- [Owner app](docs/owner-web-app.md): agents, grants, approvals, live activity, audit export.
- [File API](docs/file-api.md): revision checks, history, and restore.
- [Approvals and secrets proxy](docs/approvals-and-proxy.md): exact review and secret use.
- [Operations](docs/operations.md): upgrades, lost tokens, key rotation, and backup limits.
- [Research](docs/research.md): the problems behind the design, with source links.
- [Requirements](docs/requirements.md): the release contract; some work remains.

Keep separate backups. Retained revisions and an audit export do not back up
the whole locker. Local tests do not replace a deployed smoke test or a restore
drill. A local smoke run does not verify Cloudflare deployment or recovery.
