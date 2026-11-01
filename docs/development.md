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
| `npm run typecheck` | Worker, CLI, SDK, and React app types. |
| `npm test` | Vitest units, local D1/R2 integration, browser checks, and client tests. |
| `npm run test:browser` | Owner app in Chromium, including polling and complete reviews. |
| `npm run test:mcp` | Official MCP client against a real disposable `wrangler dev` process. |
| `npm run test:clients` | SDK/CLI units and real local HTTP and Worker clients. |
| `npm run clients:build` | SDK declarations and standalone CLI output. |
| `npm run build` | Vite UI build, then Wrangler `--dry-run`; no deployment. |

Tests use production SQL migrations and disposable credentials. They dispose
their runtimes and stop child servers. Keep Vitest `fileParallelism: false`.
For a test that fails only with a local workerd socket error (`fetch failed`,
`other side closed`, or `ECONNRESET`), rerun its file once, then the full suite:

```sh
npx vitest run tests/<failing-file>.test.ts
npm test
```

Do not change app code for that error alone. `npm run test:smoke` is opt-in and
targets the exact URL and owner credential in the environment. A local smoke
pass does not prove Cloudflare deployment or backup/restore works.

## Run a local locker

Run setup from the repository root. It writes ignored `.dev.vars` with mode
0600, refuses to overwrite it, and applies local D1 migrations. It prints no
credentials. It creates fresh owner and encryption credentials and a deployment
ID. The default trusted origin is exactly `http://localhost:8787`.

```sh
npm run setup:local
npm run dev
```

Open `http://localhost:8787`. Read `OWNER_TOKEN` from `.dev.vars` in your local
editor and enter it in the sign-in form. Confirm setup, create a disabled agent,
add a narrow folder grant, issue a task token, and enable it. Use this exact
origin; `127.0.0.1` is a different origin. Stop Wrangler with Ctrl-C when done.

For a disposable local smoke check, leave Wrangler running. In a second Bash
terminal, read the token from your editor and enter it at the hidden prompt:

```sh
read -rsp 'Local owner token: ' AGENTLOCKER_OWNER_TOKEN
export AGENTLOCKER_OWNER_TOKEN
AGENTLOCKER_URL=http://localhost:8787 npm run test:smoke
unset AGENTLOCKER_OWNER_TOKEN
```

Smoke confirms first-run setup if needed. It creates two disposable agents with
disjoint grants, checks HTTP, SDK, MCP, approvals, restore, audit, and revocation,
then disables agents and its secret, revokes tokens, and soft-deletes its files.
It keeps audit and retained history. Use a disposable locker: changing grants
can invalidate other pending approvals. No proxy request is sent. See the
[deployment guide](deploy.md#smoke-check) for scope and remaining release checks.

Wrangler stores local data under `.wrangler/state`. Keep `.dev.vars` and this
state together between runs. Replacing the encryption key or deployment ID
breaks decryption of existing data. The example secret file contains placeholders,
not usable credentials. Never copy production credentials into it.

The Wrangler config sets both storage bindings to local development. Do not use
`wrangler dev --remote`, remote binding overrides, or `npm run db:remote` here.
If you need another origin or port, change the local `PUBLIC_ORIGIN` explicitly
and restart. Before first setup, you can instead set `AGENTLOCKER_LOCAL_ORIGIN`
when running `npm run setup:local`. Only HTTP localhost and 127.0.0.1 are accepted.
If migrations fail after the file is written, keep it and run `npm run db:local`.
The app does not learn a trusted origin from incoming requests.

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

## Owner UI build

The React and TypeScript app lives in `web/`. Vite and Tailwind build it into
ignored `dist-web/`. UI primitives live in `web/src/components/ui/`. Routes load
separately. The typed owner client calls the existing HTTP routes.

`npm run web:build` builds only the UI. `npm run dev` builds it before starting
Wrangler and rebuilds after UI edits. Reload the browser to see changes. It serves
the app and API at the same URL, with the production security headers. Stop it
with Ctrl+C. Wrangler flags still work, such as `npm run dev -- --port 8788`.
`npm run build` builds the UI and
then runs the Worker deploy dry-run. The deployment script builds the UI before
any remote step. The Cloudflare button still uses `npm run deploy`.

Workers static assets use `ASSETS` with `run_worker_first: true`. Only known app
paths fall back to the entry HTML. API, MCP, health, and unknown paths remain
Worker routes. The Worker applies origin checks, no-store, and CSP to assets.
Scripts load from this origin. Runtime Radix and Sonner styles use a fresh style
nonce from the HTML response. CSP permits neither inline scripts nor arbitrary
inline styles. The Vite Sonner transform fails if its expected integration point
changes during a dependency upgrade.

Browser tests build production assets once before using real Miniflare static
assets, D1, and R2. All owner screens run at 1280 and 390 pixels. Checks cover complete approval
review, task tokens, grant expiry and conflicts, file versions and restore, key
containment, audit filters and exports, settings conflicts, and sign-out clearing.
