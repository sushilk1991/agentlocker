# Local development

Use Node 20.19 or newer and npm. Local D1 and R2 run through Wrangler or
Miniflare. You do not need a Cloudflare account for local tests or the owner app.
Never run local development against a production database or bucket.

## Install and check

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run test:mcp
npm run build
```

On Linux, Chromium may need system libraries. Playwright's
`npx playwright install --with-deps chromium` can install them when you have
permission to install system packages.

| Command | What it checks |
| --- | --- |
| `npm run typecheck` | Worker, CLI, tests, and SDK types. |
| `npm test` | Vitest units, local D1/R2 integration, browser checks, and client tests. |
| `npm run test:browser` | Owner app in Chromium, including polling and complete reviews. |
| `npm run test:mcp` | Official MCP client against a real disposable `wrangler dev` process. |
| `npm run test:clients` | SDK/CLI units and real local HTTP and Worker clients. |
| `npm run clients:build` | SDK declarations and standalone CLI output. |
| `npm run build` | Wrangler bundle with `--dry-run`; no deployment. |

Tests use production SQL migrations and disposable credentials. They dispose
their runtimes and stop child servers. Keep Vitest `fileParallelism: false`.
For a test that fails only with a local workerd socket error (`fetch failed`,
`other side closed`, or `ECONNRESET`), rerun its file once, then the full suite:

```sh
npx vitest run tests/<failing-file>.test.ts
npm test
```

Do not change app code for that error alone. A separate deployed smoke script
is planned; `npm run test:smoke` currently points to a missing file. Nothing in
the local checks proves a production deployment or backup/restore works.

## Run a local locker

`npm run setup:local` also points to a missing file. Until that script exists,
create local settings with this command from the repository root. It writes an
ignored file with mode 0600 and refuses to overwrite an existing file. It prints
no credentials.

```sh
node --input-type=module <<'NODE'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const values = {
  OWNER_TOKEN: randomBytes(32).toString('hex'),
  LOCKER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  PUBLIC_ORIGIN: 'http://127.0.0.1:8787',
  DEPLOYMENT_ID: randomBytes(16).toString('hex'),
  ENCRYPTION_KEY_VERSION: '1',
};
writeFileSync('.dev.vars', Object.entries(values)
  .map(([name, value]) => `${name}=${value}\n`).join(''),
  { mode: 0o600, flag: 'wx' });
NODE
npm run db:local
npm run dev -- --ip 127.0.0.1 --port 8787
```

Open `http://127.0.0.1:8787`. Read `OWNER_TOKEN` from `.dev.vars` in your local
editor and enter it in the sign-in form. Confirm setup, create a disabled agent,
add a narrow folder grant, issue a task token, and enable it. Use this exact
origin; `localhost` is a different origin. Stop Wrangler with Ctrl-C when done.

Wrangler stores local data under `.wrangler/state`. Keep `.dev.vars` and this
state together between runs. Replacing the encryption key or deployment ID
breaks decryption of existing data. The example secret file contains placeholders,
not usable credentials. Never copy production credentials into it.

The Wrangler config sets both storage bindings to local development. Do not use
`wrangler dev --remote`, remote binding overrides, or `npm run db:remote` here.
If you need another origin or port, change the local `PUBLIC_ORIGIN` explicitly
and restart. The app does not learn a trusted origin from incoming requests.

## Change an interface

Keep authorization and audit writing in the shared Worker services. Build client
packages with `npm run clients:build`. If MCP tools change, regenerate discovery:

```sh
npx tsx scripts/generate-mcp-schema.ts
npm run test:mcp
```

Update the relevant guide and `PROGRESS.md` with observed results. State any
remaining screen, compatibility, or deployment gap. Do not deploy or publish as
part of a local check.
