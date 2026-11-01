# Deploy to Cloudflare

Each owner gets one Worker URL, one D1 database, and one private R2 bucket in
their own Cloudflare account. The Worker serves the owner app, HTTP API, and MCP.
There is no shared Agent Locker account or approval inbox.

## Current status

The Wrangler template can be bundled locally. The one-click flow is not ready
for release. This checkout has no public git remote, so the README button has
an explicit repository placeholder. `npm run deploy` points to
`scripts/deploy.mjs`, which is missing. `npm run test:smoke` is also unfinished.
No fresh-account deployment has been verified. Do not describe this as a tested
one-click setup until those gaps are closed.

Cloudflare's [button guide](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
explains repository cloning, storage provisioning, secret inputs from
`.dev.vars.example`, and build/deploy commands. The package already describes the
two secret fields. Provisioning must still set the public origin and deployment
ID, and explicitly apply migrations before the app can be used. `migrations_dir`
alone does not run migrations.

## Before you start

Use a Cloudflare account that can create Workers, D1 databases, and R2 buckets.
Enable an R2 subscription first. Cloudflare's checkout may ask for payment
details. Included usage does not mean that every account can skip checkout.
See [R2 setup](https://developers.cloudflare.com/r2/get-started/).

The app is intended for small personal use. Check current
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), and
[R2 pricing](https://developers.cloudflare.com/r2/pricing/) for your account.
No deployed usage measurement is recorded yet. The cron runs once per minute:
1,440 scheduled invocations per day, or 43,200 in 30 days. It expires approvals,
dispatches approved work, and reconciles interrupted attempts. File cleanup
runs at most hourly. Dashboard polls and agent reads write audit events, so
request count alone does not describe D1 usage. Audit metadata is retained
indefinitely. Review usage in the dashboard and Cloudflare.

## Configuration

Use the pinned Wrangler from `npm ci`. Do not change its version without running
the tests. The checked-in `wrangler.jsonc` contains template names, an all-zero
placeholder database UUID, and no live account IDs or credentials. The placeholder
lets local migrations resolve `DB`; provisioning must replace it before remote
migrations. Keep the application source unchanged during setup.

| Setting | Value for your deployment |
| --- | --- |
| `name` | A unique Worker name you choose. |
| `DB` | Your D1 database name and UUID; migrations stay in `migrations/`. |
| `FILES` | Your private R2 bucket name. Keep public access and public domains disabled. |
| `PUBLIC_ORIGIN` | Exact assigned HTTPS origin, without a path or trailing slash. |
| `DEPLOYMENT_ID` | Random value made once for this locker. Keep it with backups. |
| `ENCRYPTION_KEY_VERSION` | `1` for a new locker. |
| `OWNER_TOKEN` | Worker secret: at least 32 random bytes, encoded as hex. |
| `LOCKER_ENCRYPTION_KEY` | Separate Worker secret: 32 random bytes, encoded as base64. |

Blank origin and deployment ID are intentional. Protected requests and scheduled
work stay closed until configuration is valid and owner setup is complete.
The public `/healthz` response only proves that the Worker can respond. It does
not prove that bindings, secrets, schema, or setup are ready.

Generate the owner token and encryption key separately on a trusted terminal.
These commands print sensitive values; do not run them in CI or a shared session:

```sh
openssl rand -hex 32
openssl rand -base64 32
```

Save the first in a password manager. Keep an offline copy of the second and
its version. Never put either in a URL, command argument, build log, or checked-in
config. A deployment ID is not a credential. Generate it with
`openssl rand -hex 16` and put it in `vars.DEPLOYMENT_ID`. Do not regenerate it
for updates; it is part of the encryption context.

## Terminal fallback for a disposable deployment

These are manual operator commands, not a completed one-click installer. They
change your Cloudflare account. They have not been exercised against a live
account in this chunk. Use fresh disposable resources for the release check.

1. Clone your public repository, run `npm ci`, then `npx wrangler login`.
   Choose a unique Worker name in `wrangler.jsonc`. Create storage once:

   ```sh
   npx wrangler d1 create <your-database-name>
   npx wrangler r2 bucket create <your-bucket-name>
   ```

   Fill in the returned database ID and selected resource names in your private
   deployment copy of `wrangler.jsonc`. Keep the binding names `DB` and `FILES`.
   On a retry, use the same resources. Check `npx wrangler d1 list` and
   `npx wrangler r2 bucket list` instead of creating more resources.

2. Set the generated deployment ID. Leave `PUBLIC_ORIGIN` blank for the first
   upload. Apply the schema, then upload the closed Worker. Run each command
   only if the preceding command succeeded:

   ```sh
   npm run db:remote
   npx wrangler deploy
   ```

   `db:remote` explicitly applies migrations to binding `DB`. If migration fails,
   stop here. Inspect the error and selected database, then rerun migrations.
   Do not delete the database, edit migration tracking, or enable agents to fix it.

3. Copy the assigned HTTPS origin into `vars.PUBLIC_ORIGIN`. Enter the saved
   values through Wrangler's protected prompts, then upload the configured Worker:

   ```sh
   npx wrangler secret put OWNER_TOKEN
   npx wrangler secret put LOCKER_ENCRYPTION_KEY
   npx wrangler deploy
   ```

   Do not regenerate or overwrite existing keys when resuming setup. The first
   upload is closed; a missing secret, blank origin, missing schema, or unfinished
   owner setup prevents agent access and dispatch.

4. Open that exact URL. Sign in with the owner token. Confirm the approval expiry,
   file quota, and retention. The first defaults are 15 minutes, 1 GiB, and seven
   days. Setup is authenticated; an anonymous visitor cannot claim the locker.
   Reloading requires sign-in again. There are no push alerts.

5. Create a disabled agent, grant a narrow folder, and issue an expiring task
   token. Copy the token once, review its grants, then enable the agent. Follow
   the [HTTP example](http-api.md) or [MCP guide](mcp.md). Verify a pending delete
   in the owner app before using important data. Finish the deployed smoke and
   backup/restore checks in requirements sections 12–14 before calling it a release.

Changing a domain means explicitly updating `PUBLIC_ORIGIN`, deploying, and
updating every client URL. The server will not trust the first request's Host or
Origin. Keep preview URLs disabled. Local development uses local storage bindings;
never use remote development with a production token or resource.

## Finish the button flow before release

The maintainer must fill in the public repository URL in the README button and
test it from a fresh Cloudflare account. Deployment tooling must reuse selected
resources, preserve existing secrets and deployment ID, apply migrations with
failure stopping deployment, set the assigned canonical origin, and leave the
app closed on any setup failure. Required secret entry and confirmations must
fit the five-step limit in requirements section 12.

Do not silently fall back to plain `wrangler deploy` while the configured deploy
script is missing. The terminal procedure above explicitly covers its missing
steps. Document verified setup, usage, smoke, and restore results in
`PROGRESS.md`. Do not mark them passed based on a local dry-run.
