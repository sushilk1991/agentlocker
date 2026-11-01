import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentLocker, Download } from '../packages/sdk/src/index.ts';
import { canonical } from '../src/security.ts';

const run = 'smoke-' + randomUUID();
const ids = new Set<string>();
let passed = 0, failed = false;
const requireCheck = (ok: unknown) => { if (!ok) throw new Error('Observation did not match the check.'); };
async function check(name: string, work: () => Promise<void>) {
  ids.clear();
  try {
    await work(); passed++;
    console.log(`PASS ${name} request_ids=${[...ids].join(',') || 'none(public route)'}`);
  } catch {
    console.error(`FAIL ${name} request_ids=${[...ids].join(',') || 'none'}`);
    failed = true;
    throw new Error('Smoke check failed.');
  }
}

async function smoke() {
  const origin = process.env.AGENTLOCKER_URL, ownerToken = process.env.AGENTLOCKER_OWNER_TOKEN;
  requireCheck(origin && ownerToken);
  const url = new URL(origin!);
  requireCheck(url.origin === origin && (url.protocol === 'https:' ||
    url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
  const clients: Client[] = [];
  const agents: { id: string; tokenId?: string; token?: string; prefix: string }[] = [];
  const paths = new Set<string>();
  let secret: { id: string; version: number } | undefined;
  const trackedFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, { ...init, redirect: 'manual', signal: init?.signal ?? AbortSignal.timeout(20000) });
    const id = response.headers.get('x-request-id'); if (id) ids.add(id);
    return response;
  };
  async function http(route: string, token?: string, method = 'GET', body?: BodyInit, headers: Record<string, string> = {}) {
    const response = await trackedFetch(origin + route, { method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method !== 'GET' ? { 'idempotency-key': randomUUID() } : {}), ...headers,
    }, body });
    if (route.startsWith('/api/')) requireCheck(response.headers.get('x-request-id'));
    return response;
  }
  async function owner(route: string, method = 'GET', input?: unknown, headers?: Record<string, string>): Promise<any> {
    const response = await http('/api/v1/owner/' + route, ownerToken, method,
      input === undefined ? undefined : JSON.stringify(input),
      { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers });
    requireCheck(response.ok);
    return response.json();
  }
  async function provision(suffix: string, secretId?: string) {
    const created = await owner('agents', 'POST', { name: run + '-' + suffix, description: 'Disposable smoke test' });
    const agent = { id: created.id, prefix: '/' + run + '/' + suffix + '/', tokenId: undefined as string | undefined, token: undefined as string | undefined };
    agents.push(agent); // Register cleanup before the next request can fail.
    await owner(`agents/${agent.id}/grants`, 'PUT', { expected_version: 1,
      folders: [{ prefix: agent.prefix, read: true, write: true, delete: true }],
      secrets: secretId ? [{ secret_id: secretId, read: true }] : [],
    });
    const issued = await owner(`agents/${agent.id}/tokens`, 'POST', { label: run, lifetime_ms: 3600000 });
    agent.tokenId = issued.id; agent.token = issued.token;
    requireCheck(typeof agent.token === 'string');
    await owner(`agents/${agent.id}`, 'PATCH', { status: 'enabled' });
    return agent;
  }
  async function action(id: string, token: string) {
    const response = await http('/api/v1/actions/' + id, token);
    requireCheck(response.ok); return response.json() as Promise<any>;
  }
  async function finish(id: string, token: string) {
    const deadline = Date.now() + 30000;
    do {
      const result = await action(id, token);
      if (!['pending', 'ready', 'executing'].includes(result.status)) return result;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    throw new Error('Action did not finish in time.');
  }
  async function decide(pending: any, decision: 'approve' | 'deny', path: string, revision: string) {
    const review = await owner('approvals/' + pending.approval_id);
    requireCheck(review.target === path && review.input.expected_revision === revision && review.operation === 'file.delete');
    requireCheck(createHash('sha256').update(canonical({ input: review.input, ...review.digest_context })).digest('hex') === review.digest);
    const content = await http('/api/v1/owner/approvals/' + pending.approval_id + '/content', ownerToken);
    requireCheck(content.ok);
    const bytes = Buffer.from(await content.arrayBuffer());
    requireCheck(bytes.length === review.input.previous_length && createHash('sha256').update(bytes).digest('hex') === review.input.previous_hash);
    return owner('approvals/' + pending.approval_id + '/decision', 'POST', { digest: review.digest, decision });
  }
  try {
    await check('minimal public health', async () => {
      const response = await http('/healthz');
      requireCheck(response.status === 200 && await response.text() === 'ok');
    });
    await check('owner app HTML', async () => {
      const response = await http('/');
      requireCheck(response.ok && response.headers.get('content-type')?.startsWith('text/html'));
      requireCheck((await response.text()).includes('Agent Locker'));
    });
    await check('unauthenticated API refused', async () => {
      for (const route of ['/api/v1/files?prefix=/', '/api/v1/owner/session']) {
        const response = await http(route);
        requireCheck(response.status === 401); await response.body?.cancel();
      }
    });
    await check('owner session and authenticated setup', async () => {
      const session = await owner('session');
      requireCheck(session.public_origin === origin && !session.maintenance);
      if (!session.setup_complete) {
        await owner('setup', 'POST', { approval_ttl: session.approval_ttl, quota_bytes: session.quota_bytes, retention_ms: session.retention_ms });
      }
      requireCheck((await owner('session')).setup_complete);
    });
    await check('two disposable agents with disjoint grants', async () => {
      secret = await owner('secrets', 'POST', { name: run, value: randomBytes(32).toString('hex'),
        hosts: ['allowed.example.com'], injection_header: 'Authorization', scheme: 'bearer' });
      await provision('a', secret!.id); await provision('b');
      for (const a of agents) {
        const grants = await owner(`agents/${a.id}/grants`);
        requireCheck(grants.folders.length === 1 && grants.folders[0].prefix === a.prefix);
      }
    });
    const [first, second] = agents;
    const sdk = new AgentLocker({ base_url: origin!, token: first.token!, fetch: trackedFetch });
    const path = first.prefix + 'http.bin', sdkPath = first.prefix + 'sdk.bin';
    const bytes = new Uint8Array([0, 255, 128, 10, 13, 1, 0, 42]);
    let revision = '', restoredRevision = '';
    await check('HTTP write and binary read', async () => {
      paths.add(path);
      const write = await http('/api/v1/files/content?path=' + encodeURIComponent(path), first.token, 'PUT', bytes,
        { 'content-type': 'application/octet-stream', 'if-none-match': '*' });
      requireCheck(write.ok); const result = await write.json() as any;
      requireCheck(result.status === 'succeeded'); revision = result.result_revision;
      const read = await http('/api/v1/files/content?path=' + encodeURIComponent(path), first.token);
      requireCheck(read.ok && read.headers.get('etag') === '"' + revision + '"');
      requireCheck(Buffer.from(await read.arrayBuffer()).equals(bytes));
    });
    await check('SDK write and binary read', async () => {
      paths.add(sdkPath);
      const written = await sdk.files.write(sdkPath, bytes, { create_only: true, media_type: 'application/octet-stream', idempotency_key: randomUUID() });
      requireCheck(written.status === 'succeeded');
      const read = await sdk.files.read(sdkPath);
      requireCheck(read instanceof Download);
      if (read instanceof Download) requireCheck(Buffer.from(await read.bytes()).equals(bytes));
    });
    await check('cross-agent read refused', async () => {
      const response = await http('/api/v1/files/content?path=' + encodeURIComponent(path), second.token);
      requireCheck(response.status === 404 && (await response.json() as any).error.code === 'not_found_or_not_allowed');
    });
    let client: Client;
    await check('official MCP initialize, tools/list, binary read', async () => {
      client = new Client({ name: 'agentlocker-smoke', version: '0.1.0' }); clients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
        requestInit: { headers: { authorization: `Bearer ${first.token}` } }, fetch: trackedFetch,
      });
      await client.connect(transport);
      const tools = await client.listTools(); requireCheck(tools.tools.some(t => t.name === 'locker_file_read'));
      const read = await client.callTool({ name: 'locker_file_read', arguments: { path } });
      const content = read.structuredContent as any;
      requireCheck(!read.isError && content.revision === revision && content.content === Buffer.from(bytes).toString('base64'));
    });
    let pending: any;
    await check('exact-revision delete stays pending in owner queue', async () => {
      pending = await sdk.files.delete(path, revision, { idempotency_key: randomUUID() });
      requireCheck(pending.status === 'pending' && pending.approval_id);
      requireCheck((await action(pending.id, first.token!)).status === 'pending');
      const queue = await owner('approvals?state=pending&limit=100');
      requireCheck(queue.approvals.some((p: any) => p.approval_id === pending.approval_id));
      const read = await sdk.files.read(path); requireCheck(read instanceof Download);
      if (read instanceof Download) requireCheck(Buffer.from(await read.bytes()).equals(bytes));
      requireCheck((await action(pending.id, first.token!)).status === 'pending');
    });
    await check('owner approves delete and execution completes', async () => {
      requireCheck((await decide(pending, 'approve', path, revision)).status === 'ready');
      const done = await finish(pending.id, first.token!); requireCheck(done.status === 'succeeded');
      const read = await http('/api/v1/files/content?path=' + encodeURIComponent(path), first.token);
      requireCheck(read.status === 404); await read.body?.cancel();
    });
    await check('owner restores retained bytes', async () => {
      const listing = await owner('files?prefix=' + encodeURIComponent(first.prefix));
      const metadata = listing.files.find((f: any) => f.path === path);
      requireCheck(metadata?.deleted_at);
      const restore = await owner('files/restore', 'POST', { source_revision: revision, expected_revision: metadata.revision });
      requireCheck(restore.status === 'succeeded'); restoredRevision = restore.result_revision;
      const read = await sdk.files.read(path); requireCheck(read instanceof Download && read.revision === restoredRevision);
      if (read instanceof Download) requireCheck(Buffer.from(await read.bytes()).equals(bytes));
    });
    await check('second delete denied without changing the file', async () => {
      const deletion = await sdk.files.delete(path, restoredRevision, { idempotency_key: randomUUID() });
      requireCheck(deletion.status === 'pending');
      await decide(deletion, 'deny', path, restoredRevision);
      requireCheck((await finish(deletion.id, first.token!)).status === 'denied');
      const read = await sdk.files.read(path); requireCheck(read instanceof Download && read.revision === restoredRevision);
      if (read instanceof Download) requireCheck(Buffer.from(await read.bytes()).equals(bytes));
    });
    await check('unlisted proxy host refused before queueing', async () => {
      const before = await sdk.actions.list({ limit: 100 });
      const response = await http('/api/v1/proxy/requests', first.token, 'POST',
        JSON.stringify({ secret: run, url: 'https://unlisted.example.com/smoke', method: 'GET' }), { 'content-type': 'application/json' });
      requireCheck(response.status === 404);
      const rejection = await response.json() as any;
      requireCheck(rejection.error.code === 'not_found_or_not_allowed' && !rejection.approval_id && !rejection.id);
      const after = await sdk.actions.list({ limit: 100 });
      requireCheck(JSON.stringify(before.actions.map(a => a.id).sort()) === JSON.stringify(after.actions.map(a => a.id).sort()));
    });
    await check('audit list and JSONL export contain this run', async () => {
      const events = await owner('audit?agent_id=' + first.id + '&limit=100');
      requireCheck(events.events.some((e: any) => e.operation === 'file.read' && e.target === path));
      const response = await http('/api/v1/owner/audit/export?format=jsonl&agent_id=' + first.id, ownerToken);
      requireCheck(response.ok);
      const exported = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
      requireCheck(events.events.every((e: any) => exported.some(row => row.id === e.id && row.request_id === e.request_id)));
      const timeline = await owner('audit?action_id=' + pending.id + '&limit=100');
      requireCheck(timeline.events.some((e: any) => e.operation === 'approval.decision' && e.result === 'ready') &&
        timeline.events.some((e: any) => e.operation === 'file.delete' && e.result === 'deleted' &&
          e.agent_id === first.id && JSON.parse(e.metadata).revision === revision));
    });
    await check('revoked token blocks next HTTP and MCP call', async () => {
      await owner(`agents/${first.id}/tokens/${first.tokenId}`, 'DELETE');
      const response = await http('/api/v1/whoami', first.token); requireCheck(response.status === 401); await response.body?.cancel();
      let refused = false;
      try { await client!.callTool({ name: 'locker_file_read', arguments: { path } }); }
      catch (error) { refused = (error as { code?: number }).code === 401; }
      requireCheck(refused);
    });
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    // Attempt every cleanup even if another fails. Keep audit/history evidence.
    const cleanup: (() => Promise<void>)[] = agents.flatMap(a => [
      async () => { await owner(`agents/${a.id}`, 'PATCH', { status: 'disabled' }); },
      ...(a.tokenId ? [async () => { await owner(`agents/${a.id}/tokens/${a.tokenId}`, 'DELETE'); }] : []),
    ]);
    for (const path of paths) cleanup.push(async () => {
      const response = await http('/api/v1/owner/files/metadata?path=' + encodeURIComponent(path), ownerToken);
      if (response.status === 404) { await response.body?.cancel(); return; }
      requireCheck(response.ok); const metadata = await response.json() as any;
      if (metadata.deleted_at) return;
      const deletion = await http('/api/v1/owner/files/content?path=' + encodeURIComponent(path), ownerToken, 'DELETE', undefined,
        { 'if-match': '"' + metadata.revision + '"', 'x-confirm-revision': metadata.revision });
      requireCheck(deletion.ok && (await deletion.json() as any).status === 'succeeded');
    });
    if (secret) cleanup.push(async () => { await owner(`secrets/${secret!.id}/disable`, 'POST', { expected_version: secret!.version }); });
    ids.clear(); let clean = true;
    for (const work of cleanup) try { await work(); } catch { clean = false; }
    console[clean ? 'log' : 'error'](`${clean ? 'PASS' : 'FAIL'} cleanup: agents disabled, tokens revoked, files soft-deleted, secret disabled request_ids=${[...ids].join(',') || 'none'}`);
    if (!clean) { failed = true; throw new Error('Cleanup failed.'); }
  }
}

try {
  await smoke();
  console.log(`Smoke passed (${passed} checks). run=${run} app=0.1.0 schema=4`);
} catch {
  if (!failed) console.error('FAIL smoke configuration or connection. Set AGENTLOCKER_URL to the exact origin and AGENTLOCKER_OWNER_TOKEN through the environment.');
  console.error(`Smoke failed. run=${run}; inspect the request IDs in the owner audit log. No credentials are printed.`);
  process.exitCode = 1;
}
