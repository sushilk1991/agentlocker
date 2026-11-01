import { parseArgs } from 'node:util';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { AgentLocker, AgentLockerError, Download, HttpClient, isAction, newIdempotencyKey, type Action, type ProxyRequest } from '@agentlocker/sdk';
import { HELP } from './help.js';
import { safeJson, saveDownload, saveStream } from './io.js';
import { loadReview, verifyReview, type ReviewFile } from './review.js';

export interface CliContext {
 env?: Record<string, string | undefined>; fetch?: typeof globalThis.fetch; signal?: AbortSignal;
 stdout?: (text: string) => void; stderr?: (text: string) => void;
}
const common = ['json','config','locker-url','help'];
const waitFlags = ['wait','no-wait','timeout'];
const mutationFlags = ['idempotency-key'];
const pageFlags = ['cursor','limit'];
const booleans = new Set(['json','help','force','wait','no-wait']);
const allFlags = [...new Set([...common, ...waitFlags, ...mutationFlags, ...pageFlags,
 'url','label','output','force','revision','type','secret','method','header','body-file','name','description','status',
 'expires-in','file','state','offset','review','digest','reason','filter','format'])];
function invalid(message: string): never { throw new AgentLockerError('invalid_arguments', 0, message); }
function number(value: unknown, fallback?: number) {
 if (value === undefined && fallback !== undefined) return fallback;
 const n = Number(value);
 if (typeof value !== 'string' || !value.trim() || !Number.isFinite(n) || n < 0) invalid('Provide a nonnegative number.');
 return n;
}
export function exitCode(value: unknown): number {
 if (!isAction(value)) {
  const status = value && typeof value === 'object' && 'upstream_status' in value ? Number(value.upstream_status) : undefined;
  return status !== undefined && status >= 400 ? 1 : 0;
 }
 if (['pending','ready','executing'].includes(value.status)) return 3;
 if (['denied','expired','invalidated','unknown'].includes(value.status)) return 2;
 if (value.status === 'failed') return 1;
 return (value.result?.upstream_status ?? value.attempt?.upstream_status ?? 0) >= 400 ? 1 : 0;
}

