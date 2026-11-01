import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, expect as ui, type Browser, type Page, type Request } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { database } from './helpers';
import { browserMatrix } from './browser-helpers';
import { key, setupAgent } from './approval-helpers';
import { submitWrite, submitDelete } from '../src/file-actions';
import { agentGrants } from '../src/owner';
import { replaceGrants } from '../src/agents';
import { saveSecret } from '../src/secrets';

const origin = 'http://127.0.0.1:18766';
describe.each(browserMatrix)('React owner management at $width px in $theme with real Worker, D1, R2', ({width, theme}) => {
 let f: Awaited<ReturnType<typeof database>>, browser: Browser, page: Page;
 beforeAll(async () => {f = await database(true, true, undefined, origin); browser = await chromium.launch({headless: true}); page = await browser.newPage({viewport: {width, height: 900}, colorScheme: theme}); page.setDefaultTimeout(5000);});
 beforeEach(async () => {if (page.url().startsWith(origin)) await page.evaluate(() => localStorage.removeItem('locker-theme'));});
 afterAll(async () => {await browser?.close(); await f?.runtime.dispose();});
 async function login(route: string) {
  await page.goto(origin + route); await page.getByLabel('Owner token', {exact: true}).fill(f.env.OWNER_TOKEN); await page.getByRole('button', {name: 'Sign in', exact: true}).click();
 }
 async function nav(name: string) {if (width === 390) await page.getByRole('button', {name: 'Open navigation'}).click(); await page.getByRole('link', name === 'Approvals' ? {name: /^Approvals/} : {name, exact: true}).click();}
 async function confirm() {await page.getByRole('alertdialog').getByRole('button', {name: 'Confirm decision', exact: true}).click();}
 async function logout() {
  if (width === 390) await page.getByRole('button', {name: 'Open navigation'}).click();
  await page.getByRole('button', {name: 'Sign out', exact: true}).click(); await ui(page.getByRole('heading', {name: 'Sign in to your locker'})).toBeVisible();
 }
 async function downloaded(button: ReturnType<Page['getByRole']>) {const waiting = page.waitForEvent('download'); await button.click(); const file = await waiting; return {name: file.suggestedFilename(), bytes: await readFile((await file.path())!)};}
 const fileCard = (path: string) => page.locator('#file-list article').filter({has: page.getByRole('heading', {name: path, exact: true})});
 async function owner(route: string, method: string, body: unknown) {
  return f.runtime.dispatchFetch(origin + '/api/v1/owner/' + route, {method, headers: {authorization: 'Bearer ' + f.env.OWNER_TOKEN, 'content-type': 'application/json', 'idempotency-key': key()}, body: JSON.stringify(body)});
 }
 it('creates, replaces, downloads, deletes, and restores exact bytes while keeping uploaded HTML inert', async () => {
  await login('/files');
  const path = '/browser/report.html', original = Buffer.concat([Buffer.from('<script>window.filePwned=1</script>'), Buffer.from([0, 255, 128])]), replacement = Buffer.from('replacement bytes');
  const writes: Record<string, string>[] = [], deletes: Record<string, string>[] = [], restores: unknown[] = [];
  const observe = (request: Request) => {
   if (request.url().includes('/owner/files/content?')) {if (request.method() === 'PUT') writes.push(request.headers()); if (request.method() === 'DELETE') deletes.push(request.headers());}
   if (request.url().endsWith('/owner/files/restore')) restores.push(request.postDataJSON());
  }; page.on('request', observe);
  await page.getByLabel('File path', {exact: true}).fill(path); await page.getByLabel('File to upload').setInputFiles({name: 'report.html', mimeType: 'text/html', buffer: original});
  await page.getByRole('button', {name: 'Upload file', exact: true}).click(); await ui(page.locator('#notice')).toContainText('File saved at revision');
  const first = (await f.db.prepare('SELECT current_revision_id FROM files WHERE path=?').bind(path).first<any>()).current_revision_id;
  expect(writes[0]['if-none-match']).toBe('*'); expect(writes[0]['if-match']).toBeUndefined();
  await page.locator('#file-filter').getByLabel('Folder prefix', {exact: true}).fill('/browser/'); await page.getByRole('button', {name: 'Browse files', exact: true}).click();
  const card = fileCard(path); await ui(card).toContainText('Author: Owner'); const attachment = await downloaded(card.getByRole('button', {name: 'Download file', exact: true}));
  expect(attachment.name).toBe('report.html'); expect(attachment.bytes.equals(original)).toBe(true); expect(await page.evaluate(() => 'filePwned' in window)).toBe(false);
  await card.getByRole('button', {name: 'Replace file', exact: true}).click(); await ui(page.locator('#file-precondition')).toContainText(first);
  await page.getByLabel('File to upload').setInputFiles({name: 'report.txt', mimeType: 'text/plain', buffer: replacement}); await page.getByRole('button', {name: 'Upload file', exact: true}).click();
  const digest = createHash('sha256').update(replacement).digest('hex'); await ui(page.getByRole('alertdialog')).toContainText(first); await ui(page.getByRole('alertdialog')).toContainText(digest); await confirm();
  await ui.poll(async () => (await f.db.prepare('SELECT current_revision_id FROM files WHERE path=?').bind(path).first<any>()).current_revision_id).not.toBe(first);
  await ui(card).toContainText(digest); const second = (await f.db.prepare('SELECT current_revision_id FROM files WHERE path=?').bind(path).first<any>()).current_revision_id;
  expect(writes[1]['if-match']).toBe('"' + first + '"'); expect(writes[1]['x-confirm-content-sha256']).toBe(digest);
  await card.getByRole('button', {name: 'Revisions and restore', exact: true}).click(); await ui(page.locator('#file-history')).toContainText('Restore deadline:');
  await card.getByRole('button', {name: 'Delete file', exact: true}).click(); await page.getByRole('alertdialog').getByRole('button', {name: 'Cancel', exact: true}).click(); expect(deletes).toHaveLength(0);
  await card.getByRole('button', {name: 'Delete file', exact: true}).click(); await confirm(); await ui(page.locator('#notice')).toContainText('File deleted');
  expect(deletes[0]['if-match']).toBe('"' + second + '"'); expect(deletes[0]['x-confirm-revision']).toBe(second); await ui(card.getByRole('button', {name: 'Download file', exact: true})).toHaveCount(0);
  await ui(page.locator('#file-history')).toContainText('(tombstone)');
  const old = page.locator('#file-history section').filter({has: page.getByRole('heading', {name: first, exact: true})});
  expect((await downloaded(old.getByRole('button', {name: 'Download revision', exact: true}))).bytes.equals(original)).toBe(true);
  await old.getByRole('button', {name: 'Restore revision', exact: true}).click(); await confirm(); await ui(page.locator('#notice')).toContainText('File restored as revision');
  expect(restores[0]).toEqual({source_revision: first, expected_revision: second}); expect((await downloaded(card.getByRole('button', {name: 'Download file', exact: true}))).bytes.equals(original)).toBe(true);
  const restored = await f.db.prepare('SELECT current_revision_id,deleted_at FROM files WHERE path=?').bind(path).first<any>(); expect(restored.deleted_at).toBeNull(); expect([first, second].includes(restored.current_revision_id)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  page.off('request', observe); await logout(); await ui(page.locator('#file-list')).toHaveCount(0); await ui(page.locator('#file-history')).toHaveCount(0); await ui(page.locator('#upload-path')).toHaveCount(0);
 });
 it('refuses stale replace, delete, and restore preconditions and never refreshes an open upload draft', async () => {
  const path = '/browser/conflict.txt', first = await submitWrite(f.context(), path, new TextEncoder().encode('initial'), 'text/plain', null, key());
  await login('/files'); const card = fileCard(path); await card.getByRole('button', {name: 'Replace file', exact: true}).click();
  await page.getByLabel('File to upload').setInputFiles({name: 'new.txt', mimeType: 'text/plain', buffer: Buffer.from('stale replacement')});
  await card.getByRole('button', {name: 'Revisions and restore', exact: true}).click();
  const changed = await submitWrite(f.context(), path, new TextEncoder().encode('new current'), 'text/plain', first.result_revision!, key());
  await page.getByRole('button', {name: 'Refresh now', exact: true}).click(); await page.getByRole('button', {name: 'Upload file', exact: true}).click(); await confirm();
  await ui(page.locator('#notice')).toContainText('The file revision has changed'); await ui(page.locator('#notice')).toContainText('Request'); await ui(page.locator('#file-precondition')).toContainText(first.result_revision!);
  await card.getByRole('button', {name: 'Delete file', exact: true}).click(); await confirm(); await ui(page.locator('#notice')).toContainText('The file revision has changed');
  // Reload the list to view the changed revision, then change it again before restore.
  await page.getByRole('button', {name: 'Browse files', exact: true}).click(); await ui(card).toContainText(changed.result_revision!);
  await card.getByRole('button', {name: 'Revisions and restore', exact: true}).click();
  const third = await submitWrite(f.context(), path, new TextEncoder().encode('third'), 'text/plain', changed.result_revision!, key());
  const old = page.locator('#file-history section').filter({has: page.getByRole('heading', {name: first.result_revision!, exact: true})});
  await old.getByRole('button', {name: 'Restore revision', exact: true}).click(); await confirm(); await ui(page.locator('#notice')).toContainText('The file revision has changed');
  expect((await f.db.prepare('SELECT current_revision_id FROM files WHERE path=?').bind(path).first<any>()).current_revision_id).toBe(third.result_revision);
  await ui(page.locator('#file-precondition')).toContainText(first.result_revision!); await logout();
 });
 it('creates and replaces key policy and value, shows grants and history, and disables use without revealing values', async () => {
  const value = 'disposable-browser-secret-' + key(), replacement = 'disposable-replacement-' + key();
  await login('/secrets'); await page.getByLabel('Secret name', {exact: true}).fill('browser-provider'); await page.getByLabel('Secret value', {exact: true}).fill(value);
  await page.getByLabel('Exact allowed hosts').fill('api.example.com\nother.example.com');
  const created = page.waitForResponse(response => response.url().endsWith('/owner/secrets') && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Create secret', exact: true}).click(); const response = await created, secret = await response.json(); expect(response.status()).toBe(201);
  await ui(page.locator('#notice')).toContainText('Secret saved'); await ui(page.locator('#secret-value')).toHaveValue(''); expect(JSON.stringify(secret).includes(value)).toBe(false); expect((await page.locator('body').innerText()).includes(value)).toBe(false);
  const card = page.locator('#secret-list article').filter({has: page.getByRole('heading', {name: 'browser-provider', exact: true})});
  await ui(card).toContainText('No agents have a grant'); await ui(card).toContainText('authorization: Bearer [saved value]');
  const agent = await setupAgent(f, false), grants = await agentGrants(f.context(), agent.a.id); await replaceGrants(f.context(), agent.a.id, grants.version, [], [{secret_id: secret.id, read: true}]);
  await nav('Approvals'); await nav('Keys'); await ui(card).toContainText(agent.a.name);
  await card.getByRole('button', {name: 'Edit secret', exact: true}).click(); await ui(page.getByLabel('Replacement value (optional)')).toHaveValue('');
  await page.getByLabel('Credential format').selectOption('plain'); await page.getByLabel('Injection header').fill('x-api-key'); await page.getByLabel('Exact allowed hosts').fill('api.example.com');
  await page.getByRole('button', {name: 'Save secret changes', exact: true}).click(); await ui(card).toContainText('version 2 · value version 1'); await ui(card).toContainText('x-api-key: [saved value]');
  await page.getByLabel('Replacement value (optional)').fill(replacement); await page.getByRole('button', {name: 'Save secret changes', exact: true}).click(); await ui(card).toContainText('version 3 · value version 2'); await ui(page.locator('#secret-value')).toHaveValue('');
  expect((await page.locator('body').innerText()).includes(replacement)).toBe(false);
  await card.getByRole('button', {name: 'Disable secret', exact: true}).click(); await confirm(); await ui(card).toContainText('Disabled · version 4');
  await card.getByRole('link', {name: 'Use history', exact: true}).click(); await ui(page.locator('#audit-filter').getByLabel('Secret name', {exact: true})).toHaveValue('browser-provider');
  await nav('Keys'); await card.getByRole('button', {name: 'Edit secret', exact: true}).click(); await page.getByLabel('Replacement value (optional)').fill('unsaved-disposable-key');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await logout(); await ui(page.locator('#secret-value')).toHaveCount(0); await ui(page.locator('#secret-list')).toHaveCount(0);
  expect((await page.locator('body').innerText()).includes('browser-provider')).toBe(false);
 });
 it('clears replacement input on failed key saves and blocks stale policy edits until reload', async () => {
  const secret = await saveSecret(f.context(), {name: 'stale-key', value: 'disposable-stale-key', hosts: ['api.example.com'], injection_header: 'authorization', scheme: 'bearer'});
  await login('/secrets'); const card = page.locator('#secret-list article').filter({has: page.getByRole('heading', {name: 'stale-key', exact: true})}); await card.getByRole('button', {name: 'Edit secret', exact: true}).click();
  await page.getByLabel('Exact allowed hosts').fill('owner-edited.example.com');
  await saveSecret(f.context(), {name: 'stale-key', hosts: ['changed.example.com'], injection_header: 'authorization', scheme: 'bearer'}, secret.id, secret.version);
  await page.getByLabel('Replacement value (optional)').fill('disposable-failed-replacement'); await page.getByRole('button', {name: 'Save secret changes', exact: true}).click();
  await ui(page.locator('#secret-value')).toHaveValue(''); await ui(page.locator('#notice')).toContainText('Request'); await ui(page.getByRole('button', {name: 'Save secret changes', exact: true})).toBeDisabled();
  await ui(page.getByLabel('Exact allowed hosts')).toHaveValue('owner-edited.example.com'); await page.getByRole('button', {name: 'Reload secret', exact: true}).click();
  await ui(page.getByLabel('Exact allowed hosts')).toHaveValue('changed.example.com'); await ui(page.locator('#secret-value')).toHaveValue(''); await logout();
 });
 it('saves scoped rules, refuses stale Settings saves, reloads, and clears private state from Settings', async () => {
  await saveSecret(f.context(), {name: 'browser-policy', value: 'disposable-policy-key', hosts: ['api.example.com'], injection_header: 'authorization', scheme: 'bearer', enabled: false});
  await login('/policy'); await ui(page.locator('#policy-version')).toContainText('Mandatory approvals: delete, replace, and every proxy send');
  await page.getByRole('button', {name: 'Add rule', exact: true}).click(); const rule = page.locator('#policy-rules fieldset');
  await rule.getByLabel('Operation', {exact: true}).selectOption('file.read'); await rule.getByLabel('Folder prefix').fill('/private/');
  await page.getByRole('button', {name: 'Add rule', exact: true}).click(); await rule.nth(1).getByLabel('Operation', {exact: true}).selectOption('secrets.list'); await rule.nth(1).getByLabel('Secret scope').selectOption({label: 'browser-policy (disabled)'});
  const policyRequests: any[] = []; const capture = (request: Request) => {if (request.url().endsWith('/owner/policy') && request.method() === 'PUT') policyRequests.push(request.postDataJSON());}; page.on('request', capture);
  const before = await f.db.prepare('SELECT config_version FROM settings').first<any>();
  await page.getByRole('button', {name: 'Save policy', exact: true}).click(); await confirm(); await ui(page.locator('#notice')).toContainText('Policy saved');
  expect(policyRequests[0].expected_version).toBe(before.config_version); expect(policyRequests[0].rules[0]).toEqual({operation: 'file.read', prefix: '/private/'}); expect(Object.keys(policyRequests[0].rules[1]).sort()).toEqual(['operation', 'secret_id']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await nav('Settings'); await ui(page.locator('#settings-version')).toContainText('Editing version'); await ui(page.locator('#settings')).toContainText('docs/operations.md'); await ui(page.locator('#settings')).toContainText('Audit metadata is kept indefinitely');
  await page.getByLabel('Default approval expiry in minutes').fill('9'); await page.getByLabel('File quota in bytes').fill('209715200'); await page.getByLabel('File history retention in days').fill('10');
  await page.getByRole('button', {name: 'Save settings', exact: true}).click(); await confirm(); await ui(page.locator('#notice')).toContainText('Settings saved');
  const saved = await f.db.prepare('SELECT config_version,approval_ttl,quota_bytes,retention_ms FROM settings').first<any>(); expect(saved).toEqual({config_version: before.config_version + 2, approval_ttl: 9 * 60000, quota_bytes: 209715200, retention_ms: 10 * 86400000});
  expect((await owner('settings', 'PATCH', {expected_version: saved.config_version, approval_ttl: 8 * 60000})).status).toBe(200);
  await page.getByLabel('Default approval expiry in minutes').fill('7'); await page.getByRole('button', {name: 'Refresh now', exact: true}).click();
  await page.getByRole('button', {name: 'Save settings', exact: true}).click(); await confirm(); await ui(page.locator('#notice')).toContainText('This version has changed'); await ui(page.locator('#notice')).toContainText('Request');
  await ui(page.getByLabel('Default approval expiry in minutes')).toHaveValue('7'); await ui(page.getByRole('button', {name: 'Save settings', exact: true})).toBeDisabled();
  expect((await f.db.prepare('SELECT approval_ttl FROM settings').first<any>()).approval_ttl).toBe(8 * 60000);
  await page.getByRole('button', {name: 'Reload settings', exact: true}).click(); await ui(page.getByLabel('Default approval expiry in minutes')).toHaveValue('8');
  await nav('Policy'); await rule.getByRole('button', {name: 'Remove rule', exact: true}).first().click(); await rule.getByRole('button', {name: 'Remove rule', exact: true}).first().click();
  await page.getByRole('button', {name: 'Save policy', exact: true}).click(); await confirm(); await ui(page.locator('#notice')).toContainText('Policy saved'); expect((await f.db.prepare('SELECT count(*) AS n FROM approval_rules').first<any>()).n).toBe(0);
  await nav('Settings'); await ui(page.locator('#settings-version')).toContainText('Editing version ' + (saved.config_version + 2) + '.'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', {name: 'Sign out of this locker', exact: true}).click(); await ui(page.getByRole('heading', {name: 'Sign in to your locker'})).toBeVisible();
  await ui(page.locator('#settings-version')).toHaveCount(0); await ui(page.locator('#settings-quota')).toHaveCount(0); expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]); page.off('request', capture);
 });
 it('keeps maintenance controls available and refuses stale extra rules until explicit reload', async () => {
  await login('/settings'); await ui(page.locator('#settings-version')).toContainText('Editing version');
  await page.getByLabel('Maintenance mode:').check(); await page.getByRole('button', {name: 'Save settings', exact: true}).click(); await confirm(); await ui(page.locator('#notice')).toContainText('Settings saved');
  expect((await f.db.prepare('SELECT maintenance FROM settings').first<any>()).maintenance).toBe(1);
  await page.getByLabel('Maintenance mode:').uncheck(); await page.getByRole('button', {name: 'Save settings', exact: true}).click(); await confirm(); await ui(page.locator('#notice')).toContainText('Settings saved');
  expect((await f.db.prepare('SELECT maintenance FROM settings').first<any>()).maintenance).toBe(0);
  await nav('Policy'); await page.getByRole('button', {name: 'Add rule', exact: true}).click(); await page.locator('#policy-rules').getByLabel('Folder prefix').fill('/draft/');
  const version = (await f.db.prepare('SELECT config_version FROM settings').first<any>()).config_version;
  expect((await owner('policy', 'PUT', {expected_version: version, rules: [{operation: 'file.read', prefix: '/changed/'}]})).status).toBe(200);
  await page.getByRole('button', {name: 'Save policy', exact: true}).click(); await confirm(); await ui(page.locator('#notice')).toContainText('This version has changed'); await ui(page.getByRole('button', {name: 'Save policy', exact: true})).toBeDisabled();
  await ui(page.locator('#policy-rules').getByLabel('Folder prefix')).toHaveValue('/draft/'); await page.getByRole('button', {name: 'Reload policy', exact: true}).click(); await ui(page.locator('#policy-rules').getByLabel('Folder prefix')).toHaveValue('/changed/');
  await logout();
 });
 it('filters, pages, follows action history, and exports all matching audit events as JSONL and CSV', async () => {
  const agent = await setupAgent(f), path = '/mine/audit.txt', file = await submitWrite(agent.c, path, new TextEncoder().encode('audit'), 'text/plain', null, key());
  const deletion = await submitDelete(agent.c, path, file.result_revision!, key());
  // More than one API page, containing untrusted text, with an exact trace filter.
  // Chromium trims fractional trailing zeroes; Playwright fill checks the exact
  // serialized value. Keep a stable millisecond part while testing precision.
  const trace = key(), start = Math.floor((Date.now() - 60000) / 1000) * 1000 + 123;
  await f.db.batch(Array.from({length: 55}, (_, index) => f.db.prepare("INSERT INTO audit_events(request_id,actor_kind,actor_name,operation,target,decision,result,reason_code) VALUES(?,'owner',?,'file.read',?,'allow','read','read')").bind(trace, '=FORMULA <img src=x onerror=window.auditPwned=1>\u202e', '/audit/' + index)));
  await login('/audit?request_id=' + trace + '&include_routine=true'); const filters = page.locator('#audit-filter');
  await ui(filters.getByLabel('Request ID', {exact: true})).toHaveValue(trace); await ui(page.locator('#audit-events tbody tr')).toHaveCount(50);
  await page.getByRole('button', {name: 'Older events', exact: true}).click(); await ui(page.locator('#audit-events tbody tr')).toHaveCount(55); await ui(page.getByRole('button', {name: 'Older events', exact: true})).toHaveCount(0);
  const jsonl = await downloaded(page.getByRole('button', {name: 'Export JSONL', exact: true})); expect(jsonl.name).toBe('agent-locker-audit.jsonl'); const events = jsonl.bytes.toString().trim().split('\n').map(line => JSON.parse(line)); expect(events).toHaveLength(55); expect(events.every(event => event.request_id === trace)).toBe(true);
  const csv = await downloaded(page.getByRole('button', {name: 'Export CSV', exact: true})); expect(csv.bytes.toString()).toContain("'=FORMULA"); expect(await page.evaluate(() => 'auditPwned' in window)).toBe(false); await ui(page.locator('#audit-events')).toContainText('\\u202e');
  await filters.getByLabel('Exact file path', {exact: true}).fill('/audit/1'); await page.getByRole('button', {name: 'Apply filters', exact: true}).click(); await ui(page.locator('#audit-events tbody tr')).toHaveCount(1);
  await filters.getByLabel('Exact file path', {exact: true}).fill(''); await filters.getByLabel('Request ID', {exact: true}).fill(''); await filters.getByLabel('Action ID', {exact: true}).fill(deletion.id); await page.getByRole('button', {name: 'Apply filters', exact: true}).click();
  await ui(page.locator('#audit-events')).toContainText(deletion.id); await page.locator('#audit-events').getByRole('link', {name: 'Action: ' + deletion.id, exact: true}).first().click(); await ui(filters.getByLabel('Action ID', {exact: true})).toHaveValue(deletion.id);
  expect((await downloaded(page.getByRole('button', {name: 'Export JSONL', exact: true}))).bytes.toString().trim().split('\n').map(line => JSON.parse(line)).every(event => event.action_id === deletion.id)).toBe(true);
  await page.getByRole('button', {name: 'Clear filters', exact: true}).click(); await ui(page).toHaveURL(origin + '/audit?include_routine=false'); await ui(filters.getByLabel('Action ID', {exact: true})).toHaveValue('');
  await filters.getByLabel('Folder prefix', {exact: true}).fill('/unsaved/'); await page.getByRole('button', {name: 'Clear filters', exact: true}).click(); await ui(filters.getByLabel('Folder prefix', {exact: true})).toHaveValue('');
  await filters.getByLabel('Folder prefix', {exact: true}).fill('/audit/'); await filters.getByLabel('Operation', {exact: true}).fill('file.read'); await filters.getByLabel('Decision', {exact: true}).fill('allow'); await filters.getByLabel('Outcome', {exact: true}).fill('read');
  const localStart = await page.evaluate(value => new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 23), start); await filters.getByLabel('From', {exact: true}).fill(localStart);
  await page.getByRole('button', {name: 'Apply filters', exact: true}).click(); await ui(page.locator('#audit-events tbody tr')).toHaveCount(50); const params = new URL(page.url()).searchParams; expect(params.get('from')).toBe(String(start)); expect(params.get('prefix')).toBe('/audit/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await logout(); await ui(page.locator('#audit-events')).toHaveCount(0);
 });
});
