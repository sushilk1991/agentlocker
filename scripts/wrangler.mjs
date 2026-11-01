import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const executable = require.resolve('wrangler/bin/wrangler.js');

// Keep captured Wrangler output private. Even errors can contain binding values.
// Wrangler handles API tokens, OAuth refresh, and account selection itself.
export function runWrangler(args, { cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'log',
        WRANGLER_LOG_SANITIZE: 'true', NO_COLOR: '1' },
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
    child.once('error', () => reject(new Error('Could not start the pinned Wrangler. Run npm ci.')));
    child.once('close', code => resolve({ code, output }));
  });
}

export async function checkedWrangler(args, options) {
  const result = await runWrangler(args, options);
  if (result.code !== 0) throw new Error('Wrangler failed. Check the selected account and configuration, then rerun.');
  return result.output;
}