export async function runCli(argv: string[], context: CliContext = {}): Promise<number> {
 const env = context.env ?? process.env, out = context.stdout ?? (s => process.stdout.write(s)), err = context.stderr ?? (s => process.stderr.write(s));
 let machine = argv.includes('--json'), key: string | undefined;
 const redact = (s: string) => {
  for (const token of [env.AGENTLOCKER_TOKEN, env.AGENTLOCKER_OWNER_TOKEN]) if (token) s = s.replaceAll(token, '[redacted]');
  return s;
 };
 try {
  const parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: Object.fromEntries(allFlags.map(name => [name,
   { type: booleans.has(name) ? 'boolean' : 'string', ...(name === 'header' ? {multiple: true} : {}) }])) as Record<string, {type:'boolean'|'string';multiple?:boolean}> });
  const flags = parsed.values, words = parsed.positionals;
  if (flags.wait && flags['no-wait']) invalid('Choose --wait or --no-wait.');
  if (flags.timeout !== undefined) number(flags.timeout);
  if (flags['expires-in'] !== undefined) number(flags['expires-in']);
  machine = !!flags.json;
  if (flags.help || !words.length) { out(HELP); return 0; }
  const admin = words[0] === 'admin', verb = words.slice(0, admin ? 3 : ['files','secrets','actions'].includes(words[0]) ? 2 : 1).join(' ');
  const args = words.slice(verb.split(' ').length);
  const allowed = (...names: string[]) => {
   for (const name of Object.keys(flags)) if (![...common, ...names].includes(name)) invalid('Unsupported option --' + name + ' for ' + verb + '.');
  };
  const arity = (n: number) => { if (args.length !== n) invalid('Wrong number of arguments for ' + verb + '. Run --help.'); };
  const required = (name: string) => { const value = flags[name]; if (typeof value !== 'string' || !value) invalid('Provide --' + name + '.'); return value; };
  const configPath = typeof flags.config === 'string' ? flags.config : env.AGENTLOCKER_CONFIG ?? join(env.HOME ?? homedir(), '.config', 'agentlocker', 'config.json');
  let config: {url?: string; label?: string} = {};
  try { const data = JSON.parse(await readFile(configPath, 'utf8')); config = {url: data.url, label: data.label}; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalid('Could not read the configuration file.'); }
  const url = (typeof flags['locker-url'] === 'string' ? flags['locker-url'] : verb === 'send' ? undefined : typeof flags.url === 'string' ? flags.url : undefined) ?? env.AGENTLOCKER_URL ?? config.url;
  if (!url) invalid('Set AGENTLOCKER_URL or pass --locker-url <origin>.');
  const token = admin ? env.AGENTLOCKER_OWNER_TOKEN : env.AGENTLOCKER_TOKEN;
  if (!token) invalid(admin ? 'Set AGENTLOCKER_OWNER_TOKEN for admin commands.' : 'Set AGENTLOCKER_TOKEN. Tokens are never saved to config.');
  const options = { base_url: url, token, fetch: context.fetch, signal: context.signal };
  const sdk = new AgentLocker(options), http = new HttpClient(options);
  const call = { signal: context.signal };
  const mutation = () => { key = typeof flags['idempotency-key'] === 'string' ? flags['idempotency-key'] : newIdempotencyKey(); return {...call, idempotency_key: key}; };
  const read = () => mutation(); // Rule-gated reads also need a stable logical key.
  const page = () => ({...(flags.cursor ? {cursor: required('cursor')} : {}), ...(flags.limit ? {limit: number(flags.limit)} : {})});
  const ownerPath = (path: string) => '/api/v1/owner/' + path;
  const ownerJson = (path: string, method = 'GET', body?: unknown) => http.json<any>(ownerPath(path), {
   method, ...(body === undefined ? {} : {headers: {'content-type':'application/json'}, body: JSON.stringify(body)}),
  }, method === 'GET' ? call : mutation());
  const wait = async <T>(value: T): Promise<T | Action> => {
   if (flags.wait && flags['no-wait']) invalid('Choose --wait or --no-wait.');
   return flags.wait && isAction(value) && ['pending','ready','executing'].includes(value.status)
    ? await sdk.actions.wait(value.id, {...call, timeout_ms: number(flags.timeout, 60) * 1000}) : value;
  };
  const outputFile = async (download: Download) => saveDownload(required('output'), download, !!flags.force);
  let value: any;
  switch (verb) {
   case 'configure': {
    allowed('url','label'); arity(0);
    const identity = await sdk.identity(call);
    await mkdir(dirname(configPath), {recursive: true});
    // The temporary file never contains credentials. Config may include only these fields.
    await writeFile(configPath, safeJson({url: http.base_url, ...(flags.label ? {label: required('label')} : {})}, true) + '\n', {mode:0o600});
    value = {configured:true, config:configPath, url:http.base_url, identity, credential:'Set AGENTLOCKER_TOKEN in your environment. It was not saved.'}; break;
   }
   case 'whoami': allowed('url'); arity(0); value = await sdk.identity(call); break;
   case 'files list': allowed('url', ...pageFlags, ...mutationFlags, ...waitFlags); arity(1); value = await wait(await sdk.files.list(args[0], page(), read())); break;
   case 'files get': {
    allowed('url','output','force', ...mutationFlags, ...waitFlags); arity(1); required('output');
    value = await wait(await sdk.files.read(args[0], read()));
    if (value instanceof Download) value = await outputFile(value);
    else if (isAction(value) && value.status === 'succeeded') value = {...value, ...await outputFile(await sdk.actions.result(value.id, call))};
    break;
   }
   case 'files put': {
    allowed('url','revision','type', ...mutationFlags, ...waitFlags); arity(2);
    const info = await stat(args[0]);
    if (!info.isFile() || info.size > 10*1024*1024) invalid('Upload a regular file of at most 10 MiB.');
    const source = createReadStream(args[0]);
    try {
     value = await wait(await sdk.files.write(args[1], Readable.toWeb(source) as ReadableStream<Uint8Array>, {
      ...mutation(), media_type: typeof flags.type === 'string' ? flags.type : 'application/octet-stream',
      ...(flags.revision ? {expected_revision: required('revision')} : {create_only: true}),
     }));
    } finally { source.destroy(); }
    break;
   }
   case 'files delete': allowed('url','revision', ...mutationFlags, ...waitFlags); arity(1); value = await wait(await sdk.files.delete(args[0], required('revision'), mutation())); break;
   case 'secrets list': allowed('url', ...pageFlags, ...mutationFlags, ...waitFlags); arity(0); value = await wait(await sdk.secrets.list(page(), read())); break;
   case 'send': {
    allowed('url','secret','method','header','body-file', ...mutationFlags, ...waitFlags); arity(0);
    const headers: Record<string,string> = {};
    for (const header of (flags.header ?? []) as string[]) {
     const split = header.indexOf(':'); if (split < 1) invalid('Use --header "name: value".');
     const name = header.slice(0, split).toLowerCase(), content = header.slice(split+1).replace(/^ /, '');
     if (name in headers) invalid('Header names must be unique.');
     if (['authorization','cookie','proxy-authorization','x-api-key','api-key'].includes(name)) invalid('Provider keys belong in the locker. Select --secret instead.');
     headers[name] = content;
    }
    let body_base64: string | undefined;
    if (flags['body-file']) {
     const file = required('body-file'), info = await stat(file);
     if (!info.isFile() || info.size > 64*1024) invalid('Proxy body files can contain at most 64 KiB.');
     body_base64 = (await readFile(file)).toString('base64');
    }
    value = await wait(await sdk.proxy.request({secret:required('secret'), url:required('url'), method:required('method').toUpperCase() as ProxyRequest['method'], headers, ...(body_base64 === undefined ? {} : {body_base64})}, mutation())); break;
   }
   case 'actions list': allowed('url', ...pageFlags); arity(0); value = await sdk.actions.list(page(), call); break;
   case 'actions get': allowed('url'); arity(1); value = await sdk.actions.get(args[0], call); break;
   case 'actions wait': allowed('url','timeout'); arity(1); value = await sdk.actions.wait(args[0], {...call, timeout_ms:number(flags.timeout,60)*1000}); break;
   case 'actions result': {
    allowed('url','output','force'); arity(1);
    const result = await sdk.actions.result(args[0], call);
    if (flags.output) {
     // Preserve upstream error exit codes even when saving the complete JSON envelope.
     if (result.content_type.split(';')[0] === 'application/json') {
      const bytes = await result.bytes();
      const data = JSON.parse(new TextDecoder().decode(bytes));
      await saveStream(required('output'), new Blob([bytes]).stream(), !!flags.force);
      value = {output: required('output'), action_id:args[0], ...(typeof data.upstream_status === 'number' ? {upstream_status:data.upstream_status} : {})};
     } else value = await outputFile(result);
    } else {
     if (result.content_type.split(';')[0] !== 'application/json') { await result.body?.cancel(); invalid('Binary results require --output <file>.'); }
     value = await result.json();
    }
    break;
   }
   case 'admin agents list': allowed('url'); arity(0); value = await ownerJson('agents'); break;
   case 'admin agents create': allowed('url','name','description', ...mutationFlags); arity(0); value = await ownerJson('agents','POST',{name:required('name'),description:flags.description ?? ''}); break;
   case 'admin agents update': {
    allowed('url','name','description','status', ...mutationFlags); arity(1);
    const body = Object.fromEntries(['name','description','status'].filter(k => flags[k] !== undefined).map(k => [k,flags[k]]));
    if (!Object.keys(body).length) invalid('Provide --name, --description, or --status.');
    value = await ownerJson('agents/'+encodeURIComponent(args[0]),'PATCH',body); break;
   }
   case 'admin agents revoke': allowed('url', ...mutationFlags); arity(1); value = await ownerJson('agents/'+encodeURIComponent(args[0]),'PATCH',{status:'revoked'}); break;
   case 'admin tokens create':
    allowed('url','label','expires-in', ...mutationFlags); arity(1);
    value = {sensitive:true, warning:'One-time token. Store it securely. It cannot be retrieved again.', ...await ownerJson('agents/'+encodeURIComponent(args[0])+'/tokens','POST',{label:required('label'),lifetime_ms:number(flags['expires-in'])*1000})}; break;
   case 'admin tokens revoke': allowed('url', ...mutationFlags); arity(2); value = await ownerJson('agents/'+encodeURIComponent(args[0])+'/tokens/'+encodeURIComponent(args[1]),'DELETE'); break;
   case 'admin grants get': allowed('url'); arity(1); value = await ownerJson('agents/'+encodeURIComponent(args[0])+'/grants'); break;
   case 'admin grants set': allowed('url','file', ...mutationFlags); arity(1); value = await ownerJson('agents/'+encodeURIComponent(args[0])+'/grants','PUT',JSON.parse(await readFile(required('file'),'utf8'))); break;
   case 'admin approvals list': {
    allowed('url','state','limit','offset'); arity(0);
    const params = new URLSearchParams({state:typeof flags.state==='string'?flags.state:'pending',limit:String(number(flags.limit,50)),offset:String(number(flags.offset,0))});
    value = await ownerJson('approvals?'+params); break;
   }
   case 'admin approvals show': {
    allowed('url','output','force'); arity(1); required('output');
    const review = await loadReview(http,args[0],context.signal);
    await saveStream(required('output'),new Blob([safeJson(review,true)+'\n']).stream(),!!flags.force);
    value = {output:required('output'),digest:review.review.digest,id:review.review.id,approval_id:args[0],status:review.review.status,
     review:'Read the complete saved file and its base64 bytes before deciding. No payload was truncated.'}; break;
   }
   case 'admin approvals approve': case 'admin approvals deny': {
    allowed('url','review','digest','reason', ...mutationFlags); arity(1);
    const file = JSON.parse(await readFile(required('review'),'utf8')) as ReviewFile;
    const review = verifyReview(file,http.base_url,args[0]);
    if (review.digest !== required('digest')) invalid('Pass the exact digest from the complete review you read.');
    const current = await loadReview(http,args[0],context.signal);
    if (current.review.digest !== review.digest || current.content_base64 !== file.content_base64) invalid('The review changed. Load and read it again.');
    value = await ownerJson('approvals/'+encodeURIComponent(args[0])+'/decision','POST',{digest:review.digest,decision:verb.endsWith(' approve')?'approve':'deny',reason:flags.reason ?? ''}); break;
   }
   case 'admin audit list': case 'admin audit export': {
    const exporting = verb.endsWith(' export'); allowed('url','filter',...(exporting?['output','force','format']:[])); arity(0);
    const params = new URLSearchParams(typeof flags.filter==='string'?flags.filter:'');
    if (exporting) params.set('format',typeof flags.format==='string'?flags.format:'jsonl');
    if (exporting) { required('output'); const result = new Download(await http.request(ownerPath('audit/export?'+params),undefined,call)); value = await outputFile(result); }
    else value = await ownerJson('audit?'+params);
    break;
   }
   default: invalid('Unknown command. Run agentlocker --help.');
  }
  if (key && typeof value === 'object') value = {...value,idempotency_key:key};
  // Values from the service are rendered as JSON text; terminal control bytes are escaped.
  if (!machine && isAction(value)) {
   out(safeJson({state:value.status,action_id:value.id,approval_id:value.approval_id,expires_at:value.expires_at,request_id:value.request_id,
    ...(key?{idempotency_key:key}:{}),...(value.status==='unknown'?{warning:'Check the provider before submitting another send.'}:{})},true)+'\n');
  } else out(safeJson(value,!machine)+'\n');
  return exitCode(value);
 } catch (error) {
  const known = error instanceof AgentLockerError;
  const code = known ? error.code : (error as NodeJS.ErrnoException)?.code === 'EEXIST' ? 'output_exists' : 'client_error';
  const message = known ? error.message : code === 'output_exists' ? 'Output exists. Choose another path or pass --force.' : 'The command failed. Check arguments, local files, and the connection.';
  const value = {error:{code,message:redact(message)},...(known && error.request_id?{request_id:error.request_id}:{}),
   ...(known && error.action_id?{action_id:error.action_id}:{}),...(key?{idempotency_key:key}:{})};
  (machine?out:err)(safeJson(value,!machine)+'\n');
  return known && error.code === 'aborted' && error.action_id ? 3 : 1;
 }
}
