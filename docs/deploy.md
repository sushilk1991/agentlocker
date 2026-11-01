# Deploy to Cloudflare

Each owner gets one Worker URL, one D1 database, and one private R2 bucket in
their Cloudflare account. The Worker serves the web app, HTTP API, and MCP.
V1 approvals wait in that web app. Native iOS push is future work.

## Before you start

Enable R2 on your Cloudflare account first. Its subscription checkout may ask
for payment details even when usage fits the free allowance.
See [R2 setup](https://developers.cloudflare.com/r2/get-started/).
You need permission to manage Workers, D1, R2, and Worker secrets.

The [README button](../README.md#deploy-your-own) targets
`https://github.com/sushilk1991/agentlocker`. It follows Cloudflare's
[Deploy button flow](https://developers.cloudflare.com/workers/platform/deploy-buttons/):
the button clones the public repository, provisions the `DB` and `FILES`
bindings in `wrangler.jsonc`, and runs the package deploy command in Workers Builds.
Secret fields come from `.dev.vars.example`; `package.json` describes them.
Keep the detected `npm run deploy` command. Plain `wrangler deploy` skips the
migration and origin steps.

Generate each credential separately on a private terminal:

```sh
openssl rand -hex 32
openssl rand -base64 32
```

Save the first value as `OWNER_TOKEN` in a password manager. Keep an offline
copy of the second, `LOCKER_ENCRYPTION_KEY`, with encryption key version `1`.
Paste them only into the matching Cloudflare secret fields or protected Wrangler
prompts. Never put values in command arguments, URLs, git, or build logs.
Updates reuse the existing credentials. Deployment never generates or changes them.

After deployment, open the printed URL. Sign in with the owner token and confirm
setup. Defaults are a 15-minute approval deadline, 1 GiB file quota, and seven-day
file history. Create a disabled agent, grant a narrow folder, issue an expiring
task token, review grants, and enable the agent. Reloading requires sign-in again.

The scripts have local checks. No fresh-account button deployment has been run
yet. A local dry-run does not verify Cloudflare provisioning, billing, or secrets.

## Terminal login

Use Node 20.19 or newer and the pinned Wrangler installed by `npm ci`.
These commands change your Cloudflare account; local checks do not run them.

1. Clone the repository, run `npm ci`, then `npx wrangler login`.
2. Choose a unique `name`, D1 `database_name`, and R2 `bucket_name` in your
   private deployment copy of `wrangler.jsonc`. Keep binding names `DB` and
   `FILES`. Set `account_id` there or `CLOUDFLARE_ACCOUNT_ID` if you have several
   accounts. Keep real identifiers out of commits.
3. Generate and save the two credentials above. Enter them through protected
   prompts. Wrangler may ask to create a placeholder Worker on the first call:

   ```sh
   npx wrangler secret put OWNER_TOKEN
   npx wrangler secret put LOCKER_ENCRYPTION_KEY
   ```

4. Run `npm run deploy`. It resolves the selected storage names, creates missing
   resources, applies remote migrations, and uploads the Worker. It prints the
   URL after setting the canonical origin.
5. Open that URL, sign in, and confirm setup. Create and enable your first scoped
   agent in the web app. Follow the [HTTP](http-api.md) or [MCP](mcp.md) guide.

Keep the ignored `.agentlocker/` directory. It records selected bindings and
non-secret deployment settings. Terminal secret commands above use the same
Worker name as the source config. The deploy script uses its saved config at
`.agentlocker/wrangler.json`. Use a separate checkout for a different locker.

## Deployment and retries

`scripts/deploy.mjs` uses Wrangler for both a Builds API token and terminal OAuth
login. It reads the active deployed versions before uploading. It preserves an
existing `DEPLOYMENT_ID`, even on a fresh CI checkout. Conflicting IDs, storage
bindings, or mixed live origins stop deployment. It does not read secret values.
Wrangler preserves Worker secrets across code deployments.

The script records a new random ID before its first upload. It checks that R2
has neither a public `r2.dev` URL nor a custom domain. It explicitly runs
`wrangler d1 migrations apply DB --remote` before deploying. A failure stops all
later steps. Applied migrations are skipped on retry. Never reset the database,
edit released migrations, or erase setup, grants, or audit history to recover.

When the origin is blank, the first upload stays closed. The script takes the
assigned HTTPS `workers.dev` URL from Wrangler's deploy result, saves it as
`PUBLIC_ORIGIN`, and uploads again. Requests never select a trusted origin.
Missing secrets, incompatible schema, and unfinished setup block agent access.
The public `/healthz` body is only `ok`; it does not prove readiness.

If a step fails, fix the reported account, resource, secret, or configuration
issue and rerun `npm run deploy` with the same config and deployment record.
The error includes the step and Cloudflare error codes when available. Captured
Wrangler output stays private because it can contain bindings. Inspect account
resources in Cloudflare if needed. Do not regenerate an existing encryption key
or deployment ID. Both are needed to decrypt saved data.

For a custom domain, set `vars.PUBLIC_ORIGIN` explicitly in the deployment copy
of `wrangler.jsonc`, configure that domain in Cloudflare, redeploy, and update
client URLs. Preview URLs stay disabled. Before upgrades, follow the backup and
migration limits in [operations](operations.md). Backup/recovery tooling and its
disposable restore drill remain separate release work.

## Smoke check

Use an explicitly selected disposable locker. This test creates agents, grants,
files, and one disposable secret. Grant and secret changes can invalidate other
pending approvals, so use an isolated deployment without real agent work.
No outgoing proxy request is approved or sent by this script.

Set `AGENTLOCKER_URL` to the exact origin, with no trailing slash. Supply
`AGENTLOCKER_OWNER_TOKEN` through your private environment. In Bash, prompt for
the token without putting it in command history:

```sh
export AGENTLOCKER_URL=https://your-locker.your-subdomain.workers.dev
read -rsp 'Owner token: ' AGENTLOCKER_OWNER_TOKEN
export AGENTLOCKER_OWNER_TOKEN
npm run test:smoke
unset AGENTLOCKER_OWNER_TOKEN
```

The test confirms setup if needed. It checks minimal health, HTML, authentication,
HTTP and SDK binary files, disjoint agent grants, the official MCP client,
pending exact-revision deletion, owner approval, restore, denial, unlisted-host
rejection before queuing, audit list/export, and HTTP/MCP token revocation.
Each check prints PASS or FAIL and request IDs. Tokens and private bodies are
never printed. Cleanup attempts every step even after failure: disable agents,
revoke issued tokens, soft-delete its current files, and disable its secret.
Audit evidence and retained revisions remain under the normal retention policy.
If cleanup fails, the command fails; use the printed run ID to find its resources.

Run the same script locally with `AGENTLOCKER_URL=http://localhost:8787` after
`npm run setup:local` and `npm run dev`. Use the generated owner token from
`.dev.vars`. See [local development](development.md).

The current script covers the bounded smoke flow above. Controlled public
outbound approval/echo, expiry without dispatch, and scheduled fallback smoke
scenarios from requirements section 13 remain release work. Local tests cover
these services with controlled upstreams. They do not prove deployed TLS,
scheduling, R2 privacy, real outbound fetch, or a complete backup restore.

## Usage

Check current [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/), and
[R2](https://developers.cloudflare.com/r2/pricing/) pricing for your account.
The cron runs once per minute, or 43,200 scheduled invocations in 30 days.
Dashboard polls and agent reads write audit events. Audit metadata is retained
indefinitely. No deployed usage measurement is recorded yet. Review usage in
the owner dashboard and Cloudflare.
