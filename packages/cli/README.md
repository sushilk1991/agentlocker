# agentlocker CLI

Use the public HTTP API from a terminal or an agent. Requires Node 20.19+.
MIT licensed. No direct D1 or R2 access.

From the repository:

```sh
npm ci
npm run clients:build
export AGENTLOCKER_URL=https://your-locker.example.com
export AGENTLOCKER_TOKEN='<agent-token>'
node packages/cli/dist/index.js --help
# Or: npm run cli -- --help
```

The package provides the `agentlocker` command when installed. This chunk builds
and tests the package. It does not publish to npm.

```sh
agentlocker configure --url https://your-locker.example.com --label coding
agentlocker whoami
agentlocker files list /notes/ --json
agentlocker files put ./draft.txt /notes/draft.txt --json
agentlocker files get /notes/draft.txt --output ./download.txt
agentlocker files delete /notes/draft.txt --revision '<revision>' --json
agentlocker actions wait '<action-id>' --timeout 60 --json
agentlocker actions result '<action-id>' --output ./result.bin
```

`configure` checks identity before writing. It saves only the URL and optional
label, in `~/.config/agentlocker/config.json`. Set `AGENTLOCKER_CONFIG` or use
`--config` to choose another file. URL precedence is `--locker-url` (or `--url`
except for send), `AGENTLOCKER_URL`, then config. Credentials come only from the
environment. They are never copied to config or debug logs.

Current Worker boundary: `configure` and `whoami` need the remaining `/whoami`
route. `actions list` also awaits its Worker route. The commands are implemented
and contract-tested; the current Worker returns `not_found`. Secret listing works
without pagination; its HTTP pagination support belongs to that later chunk.
Set `AGENTLOCKER_URL` to use the implemented file and approval flows now.

Uploads stream over HTTP and are create-only by default. A replacement needs
`--revision <id>` and owner approval. Uploads allow 10 MiB. Downloads publish the
complete file atomically. Existing outputs need `--force`; failed downloads leave
no partial output. Rule-gated reads return an action until approved. `--wait`
on a file get downloads the retained result after success.

Mutating commands generate one idempotency key and include it in output. To resume,
pass `--idempotency-key <same-key>` with the same inputs and bytes. Rule-gated reads
also accept this flag. Keep the key before retrying an uncertain call. Server
mappings last seven days. After that, the same key may create a new action.
Clients never submit a mutation automatically a second time.

The default is `--no-wait`. `--wait` polls to a 60-second deadline; use `--timeout`
to change it. `actions wait` always waits. Ctrl-C stops waiting and prints the
action ID. It does not cancel or deny the persisted action.

| Exit | Meaning |
| --- | --- |
| 0 | Completed successfully. |
| 3 | Pending, ready, or executing at the deadline; also an interrupted known wait. |
| 2 | Denied, expired, invalidated, or unknown. |
| 1 | Request failure, definite execution failure, or upstream 4xx/5xx. |

`--json` emits one JSON object with wire states, IDs, request ID where available,
and the generated idempotency key. Errors use `error.code` and `error.message`.
Human output escapes terminal control characters too. A complete proxy response
has a separate `upstream_status`. `actions result --output` saves the complete JSON
envelope for proxy results, including its base64 bytes. Binary results need
`--output`. Status/result reads never trigger execution.

```sh
agentlocker send --secret mail-api --url https://api.example.com/messages \
  --method POST --header 'content-type: application/json' --body-file ./message.json \
  --idempotency-key '<saved-key-at-least-16-characters>' --json
```

For send, `--url` is the upstream URL. Use `AGENTLOCKER_URL` or `--locker-url` for
the locker. Do not put provider keys in headers or body files. Save them in the
locker and select `--secret`. Every send, including GET, needs owner approval.
An unknown send may already have reached the provider. Check it before sending
anything again.

Owner commands use only `AGENTLOCKER_OWNER_TOKEN`. They are under `admin`.
The web app remains the primary owner interface. Run `--help` for agent, token,
grant, approval, and audit commands. Token issuance prints a newly created token
once, marks the output sensitive, and never saves it. If that output is lost,
revoke that token and issue another. Do not blindly retry owner token creation.

CLI approval requires a complete saved review:

```sh
agentlocker admin approvals show '<approval-id>' --output ./review.json --json
# Read the entire file. Decode and inspect content_base64 as needed.
# Check destination, query, headers, body, current grants, and expiry.
agentlocker admin approvals approve '<approval-id>' --review ./review.json \
  --digest '<sha256-from-reviewed-file>' --reason 'Reviewed' --json
```

The review contains all input fields and lossless base64 content. No shortened
terminal summary can authorize. The CLI verifies the action digest and content
hashes before saving, verifies the saved file before deciding, then fetches and
compares the current review. The server rechecks everything at decision time.
`deny` takes the same review/digest arguments. Review files can contain sensitive
content. They are written with mode 0600; delete them when finished.

Audit filters use a query string:

```sh
agentlocker admin audit list --filter 'operation=file.read&limit=50' --json
agentlocker admin audit export --filter 'agent_id=<agent-id>' \
  --format jsonl --output ./audit.jsonl
```

Run `npm run test:clients` from the repository root for SDK/CLI tests, including
the built CLI against the bundled local Worker with real D1/R2. No deployment or
provider credentials are needed. Native iOS push is future work. V1 approvals
wait in your deployment's web app until decided or expired.
