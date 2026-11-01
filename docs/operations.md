# Operating a locker

Keep the owner token in a password manager. Keep an offline copy of each
encryption key, its version, and the deployment ID. These are separate from the
database. Keep a record of the Worker name, D1 ID, R2 bucket, canonical origin,
application version, and applied migrations. Treat files and exports as private.

## Credentials

To replace a lost or exposed owner token, generate a new 32-byte random value
as hex on a trusted terminal. Save it, then use Cloudflare's Worker secret editor
or the protected prompt:

```sh
npx wrangler secret put OWNER_TOKEN
```

Existing tabs must sign in with the new value. Do not clear D1 setup state.
Replacing the owner token does not require changing encryption keys or agents.

Agent task tokens appear once. Issue a new one, update the agent's private
credential settings, then revoke the old token. If exposure is suspected, revoke
first. Disable or revoke the whole agent when necessary. Revocation blocks new
access and unclaimed work; it cannot recall a send that has already reached a
service. Remove direct copies of protected provider keys from agent configs.

Rotate a provider key by saving a replacement through the owner secret API.
See [secret setup](approvals-and-proxy.md). Saved values cannot be retrieved,
even by the owner. Changing a secret or its policy invalidates pending work
conservatively. Inspect the audit log and check the destination for unknown sends.

## Storage encryption keys

Storage encryption rotation is different from provider key rotation. Records
carry a key version. The Worker accepts `PREVIOUS_ENCRYPTION_KEY` as a secret and
`PREVIOUS_KEY_VERSION` as non-secret configuration for that exact prior version.
There is no fallback to a random key. AES-GCM also binds records to the
deployment ID and record identity.

The resumable re-encryption tool is not implemented. Do not change
`LOCKER_ENCRYPTION_KEY`, its version, or `DEPLOYMENT_ID` on a populated locker
as a routine update. Do not remove an old key while records still use it.
Losing a required key makes those records unreadable. Generating a replacement
does not recover them. Keep key backups outside the Cloudflare account.

## Upgrades

This checkout has migrations 0001–0004 and schema version 4. Local tests cover
empty-database migration and prior-schema preservation. A release must state
which source versions it supports and whether old code can use the new schema.
No production upgrade or rollback drill is recorded yet.

Before an upgrade, take and verify a consistent backup. Stop protected activity
and scheduled mutation through maintenance mode, and let executing attempts
settle. Unknown sends stay unknown. Apply migrations to the selected deployment,
then deploy compatible code only after migrations succeed:

```sh
npm run db:remote
# Only after migration succeeds, use the release's verified deploy procedure.
```

The current `npm run deploy` script is missing; use the explicit steps in the
[deployment guide](deploy.md) for disposable checks. Migration failures stop the
upgrade. Rerun the migration command after addressing the failure; it skips
applied migrations. Do not edit released migrations, delete migration tracking,
or run destructive down-migrations to force an older Worker to start. A code
rollback is valid only when it supports the resulting schema.

## Backup and restore boundary

Audit exports and seven-day file history are useful, but neither is a complete
backup. A full backup needs D1 metadata, referenced private R2 objects, deployment
settings, and separately saved encryption keys. Token hashes and sensitive
metadata are in D1 even when secret fields are encrypted.

The consistent backup/recovery tooling and a restore drill are still release
work. The following commands are building blocks, not a verified complete
runbook. They were checked against local Wrangler help; no cloud backup was
taken in this chunk. Use your own Cloudflare account authority with permission
to export the selected D1 database and read the selected private R2 bucket.
Agent and owner API tokens do not grant those Cloudflare permissions.

Create a private local destination outside the checkout. Export D1 using the
configured binding, and fetch known objects using authenticated tooling:

```sh
umask 077
mkdir -p /private/backup/agentlocker
npx wrangler d1 export DB --remote --output /private/backup/agentlocker/d1.sql
npx wrangler r2 object get '<bucket>/<object-key>' --remote \
  --file /private/backup/agentlocker/object.bin
```

Cloudflare documents [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
and [R2 object commands](https://developers.cloudflare.com/r2/reference/wrangler-commands/).
Use authenticated S3-compatible tools when copying a whole private bucket.
Never enable public access to make copying easier. Do not put cloud credentials
in command arguments. A D1 dump plus a later bucket listing is not a consistent
snapshot while writes, dispatch, or cleanup can run.

Before calling a backup usable, the remaining runbook must:

1. Set maintenance so protected requests and scheduled work stop, settle active
   attempts, reconcile abandoned sends, and record an audit boundary.
2. Export D1 and every object referenced by current files, retained revisions,
   staged actions, and retained results at that boundary. Verify lengths and
   content hashes against a manifest.
3. Record release/schema versions, deployment ID, key versions, snapshot time,
   audit high-water ID, object keys/hashes, and resource mapping. Store keys
   separately. Keep a verified archive outside the source account.
4. Restore into isolated resources with access and dispatch closed. Preserve
   the deployment ID, install required keys, and set the new canonical origin.
   Disable restored agents, revoke restored tokens, invalidate pending/ready
   actions, and reconcile abandoned sends to unknown without dispatching them.
5. Preserve historical events, append a recovery event, and verify file bytes,
   owner restore, secret decryption, audit continuity, and no send replay. Issue
   fresh agent tokens and enable agents individually after reviewing grants.

Maintenance controls, backup manifests, and recovery state changes need tested
operator tooling. Do not improvise them by resetting setup or editing action
states in a live database. Data after the backup boundary can be lost. Restoring
D1 cannot undo external effects. Keep the instance closed if verification fails.

## Activity and failures

Keep the owner app open for review; v1 has no push. It polls every five seconds
while active, slows to 15 seconds when idle, and pauses in hidden tabs. A stale
warning appears after 30 seconds without a successful refresh. Check the audit
record for agent, action, target, decision, result, timestamp, and request ID.
Export filtered history as JSONL or CSV when needed.

Pending does not mean approved. Approved does not mean succeeded. For an unknown
send, check the external service before doing anything else. Never automatically
resubmit it. Do not remove audit rows to free space; archive and storage management
need their own owner procedure. Native iOS push remains future work.
