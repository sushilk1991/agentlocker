import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'vite';

// Build the same assets used in production. Wrangler serves them with the
// Worker's origin checks and CSP, so local UI behavior matches deployment.
const output = await build({build: {watch: {}}});
if (!('on' in output)) throw new Error('Expected the UI build watcher');
const watcher = output;
let worker: ChildProcess | undefined;
let stopping: Promise<void> | undefined;

function signalWorker(signal: NodeJS.Signals) {
 if (!worker?.pid) return;
 try {
  if (process.platform === 'win32') worker.kill(signal);
  else process.kill(-worker.pid, signal);
 } catch { /* The process group may already be stopped. */ }
}
function stop(code: number) {
 return stopping ??= (async () => {
  process.exitCode = code;
  signalWorker('SIGTERM');
  // Also catch descendants if the Wrangler wrapper exits before workerd.
  if (worker?.pid) {
   await new Promise<void>(resolve => setTimeout(resolve, 1000));
   signalWorker('SIGKILL');
  }
  await watcher.close();
 })();
}
process.once('SIGINT', () => {void stop(130);});
process.once('SIGTERM', () => {void stop(143);});
watcher.on('event', event => {
 if (event.code === 'BUNDLE_END') void event.result.close();
 if (event.code === 'ERROR' && !worker) void stop(1);
 if (event.code !== 'END' || worker || stopping) return;
 const wrangler = createRequire(import.meta.url).resolve('wrangler/bin/wrangler.js');
 worker = spawn(process.execPath, [wrangler, 'dev', ...process.argv.slice(2)], {
  stdio: 'inherit', detached: process.platform !== 'win32',
 });
 worker.once('error', () => {console.error('Could not start Wrangler.'); void stop(1);});
 worker.once('exit', code => {void stop(code ?? 1);});
});
