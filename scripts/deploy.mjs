import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runWrangler } from './wrangler.mjs';

const require = createRequire(import.meta.url);
const placeholder = '00000000-0000-0000-0000-000000000000';
const absentWorker = output => /\[code: (10007|10090)\]/.test(output) || /The Worker [\w-]+ has no deployments\./.test(output);
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

function parse(output) {
  try { return JSON.parse(output); }
  catch { throw new Error('Wrangler returned an unexpected response. No further steps were run.'); }
}

// Exported for a fake-Wrangler safety test. No test flag changes production behavior.
export async function deploy({ config, saved = {}, save, run, log = console.log }) {
  ensure(config.name && !config.env, 'Use one top-level Worker config. Named environments need their own deployment copy.');
  ensure(!saved.name || saved.name === config.name, 'The saved deployment belongs to another Worker. Use a separate checkout.');
  ensure(!saved.account_id || !config.account_id || saved.account_id === config.account_id, 'The saved account differs. Use a separate checkout.');
  ensure(!process.env.CLOUDFLARE_ACCOUNT_ID || !saved.account_id || process.env.CLOUDFLARE_ACCOUNT_ID === saved.account_id,
    'The selected account differs from the saved deployment. Use a separate checkout.');
  const db = config.d1_databases?.find(b => b.binding === 'DB');
  const files = config.r2_buckets?.find(b => b.binding === 'FILES');
  ensure(db && files && config.d1_databases.length === 1 && config.r2_buckets.length === 1,
    'Expected exactly the DB and FILES storage bindings.');
  ensure(!['OWNER_TOKEN', 'LOCKER_ENCRYPTION_KEY'].some(name => name in (config.vars ?? {})), 'Credentials must be Worker secrets.');
  config = structuredClone(config);
  config.account_id ||= saved.account_id || process.env.CLOUDFLARE_ACCOUNT_ID;
  config.vars ??= {};
  config.vars.DEPLOYMENT_ID ||= saved.vars?.DEPLOYMENT_ID || '';
  config.vars.PUBLIC_ORIGIN ||= saved.vars?.PUBLIC_ORIGIN || '';
  if (config.d1_databases[0].database_id === placeholder && saved.d1_databases?.[0]?.database_id) {
    config.d1_databases[0].database_id = saved.d1_databases[0].database_id;
  }
  config.workers_dev = true;
  config.preview_urls = false;
  // Save before every remote step, including resource creation. A retry uses the
  // same resource names even if the previous process lost the response.
  const persist = () => save(config);
  const command = async (args, allowAbsent = false) => {
    await persist();
    const result = await run(args);
    if (result.code === 0) return result.output;
    if (allowAbsent && absentWorker(result.output)) return null;
    const codes = [...result.output.matchAll(/\[code: (\d+)\]/g)].map(m => m[1]);
    throw new Error(`Step '${args.slice(0, 3).join(' ')}' failed${codes.length ? ' (Cloudflare code ' + codes.join(', ') + ')' : ''}. Check account permissions and selected resources. Rerun with the same configuration. No later step ran.`);
  };

  log('Checking live deployment settings.');
  const status = await command(['deployments', 'status', '--json'], true);
  const liveVersions = [];
  if (status !== null) {
    const deployment = parse(status);
    ensure(deployment.versions?.length > 0, 'Cannot read live versions. Deployment stopped.');
    for (const version of deployment.versions) {
      liveVersions.push(parse(await command(['versions', 'view', version.version_id, '--json'])));
    }
  }
  const bindings = liveVersions.map(v => {
    ensure(Array.isArray(v.resources?.bindings), 'Cannot read live bindings. Deployment stopped.');
    const id = v.resources.bindings.find(b => b.name === 'DEPLOYMENT_ID');
    ensure(!id || id.type === 'plain_text' && typeof id.text === 'string', 'Cannot read the existing DEPLOYMENT_ID. Deployment stopped.');
    return v.resources.bindings;
  });
  const liveValues = name => bindings.map(bs => bs.find(b => b.name === name && b.type === 'plain_text')?.text).filter(Boolean);
  const ids = liveValues('DEPLOYMENT_ID');
  const requested = [config.vars.DEPLOYMENT_ID, saved.vars?.DEPLOYMENT_ID].filter(Boolean);
  ensure(new Set([...ids, ...requested]).size <= 1, 'DEPLOYMENT_ID differs from the live or saved value. Keep the original ID; deployment stopped.');
  config.vars.DEPLOYMENT_ID = ids[0] || requested[0] || randomBytes(32).toString('hex');
  ensure(config.vars.DEPLOYMENT_ID.length >= 16, 'DEPLOYMENT_ID is invalid. Keep the original value and investigate.');
  const origins = liveValues('PUBLIC_ORIGIN');
  ensure(new Set(origins).size <= 1, 'Live versions disagree on PUBLIC_ORIGIN. Resolve the rollout before deploying.');
  const keyVersions = [...liveValues('ENCRYPTION_KEY_VERSION'), saved.vars?.ENCRYPTION_KEY_VERSION, config.vars.ENCRYPTION_KEY_VERSION].filter(Boolean);
  ensure(new Set(keyVersions).size <= 1, 'Encryption key versions differ. Keep the live version in config; key rotation is a separate operation.');
  config.vars.PUBLIC_ORIGIN ||= origins[0] || saved.vars?.PUBLIC_ORIGIN || '';
  if (config.vars.PUBLIC_ORIGIN) {
    const url = new URL(config.vars.PUBLIC_ORIGIN);
    ensure(url.origin === config.vars.PUBLIC_ORIGIN && url.protocol === 'https:', 'PUBLIC_ORIGIN must be an exact HTTPS origin.');
  }

  // A button deployment supplies bindings. A terminal deployment resolves the
  // selected names, creates missing resources once, and records their IDs.
  const selectedDb = config.d1_databases[0], selectedFiles = config.r2_buckets[0];
  const liveDbs = bindings.flatMap(bs => bs.filter(b => b.name === 'DB' && b.type === 'd1').map(b => b.id));
  const liveBuckets = bindings.flatMap(bs => bs.filter(b => b.name === 'FILES' && b.type === 'r2_bucket').map(b => b.bucket_name));
  ensure(new Set(liveDbs).size <= 1 && new Set(liveBuckets).size <= 1, 'Live storage bindings disagree. Resolve the rollout before deploying.');
  const selectedIds = [selectedDb.database_id === placeholder ? null : selectedDb.database_id, saved.d1_databases?.[0]?.database_id, ...liveDbs].filter(Boolean);
  ensure(new Set(selectedIds).size <= 1, 'DB differs from the saved or live binding. Refusing to switch storage.');
  selectedDb.database_id = selectedIds[0] || placeholder;
  if (selectedDb.database_id === placeholder) {
    let databases = parse(await command(['d1', 'list', '--json']));
    if (!databases.some(d => d.name === selectedDb.database_name)) {
      log('Creating the selected D1 database.');
      await command(['d1', 'create', selectedDb.database_name, '--no-update-config']);
      databases = parse(await command(['d1', 'list', '--json']));
    }
    const found = databases.filter(d => d.name === selectedDb.database_name);
    ensure(found.length === 1 && found[0].uuid, 'Cannot resolve DB by name. Check D1 and rerun; do not delete data.');
    selectedDb.database_id = found[0].uuid;
  }
  const previousBucket = liveBuckets[0] || saved.r2_buckets?.[0]?.bucket_name;
  ensure(!previousBucket || previousBucket === selectedFiles.bucket_name, 'FILES differs from the saved or live binding. Refusing to switch storage.');
  const buckets = await command(['r2', 'bucket', 'list']);
  const names = [...buckets.matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map(m => m[1]);
  if (!names.includes(selectedFiles.bucket_name)) {
    log('Creating the selected private R2 bucket.');
    await command(['r2', 'bucket', 'create', selectedFiles.bucket_name, '--no-update-config']);
  }
  const publicUrl = await command(['r2', 'bucket', 'dev-url', 'get', selectedFiles.bucket_name]);
  const domains = await command(['r2', 'bucket', 'domain', 'list', selectedFiles.bucket_name]);
  ensure(publicUrl.includes('Public access via the r2.dev URL is disabled.') && domains.includes('There are no custom domains connected to this bucket.'),
    'FILES must be private. Disable its public r2.dev URL and remove public custom domains, then rerun.');

  const secrets = await command(['secret', 'list', '--format', 'json'], true);
  ensure(secrets !== null && ['OWNER_TOKEN', 'LOCKER_ENCRYPTION_KEY'].every(name => parse(secrets).some(s => s.name === name)),
    'Required secrets are missing. Enter OWNER_TOKEN and LOCKER_ENCRYPTION_KEY through the button inputs or wrangler secret put prompts. Never replace existing keys. Then rerun.');
  log('Applying remote D1 migrations.');
  await command(['d1', 'migrations', 'apply', 'DB', '--remote']);
  log('Deploying the Worker.');
  const output = await command(['deploy', '--keep-vars']);
  const urls = [...output.matchAll(/^\s*(https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)\/?\s*$/gm)].map(m => m[1]);
  ensure(new Set(urls).size === 1, 'Could not determine the assigned workers.dev URL. Keep the saved ID. Inspect the Worker URL in Cloudflare, set PUBLIC_ORIGIN explicitly, and rerun.');
  if (!config.vars.PUBLIC_ORIGIN) {
    config.vars.PUBLIC_ORIGIN = urls[0];
    log('Setting the assigned canonical origin and redeploying.');
    await command(['deploy', '--keep-vars']);
  }
  await persist();
  log(`Deployed. Open ${config.vars.PUBLIC_ORIGIN} and sign in to confirm setup.`);
}

async function main() {
  ensure(!process.env.CLOUDFLARE_ENV, 'Use a separate deployment copy instead of CLOUDFLARE_ENV.');
  const { experimental_readRawConfig } = require('wrangler');
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const dir = resolve('.agentlocker'), filename = resolve(dir, 'wrangler.json');
  let saved = {};
  try { saved = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read .agentlocker/wrangler.json. Keep this record and investigate.'); }
  rawConfig.main = resolve(rawConfig.main);
  for (const db of rawConfig.d1_databases ?? []) db.migrations_dir = resolve(db.migrations_dir || 'migrations');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await deploy({ config: rawConfig, saved,
    save: async config => {
      await writeFile(filename + '.tmp', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
      await rename(filename + '.tmp', filename);
    },
    run: args => runWrangler([...args, '--config', filename]),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Only our own sanitized errors are safe to print. Do not print API bodies,
    // Wrangler diagnostics, local config, or arbitrary exception messages.
    console.error('Deployment stopped. ' + (error instanceof Error && !error.stack?.includes('node_modules')
      ? error.message : 'Check the deployment configuration and account. See docs/deploy.md.'));
    process.exitCode = 1;
  });
}
