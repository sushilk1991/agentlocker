export interface Env {
 DB: D1Database; FILES: R2Bucket;
 OWNER_TOKEN: string; LOCKER_ENCRYPTION_KEY: string; PREVIOUS_ENCRYPTION_KEY?: string;
 ENCRYPTION_KEY_VERSION: string; PREVIOUS_KEY_VERSION?: string; PUBLIC_ORIGIN: string; DEPLOYMENT_ID: string;
}
export type Row = Record<string, any>;
export interface Identity { kind: 'owner' | 'agent' | 'anonymous'; agentId?: string; tokenId?: string; name: string; expiresAt?: number }
export interface Context { env: Env; actor: Identity; requestId: string; ctx: ExecutionContext }
export const NOW = "CAST(unixepoch('subsec')*1000 AS INTEGER)";
export const TERMINAL = new Set(['succeeded','failed','denied','expired','invalidated','unknown']);
export const LIMITS = { file: 10*1024*1024, inline: 1024*1024, proxyBody: 64*1024, headers: 16*1024, response: 256*1024, secret: 16*1024 };
export class LockerError extends Error {
 constructor(public code: string, public status = 400, message = code.replaceAll('_',' ')) { super(message); }
}
export function assert(ok: unknown, code: string, status = 400, message?: string): asserts ok { if (!ok) throw new LockerError(code,status,message); }
export const opaqueId = () => crypto.randomUUID();
export const json = (data: unknown, status = 200) => Response.json(data, {status});
export function statement(c: Context, sql: string, ...args: any[]) { return c.env.DB.prepare(sql).bind(...args.map(x=>x===undefined?null:x)); }
export async function one(c: Context, sql: string, ...args: any[]): Promise<Row | null> { return statement(c,sql,...args).first<Row>(); }
export async function all(c: Context, sql: string, ...args: any[]): Promise<Row[]> { return (await statement(c,sql,...args).all<Row>()).results; }
export async function settings(c: Context) { const s=await one(c,'SELECT * FROM settings WHERE id=1'); assert(s,'not_configured',503); return s; }
