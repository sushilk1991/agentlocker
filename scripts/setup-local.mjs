import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { checkedWrangler } from './wrangler.mjs';

try {
  const origin = process.env.AGENTLOCKER_LOCAL_ORIGIN ?? 'http://localhost:8787';
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('AGENTLOCKER_LOCAL_ORIGIN must be an exact HTTP localhost or 127.0.0.1 origin.');
  }
  const values = {
    OWNER_TOKEN: randomBytes(32).toString('hex'),
    LOCKER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PUBLIC_ORIGIN: origin,
    DEPLOYMENT_ID: randomBytes(16).toString('hex'),
    ENCRYPTION_KEY_VERSION: '1',
  };
  await writeFile('.dev.vars', Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(''),
    { flag: 'wx', mode: 0o600 });
  console.log('Created private .dev.vars. Read the owner token in your local editor.');
  await checkedWrangler(['d1', 'migrations', 'apply', 'DB', '--local']);
  console.log(`Local migrations applied. Run npm run dev and open ${origin}.`);
} catch (error) {
  console.error(error?.code === 'EEXIST'
    ? 'Local setup stopped: .dev.vars already exists. Keep it. Run npm run db:local to resume migrations.'
    : 'Local setup stopped. ' + (error instanceof Error ? error.message : 'Check local configuration.'));
  process.exitCode = 1;
}
