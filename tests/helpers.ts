import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, type Request as RuntimeRequest, type Response as RuntimeResponse } from 'miniflare';
import { build } from 'esbuild';
import { unstable_splitSqlQuery } from 'wrangler';
import type { Context, Env, Identity } from '../src/types';

export async function applyMigration(db: D1Database, name: string) {
 const sql = await readFile(`migrations/${name}`, 'utf8');
 await db.batch(unstable_splitSqlQuery(sql).map(query => db.prepare(query)));
}

export async function database(migrate = true, worker = false, outbound?: (request: RuntimeRequest) => Promise<RuntimeResponse>, origin = 'https://locker.example.com') {
 const bindings = {OWNER_TOKEN: 'owner-canary-' + 'a'.repeat(64), LOCKER_ENCRYPTION_KEY: btoa('k'.repeat(32)),
  ENCRYPTION_KEY_VERSION: '1', PUBLIC_ORIGIN: origin, DEPLOYMENT_ID: 'test-deployment-id'};
 const script = worker ? (await build({entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', plugins:[{name:'owner-assets',setup(build){build.onLoad({filter:/[\\/]public[\\/].*\.(html|css|js)$/},async args=>({contents:await readFile(args.path,'utf8'),loader:'text'}));}}]})).outputFiles[0].text
  : 'export default { fetch() { return new Response("test"); } };';
 const runtime = new Miniflare({
  modules: true,
  ...(origin.startsWith('http:')?{host:'127.0.0.1',port:Number(new URL(origin).port)}:{}),
  script, bindings,
  ...(worker ? {assets: {directory: "dist-web", binding: "ASSETS", routerConfig: {has_user_worker: true, invoke_user_worker_ahead_of_assets: true}}} : {}),
  compatibilityDate: '2025-10-14',
  d1Databases: ['DB'],
  r2Buckets: ['FILES'],
  ...(outbound ? {outboundService: outbound} : {}),
 });
 const db = await runtime.getD1Database('DB') as unknown as D1Database;
 if (migrate) {
  // Use the actual SQL files, including their constraints, indexes, and triggers.
  for (const name of (await readdir('migrations')).filter(x => x.endsWith('.sql')).sort()) {
   await applyMigration(db, name);
  }
 }
 const env = {
  DB: db, FILES: await runtime.getR2Bucket('FILES') as unknown as R2Bucket, OWNER_TOKEN: 'owner-canary-' + 'a'.repeat(64),
  LOCKER_ENCRYPTION_KEY: btoa('k'.repeat(32)), ENCRYPTION_KEY_VERSION: '1',
  PUBLIC_ORIGIN: origin, DEPLOYMENT_ID: 'test-deployment-id',
 } satisfies Env;
 const context = (actor: Identity = {kind: 'owner', name: 'Owner'}): Context => ({
  env, actor, requestId: crypto.randomUUID(), ctx: {} as ExecutionContext,
 });
 if (migrate) await db.prepare(`INSERT INTO settings(id,deployment_id,public_origin,setup_complete,created_at,updated_at)
  VALUES(1,?,?,1,0,0)`).bind(env.DEPLOYMENT_ID, env.PUBLIC_ORIGIN).run();
 return {runtime, db, env, context};
}

export function bearer(token: string, url = 'https://locker.example.com/api/v1/files', origin?: string) {
 return new Request(url, {headers: {authorization: `Bearer ${token}`, ...(origin ? {origin} : {})}});
}
