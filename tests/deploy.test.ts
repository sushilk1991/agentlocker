import { describe, expect, it } from 'vitest';
// The owner requested executable .mjs tooling; exercise its orchestration directly.
import { deploy } from '../scripts/deploy.mjs';

const ID = 'original-immutable-deployment-id';
const ORIGIN = 'https://agentlocker.example.workers.dev';
function fixture({ live = true, migrationFails = false, statusFails = false, split = false, secondDeployFails = false } = {}) {
 const config = { name: 'agentlocker', main: 'src/index.ts', vars: { PUBLIC_ORIGIN: '', DEPLOYMENT_ID: '', ENCRYPTION_KEY_VERSION: '1' },
  d1_databases: [{ binding: 'DB', database_name: 'agentlocker', database_id: 'db-id', migrations_dir: 'migrations' }],
  r2_buckets: [{ binding: 'FILES', bucket_name: 'agentlocker-files' }] };
 const calls: string[][] = [], snapshots: any[] = [], logs: string[] = [];
 let uploads = 0;
 const run = async (args: string[]) => {
  calls.push(args);
  const cmd = args.slice(0, 2).join(' ');
  if (cmd === 'deployments status') {
   if (statusFails) return { code: 1, output: 'authentication failed [code: 10000] sensitive-value' };
   return live ? { code: 0, output: JSON.stringify({ versions: [{ version_id: 'v1' }, ...(split ? [{ version_id: 'v2' }] : [])] }) }
    : { code: 1, output: 'Worker does not exist [code: 10007]' };
  }
  if (cmd === 'versions view') return { code: 0, output: JSON.stringify({ resources: { bindings: [
   { type: 'plain_text', name: 'DEPLOYMENT_ID', text: args[2] === 'v2' ? 'different-deployment-id' : ID },
   { type: 'plain_text', name: 'PUBLIC_ORIGIN', text: ORIGIN },
   { type: 'd1', name: 'DB', id: 'db-id' }, { type: 'r2_bucket', name: 'FILES', bucket_name: 'agentlocker-files' },
  ] } }) };
  if (cmd === 'r2 bucket') return { code: 0, output: args[2] === 'dev-url' ? 'Public access via the r2.dev URL is disabled.'
   : args[2] === 'domain' ? 'There are no custom domains connected to this bucket.' : 'name:          agentlocker-files\ncreation_date: example\n' };
  if (cmd === 'secret list') return { code: 0, output: JSON.stringify([{ name: 'OWNER_TOKEN' }, { name: 'LOCKER_ENCRYPTION_KEY' }]) };
  if (cmd === 'd1 migrations') return { code: migrationFails ? 1 : 0, output: migrationFails ? 'private diagnostic sensitive-value' : '' };
  if (args[0] === 'deploy') { uploads++; return { code: secondDeployFails && uploads === 2 ? 1 : 0, output: ORIGIN + '\n' }; }
  throw new Error('Unexpected command');
 };
 return { config, calls, snapshots, logs, run, save: async (c: any) => { snapshots.push(structuredClone(c)); }, log: (s: string) => logs.push(s) };
}

