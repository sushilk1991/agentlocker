import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { database, bearer } from './helpers';
import { browserMatrix, captureScreen, expectNoPageOverflow } from './browser-helpers';
import { key } from './approval-helpers';
import { createAgent, issueToken, replaceGrants, setAgentStatus } from '../src/agents';
import { authenticate } from '../src/auth';
import { saveSecret } from '../src/secrets';
import { submitDelete, submitWrite } from '../src/file-actions';
import { submitProxy } from '../src/proxy';

const origin = 'http://127.0.0.1:18767';
describe.each(browserMatrix)('Owner shell and screenshot gallery at $width px in $theme', ({width, theme}) => {
 let f: Awaited<ReturnType<typeof database>>, browser: Browser, page: Page;
 let deletion: Awaited<ReturnType<typeof submitDelete>>;
 let errors: string[];
 beforeAll(async () => {
  f = await database(true, true, undefined, origin);
  browser = await chromium.launch({headless: true});
  const agent = await createAgent(f.context(), 'Coding assistant', 'Maintains project notes and drafts.');
  const token = await issueToken(f.context(), agent.id, 'Update project notes');
  const secret = await saveSecret(f.context(), {name: 'mail-service', value: 'disposable-gallery-key', hosts: ['api.example.com'], injection_header: 'Authorization', scheme: 'bearer'});
  await createAgent(f.context(), 'Research assistant', 'Waiting for folder and key grants.');
  await replaceGrants(f.context(), agent.id, 1, [{prefix: '/work/', read: true, write: true, delete: true}], [{secret_id: secret.id, read: true}]);
  await setAgentStatus(f.context(), agent.id, 'enabled');
  const c = f.context(await authenticate(f.context(), bearer(token.token, origin + '/api/v1/files'), false));
  const file = await submitWrite(c, '/work/project-notes.txt', new TextEncoder().encode('Project notes for the next release.\n'), 'text/plain', null, key());
  await submitWrite(f.context(), '/work/project-notes.txt', new TextEncoder().encode('Updated project notes.\n'), 'text/plain', file.result_revision!, key());
  const archivePath = '/work/archive/previous-release-notes-with-a-long-descriptive-filename.txt';
  const archive = await submitWrite(c, archivePath, new TextEncoder().encode('Archived notes.\n'), 'text/plain', null, key());
  deletion = await submitDelete(c, archivePath, archive.result_revision!, key());
  await submitProxy(c, {secret: secret.name, url: 'https://api.example.com/v1/messages?draft=release-notes', method: 'POST', headers: {'content-type': 'application/json'}, body_text: '{"to":"reader@example.com","subject":"Release notes","text":"The draft is ready for review."}'}, key());
 });
 beforeEach(async () => {
  await f.db.prepare('UPDATE settings SET setup_complete=1').run();
  page = await browser.newPage({viewport: {width, height: 900}, colorScheme: theme, reducedMotion: 'reduce'});
  page.setDefaultTimeout(5000); errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
   (window as any).cspViolations = [];
   document.addEventListener('securitypolicyviolation', event => (window as any).cspViolations.push(event.violatedDirective));
  });
 });
 afterEach(async () => {
  try {expect(errors).toEqual([]); expect(await page.evaluate(() => (window as any).cspViolations)).toEqual([]);}
  finally {await page?.close();}
 });
 afterAll(async () => {await browser?.close(); await f?.runtime.dispose();});
 async function login() {
  await page.goto(origin); await page.getByLabel('Owner token', {exact: true}).fill(f.env.OWNER_TOKEN);
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
 }
 async function nav(name: string) {
  if (width === 390) await page.getByRole('button', {name: 'Open navigation'}).click();
  await page.getByRole('link', name === 'Approvals' ? {name: /^Approvals/} : {name, exact: true}).click();
  await ui(page.getByRole('heading', {name, exact: true, level: 1})).toBeVisible();
 }
 const shot = (screen: string) => captureScreen(page, screen, width, theme);

 it('captures every main screen, full review, grants, and confirmation with loaded local data', async () => {
  await f.db.prepare('UPDATE settings SET setup_complete=0').run();
  await page.goto(origin); await ui(page.getByRole('heading', {name: 'Sign in to your locker'})).toBeVisible(); await shot('sign-in');
  await login(); await ui(page.getByRole('heading', {name: 'Set up your locker'})).toBeVisible(); await shot('setup');
  await page.getByLabel('I saved my owner token').check(); await page.getByRole('button', {name: 'Confirm and finish setup'}).click();
  await ui(page.locator('#approval-list input')).toHaveCount(2); await ui(page.locator('#pending-count')).toHaveText('2 pending approvals'); await shot('approvals');
  await page.locator('#approval-list label').filter({hasText: 'proxy.request'}).getByRole('checkbox').check();
  await ui(page.getByRole('button', {name: 'Approve this request', exact: true})).toBeEnabled(); await shot('approval-review');
  const approve = page.getByRole('button', {name: 'Approve this request', exact: true});
  await approve.click(); await ui(page.getByRole('alertdialog')).toBeVisible(); await shot('decision-confirmation');
  await page.getByRole('alertdialog').getByRole('button', {name: 'Cancel', exact: true}).click(); await ui(approve).toBeFocused();
  await nav('Agents'); await ui(page.getByRole('button', {name: 'Manage Coding assistant', exact: true})).toBeInViewport();
  expect(await page.locator('.agents-table .table-container').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await shot('agents');
  await page.getByRole('button', {name: 'Manage Coding assistant', exact: true}).click(); await ui(page.locator('#grant-editor')).toContainText('/work/'); await shot('agent-grants');
  await page.keyboard.press('Escape');
  await nav('Files'); await ui(page.locator('#file-list article')).toHaveCount(2); await shot('files');
  await page.locator('#file-list article').filter({hasText: '/work/project-notes.txt'}).getByRole('button', {name: 'Revisions and restore', exact: true}).click();
  await ui(page.locator('#file-history')).toContainText('Restore deadline:'); await shot('file-history');
  await nav('Keys'); await ui(page.locator('#secret-list')).toContainText('mail-service'); await shot('keys');
  await nav('Policy'); await ui(page.locator('#policy-version')).toContainText('Mandatory approvals');
  await page.getByRole('button', {name: 'Add rule', exact: true}).click(); await page.locator('#policy-rules').getByLabel('Folder prefix').fill('/work/private/'); await shot('policy');
  await nav('Audit log'); await page.locator('#audit-filter').getByLabel('Operation', {exact: true}).fill('proxy.request');
  await page.getByRole('button', {name: 'Apply filters', exact: true}).click(); await ui(page.locator('#audit-events tbody tr')).toHaveCount(1);
  expect(await page.locator('#audit-events .table-container').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await shot('audit');
  await nav('Settings'); await ui(page.locator('#settings-version')).toContainText('Editing version'); await shot('settings');
  if (width === 390) {await page.getByRole('button', {name: 'Open navigation'}).click(); await shot('navigation'); await page.keyboard.press('Escape');}
 }, 60000);

 it('supports keyboard navigation, drawer focus, lazy routes, history, and theme changes', async () => {
  const chunks: string[] = [];
  page.on('request', request => {if (/\/assets\/.*\.js$/.test(request.url())) chunks.push(request.url());});
  await login(); await ui(page.getByRole('heading', {name: 'Review requests', exact: true})).toBeVisible();
  expect(chunks.some(url => /\/assets\/(files|keys|audit)-/.test(url))).toBe(false);
  await ui(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^$/);
  expect(await page.evaluate(() => ({local: Object.keys(localStorage), session: Object.keys(sessionStorage), cookies: document.cookie}))).toEqual({local: [], session: [], cookies: ''});
  const skip = page.getByRole('link', {name: 'Skip to content', exact: true});
  await page.keyboard.press('Tab'); await skip.focus(); await ui(skip).toBeInViewport();
  expect(await skip.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
  await page.keyboard.press('Enter'); await ui(page.locator('#main')).toBeFocused();
  if (width === 390) {
   const menu = page.getByRole('button', {name: 'Open navigation'});
   await menu.focus(); await page.keyboard.press('Enter'); const drawer = page.getByRole('dialog', {name: 'Workspace navigation'});
   await ui(drawer).toBeVisible();
   for (let i = 0; i < 14; i++) {await page.keyboard.press('Tab'); expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);}
   await page.keyboard.press('Escape'); await ui(menu).toBeFocused(); await page.keyboard.press('Enter');
  }
  const files = page.getByRole('link', {name: 'Files', exact: true});
  await files.focus(); await page.keyboard.press('Enter'); await ui(page.getByRole('heading', {name: 'Upload a new file', exact: true})).toBeVisible();
  await ui(page.getByRole('dialog')).toHaveCount(0); expect(chunks.some(url => /\/assets\/files-/.test(url))).toBe(true);
  if (width === 1280) await ui(files).toHaveAttribute('aria-current', 'page');
  await page.goBack(); await ui(page.getByRole('heading', {name: 'Review requests', exact: true})).toBeVisible();
  await page.goForward(); await ui(page.getByRole('heading', {name: 'Upload a new file', exact: true})).toBeVisible();
  await expectNoPageOverflow(page);
  await page.emulateMedia({colorScheme: theme === 'dark' ? 'light' : 'dark'});
  await ui(page.locator('html')).toHaveClass(theme === 'dark' ? /^$/ : /dark/);
  if (width === 390) await page.getByRole('button', {name: 'Open navigation'}).click();
  await page.getByRole('button', {name: 'Theme: system. Switch to light'}).click(); await ui(page.locator('html')).toHaveClass(/^$/);
  await page.getByRole('button', {name: 'Theme: light. Switch to dark'}).click(); await ui(page.locator('html')).toHaveClass(/dark/);
  expect(await page.evaluate(() => localStorage.getItem('locker-theme'))).toBe('dark');
  await page.getByRole('button', {name: 'Theme: dark. Switch to system'}).click(); expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await ui(page.getByRole('heading', {name: 'Sign in to your locker'})).toBeVisible();
  await ui(page.locator('#file-list')).toHaveCount(0);
 });

 it('expires an open verified review without allowing a decision or changing the stored file', async () => {
  await page.clock.install();
  await login(); await ui(page.locator('#approval-list input')).toHaveCount(2);
  await page.locator('#approval-list label').filter({hasText: 'file.delete'}).getByRole('checkbox').check();
  const approve = page.getByRole('button', {name: 'Approve this request', exact: true});
  await ui(approve).toBeEnabled();
  await page.clock.pauseAt(new Date(Date.now() + 100));
  let decisions = 0;
  page.on('request', request => {if (request.method() === 'POST' && /\/decision(s)?$/.test(request.url())) decisions++;});
  await page.clock.fastForward(deletion.expires_at - Date.now() + 2000);
  await ui(page.locator('#review-list .badge')).toHaveText('expired');
  await ui(approve).toBeDisabled(); await ui(page.getByRole('button', {name: 'Deny this request', exact: true})).toBeDisabled();
  await ui(page.getByRole('button', {name: 'Approve 1 selected', exact: true})).toBeDisabled();
  await ui(page.getByRole('button', {name: 'Deny 1 selected', exact: true})).toBeDisabled();
  await shot('expired-review');
  expect(decisions).toBe(0);
  expect((await f.db.prepare('SELECT status FROM actions WHERE id=?').bind(deletion.id).first<any>()).status).toBe('pending');
  expect((await f.db.prepare('SELECT deleted_at FROM files WHERE path=(SELECT target FROM actions WHERE id=?)').bind(deletion.id).first<any>()).deleted_at).toBeNull();
 });
});
