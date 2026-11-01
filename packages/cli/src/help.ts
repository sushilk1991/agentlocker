export const HELP = `agentlocker — use your self-hosted Agent Locker

Credentials: AGENTLOCKER_TOKEN. Owner commands: AGENTLOCKER_OWNER_TOKEN.
Set AGENTLOCKER_URL or pass --url https://your-locker.example.com.
Tokens stay in the environment. Config stores only URL and optional label.

configure --url <origin> [--label <name>]
whoami
files list <prefix> [--cursor <cursor>] [--limit <1..100>]
files get <path> --output <file> [--force]
files put <local-file> <path> [--revision <id>] [--type <media-type>]
files delete <path> --revision <id>
secrets list [--cursor <cursor>] [--limit <1..100>]
send --secret <name> --url <destination> --method <method>
     [--header 'name: value'] [--body-file <file>]
     Use AGENTLOCKER_URL for the deployment, or --locker-url <origin>.
actions list [--cursor <cursor>] [--limit <1..100>]
actions get <id>
actions wait <id> [--timeout <seconds>]
actions result <id> [--output <file>] [--force]

admin agents list
admin agents create --name <name> [--description <text>]
admin agents update <id> [--name <name>] [--description <text>] [--status <enabled|disabled>]
admin agents revoke <id>
admin tokens create <agent-id> --label <task> --expires-in <seconds>
admin tokens revoke <agent-id> <token-id>
admin grants get <agent-id>
admin grants set <agent-id> --file <json-file>
  JSON: {"expected_version":1,"folders":[...],"secrets":[...]}
admin approvals list [--state <state>] [--limit <n>] [--offset <n>]
admin approvals show <approval-id> --output <review.json> [--force]
  Saves the complete verified input and lossless base64 bytes. Read this file.
admin approvals approve|deny <approval-id> --review <review.json>
  --digest <reviewed-sha256> [--reason <text>]
  Decisions require the saved full review. A summary alone cannot authorize.
admin audit list [--filter 'agent_id=<id>&operation=file.read']
admin audit export --output <file> [--format <jsonl|csv>] [--filter <query>]

Common: --json, --config <file>, --locker-url <origin>, --help
Mutations: --idempotency-key <key>. Keep it with the same bytes for a retry.
Agent calls: --wait [--timeout <seconds>] or --no-wait (default).
Wait defaults to 60 seconds. Ctrl-C stops the client; the action stays queued.
Exit: 0 completed; 3 pending/ready/executing; 2 denied/expired/invalidated/unknown;
1 request failure, definite execution failure, or upstream error status.
Every send needs a decision in your deployment's web app. Never resend an
unknown send automatically. Retry mappings last seven days.
`;