describe('deployment safety', () => {
 it('migrates before uploading and preserves the live ID and origin on a fresh checkout', async () => {
  const f = fixture(); await deploy(f);
  expect(f.calls.findIndex(c => c[0] === 'd1')).toBeLessThan(f.calls.findIndex(c => c[0] === 'deploy'));
  expect(f.calls.filter(c => c[0] === 'deploy')).toHaveLength(1);
  expect(f.snapshots.at(-1).vars).toMatchObject({ DEPLOYMENT_ID: ID, PUBLIC_ORIGIN: ORIGIN });
 });
 it('stops at migration failure, without printing captured output', async () => {
  const f = fixture({ migrationFails: true });
  await expect(deploy(f)).rejects.toThrow('No later step ran');
  expect(f.calls.some(c => c[0] === 'deploy')).toBe(false);
  expect(f.logs.join(' ')).not.toContain('sensitive-value');
 });
 it('fails closed on auth errors instead of mistaking them for a new Worker', async () => {
  const f = fixture({ statusFails: true }); await expect(deploy(f)).rejects.toThrow('10000');
  expect(f.calls).toHaveLength(1);
 });
 it('rejects an ID conflict and inconsistent live rollout', async () => {
  const f = fixture(); f.config.vars.DEPLOYMENT_ID = 'requested-replacement';
  await expect(deploy(f)).rejects.toThrow('DEPLOYMENT_ID differs');
  await expect(deploy(fixture({ split: true }))).rejects.toThrow('DEPLOYMENT_ID differs');
  expect(f.calls.some(c => c[0] === 'deploy')).toBe(false);
 });
 it('saves a fresh ID before upload, leaves the first upload closed, and sets the assigned URL', async () => {
  const f = fixture({ live: false }); await deploy(f);
  const id = f.snapshots.at(-1).vars.DEPLOYMENT_ID;
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  expect(f.calls.filter(c => c[0] === 'deploy')).toHaveLength(2);
  expect(f.snapshots.filter(c => c.vars.DEPLOYMENT_ID).every(c => c.vars.DEPLOYMENT_ID === id)).toBe(true);
  expect(f.snapshots.at(-1).vars.PUBLIC_ORIGIN).toBe(ORIGIN);
  expect(f.calls.flat().join(' ')).not.toContain(id); // Values travel through config, never arguments.
 });
 it('resumes after a failed origin upload with the same saved ID', async () => {
  const f = fixture({ live: false, secondDeployFails: true }); await expect(deploy(f)).rejects.toThrow();
  const saved = f.snapshots.at(-1), retry = fixture({ live: false });
  await deploy({ ...retry, saved });
  expect(retry.snapshots[0].vars.DEPLOYMENT_ID).toBe(saved.vars.DEPLOYMENT_ID);
  expect(retry.snapshots.at(-1).vars).toEqual(saved.vars);
 });
 it('refuses to switch existing storage', async () => {
  const f = fixture(); f.config.d1_databases[0].database_id = 'other-db';
  await expect(deploy(f)).rejects.toThrow('Refusing to switch storage');
  expect(f.calls.some(c => c[0] === 'd1')).toBe(false);
 });
 it('resolves a template database by name and records it before migrations', async () => {
  const f = fixture({ live: false }); f.config.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000';
  const original = f.run;
  f.run = async args => args.slice(0, 2).join(' ') === 'd1 list'
   ? { code: 0, output: JSON.stringify([{ name: 'agentlocker', uuid: 'selected-db-id' }]) } : original(args);
  await deploy(f);
  expect(f.snapshots.at(-1).d1_databases[0].database_id).toBe('selected-db-id');
  expect(f.calls.some(c => c[1] === 'create')).toBe(false);
 });
 it('creates missing storage once and reuses its recorded database on retry', async () => {
  const f = fixture({ live: false }); f.config.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000';
  const original = f.run; let created = false;
  f.run = async args => {
   if (args[0] === 'd1' && args[1] === 'list') return { code: 0, output: JSON.stringify(created ? [{ name: 'agentlocker', uuid: 'new-db' }] : []) };
   if (args[0] === 'd1' && args[1] === 'create') { created = true; f.calls.push(args); return { code: 0, output: '' }; }
   if (args.slice(0, 3).join(' ') === 'r2 bucket list') return { code: 0, output: '' };
   return original(args);
  };
  await deploy(f);
  expect(f.calls.filter(c => c[1] === 'create')).toHaveLength(1);
  expect(f.calls.filter(c => c.slice(0, 3).join(' ') === 'r2 bucket create')).toHaveLength(1);
  const retry = fixture({ live: false }); retry.config.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000';
  await deploy({ ...retry, saved: f.snapshots.at(-1) });
  expect(retry.calls.some(c => c[1] === 'create')).toBe(false);
  expect(retry.snapshots.at(-1).d1_databases[0].database_id).toBe('new-db');
 });
 it('does not migrate or deploy with missing secrets or public storage', async () => {
  for (const scenario of ['missing-secrets', 'public-storage']) {
   const f = fixture(), original = f.run;
   f.run = async args => args[0] === 'secret' && scenario === 'missing-secrets' ? { code: 0, output: '[]' }
    : args[2] === 'dev-url' && scenario === 'public-storage' ? { code: 0, output: 'Public access is enabled.' } : original(args);
   await expect(deploy(f)).rejects.toThrow(scenario === 'missing-secrets' ? 'Required secrets' : 'FILES must be private');
   expect(f.calls.some(c => c[0] === 'deploy' || c[1] === 'migrations')).toBe(false);
  }
 });
 it('stops on a provisioning failure before migrations or upload', async () => {
  const f = fixture(), original = f.run;
  f.run = async args => args.slice(0, 3).join(' ') === 'r2 bucket list' ? { code: 1, output: 'billing failure' } : original(args);
  await expect(deploy(f)).rejects.toThrow('No later step ran');
  expect(f.calls.some(c => c[0] === 'deploy' || c[1] === 'migrations')).toBe(false);
 });
});
