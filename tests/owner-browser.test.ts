import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { database } from './helpers';
import { setupAgent, key } from './approval-helpers';
import { submitWrite, submitDelete } from '../src/file-actions';
import { submitProxy } from '../src/proxy';

let f:Awaited<ReturnType<typeof database>>,browser:Browser,page:Page;
const origin='http://127.0.0.1:18765';
async function login() {await page.goto(origin);await page.getByLabel('Owner token',{exact:true}).fill(f.env.OWNER_TOKEN);await page.getByRole('button',{name:'Sign in',exact:true}).click();}

describe('owner app in Chromium with real Worker, D1, and R2',()=>{
 beforeAll(async()=>{f=await database(true,true,undefined,origin);await f.db.prepare('DELETE FROM settings').run();browser=await chromium.launch({headless:true});page=await browser.newPage();});
 afterAll(async()=>{await browser?.close();await f?.runtime.dispose();});
 it('signs in, completes setup, creates an agent, reviews grants, issues a token, and clears private state',async()=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await login();await ui(page.getByRole('heading',{name:'Set up your locker'})).toBeVisible();
  await page.getByLabel('I saved my owner token').check();await page.getByRole('button',{name:'Confirm and finish setup'}).click();
  await page.getByRole('button',{name:'Agents & grants',exact:true}).click();
  await page.getByLabel('Agent name',{exact:true}).fill('CLI <img src=x onerror=alert(1)>');await page.getByRole('button',{name:'Create agent',exact:true}).click();
  await ui(page.getByRole('heading',{name:'CLI <img src=x onerror=alert(1)>'})).toBeVisible();
  await page.getByLabel('Task token label').fill('Fix a bug');await page.getByRole('button',{name:'Issue token',exact:true}).click();
  await ui(page.locator('#issued-token')).toHaveText(/^al_[a-f0-9]{64}$/);
  await page.getByRole('button',{name:'Review grants',exact:true}).click();await page.getByRole('button',{name:'Add folder',exact:true}).click();
  await page.locator('#grant-editor').getByLabel('Folder prefix',{exact:true}).fill('/work/');await page.locator('#grant-editor').getByLabel('read',{exact:true}).check();
  await page.getByRole('button',{name:'Save reviewed grants'}).click();
  await ui(page.locator('#notice')).toContainText('Grants saved');
  await page.getByRole('button',{name:'Review and enable'}).click();await page.getByRole('button',{name:'Enable CLI',exact:false}).click();
  await ui(page.locator('#agent-list')).toContainText('enabled');
  expect(await page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage),cookies:document.cookie}))).toEqual({local:[],session:[],cookies:''});
  expect(await page.locator('body').innerText()).not.toContain(f.env.OWNER_TOKEN);expect(page.url()).not.toContain(f.env.OWNER_TOKEN);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'/tmp/agentlocker-owner-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await ui(page.locator('#issued-token')).toBeEmpty();await ui(page.locator('#agent-list')).toBeEmpty();await ui(page.locator('#storage')).toBeEmpty();
  expect(await page.locator('body').innerText()).not.toContain('CLI <img');await page.reload();await ui(page.getByRole('heading',{name:'Sign in to your locker'})).toBeVisible();expect(errors).toEqual([]);
 });
 it('loads complete inert request data before approval and applies an explicit batch decision',async()=>{
  const agent=await setupAgent(f),body='a'.repeat(7000)+'\nDANGEROUS_SUFFIX <script>window.pwned=1</script>\u001b\u202e';
  const pending=await submitProxy(agent.c,{secret:agent.secret.name,url:'https://api.example.com/send?complete=tail',method:'POST',body_text:body},key());
  const file=await submitWrite(agent.c,'/mine/review.bin',new Uint8Array([0,255,1,128]),'application/octet-stream',null,key());
  const deletion=await submitDelete(agent.c,'/mine/review.bin',file.result_revision!,key());
  await page.setViewportSize({width:1280,height:900});await login();await page.getByRole('button',{name:'Approvals',exact:true}).click();
  await ui(page.locator('#approval-list input[type=checkbox]:checked')).toHaveCount(0);
  await page.route('**/owner/approvals/*/content',async route=>{await new Promise(r=>setTimeout(r,250));await route.continue();});
  await page.locator('#approval-list label').filter({hasText:pending.target??'proxy.request'}).getByRole('checkbox').check();
  await ui(page.getByRole('button',{name:'Approve 1 selected',exact:true})).toBeEnabled();
  await ui(page.locator('#review-list')).toContainText('DANGEROUS_SUFFIX');await ui(page.locator('#review-list')).toContainText('\\u202e');
  await ui(page.locator('#review-list')).toContainText('Credential placeholder:');expect(await page.evaluate(()=>('pwned' in window))).toBe(false);
  await page.locator('#approval-list label').filter({hasText:'file.delete'}).getByRole('checkbox').check();
  await ui(page.getByRole('button',{name:'Approve 2 selected',exact:true})).toBeDisabled();await ui(page.getByRole('button',{name:'Approve 2 selected',exact:true})).toBeEnabled();
  await ui(page.locator('#review-list')).toContainText('AP8BgA==');
  await page.screenshot({path:'/tmp/agentlocker-owner-desktop.png',fullPage:true});
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Deny 2 selected',exact:true}).click();
  await ui(page.locator('#decision-result')).toContainText('denied');
  const rows=await f.db.prepare('SELECT status FROM actions WHERE id IN(?,?)').bind(pending.id,deletion.id).all<any>();expect(rows.results.map(r=>r.status)).toEqual(['denied','denied']);
  await page.getByRole('button',{name:'Audit log',exact:true}).click();await page.getByLabel('Action ID',{exact:true}).fill(pending.id);await page.getByRole('button',{name:'Apply filters'}).click();
  await ui(page.locator('#audit-events')).toContainText(pending.id);
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Export JSONL'}).click();expect((await downloaded).suggestedFilename()).toBe('agent-locker-audit.jsonl');
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await ui(page.locator('#review-list')).toBeEmpty();
 });
 it('loads and verifies a complete 10 MiB replacement without hiding its tail',async()=>{
  const agent=await setupAgent(f),path='/mine/large.txt',tail='DANGEROUS_REPLACEMENT_SUFFIX';
  const initial=await submitWrite(agent.c,path,new TextEncoder().encode('original'),'text/plain',null,key());
  const bytes=new Uint8Array(10*1024*1024).fill(97);bytes.set(new TextEncoder().encode(tail),bytes.length-tail.length);
  const pending=await submitWrite(agent.c,path,bytes,'text/plain',initial.result_revision!,key());
  await login();await page.getByRole('button',{name:'Approvals',exact:true}).click();
  await page.locator('#approval-list label').filter({hasText:path}).getByRole('checkbox').check();
  await ui(page.getByRole('button',{name:'Approve 1 selected',exact:true})).toBeEnabled({timeout:10000});
  await page.getByText('UTF-8 text: all 214 sections, including the final bytes',{exact:true}).click();
  const textSections=page.locator('#review-list details').filter({has:page.getByText('UTF-8 text: all 214 sections, including the final bytes',{exact:true})}).first();
  await textSections.getByText('Section 214 of 214 · text positions 10469377–10485760 of 10485760',{exact:true}).click();
  await ui(page.locator('#review-list pre').filter({hasText:'DANGEROUS_REPLACEMENT_SUFFIX'})).toContainText('DANGEROUS_REPLACEMENT_SUFFIX');
  const content=page.waitForEvent('download');await page.getByRole('button',{name:'Download complete content',exact:true}).click();
  const saved=await (await content).path();const {readFile}=await import('node:fs/promises');expect((await readFile(saved!)).equals(Buffer.from(bytes))).toBe(true);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Approve this request',exact:true}).click();
  await ui(page.locator('#decision-result')).toContainText('ready');
  await ui.poll(async()=> (await f.db.prepare('SELECT status FROM actions WHERE id=?').bind(pending.id).first<any>()).status).toBe('succeeded');
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
 });
 it('blocks approval when the displayed action digest fails verification',async()=>{
  const agent=await setupAgent(f),pending=await submitProxy(agent.c,{secret:agent.secret.name,url:'https://api.example.com/review',method:'GET'},key());
  await page.route('**/owner/approvals/'+pending.approval_id,async route=>{const response=await route.fetch();const data=await response.json();data.digest='0'.repeat(64);await route.fulfill({response,json:data});});
  await login();await page.getByRole('button',{name:'Approvals',exact:true}).click();
  await page.locator('#approval-list label').filter({hasText:'proxy.request'}).getByRole('checkbox').check();
  await ui(page.locator('#review-list')).toContainText('Action digest does not match');
  await ui(page.getByRole('button',{name:'Approve 1 selected',exact:true})).toBeDisabled();
  expect((await f.db.prepare('SELECT status FROM actions WHERE id=?').bind(pending.id).first<any>()).status).toBe('pending');
  await page.unroute('**/owner/approvals/'+pending.approval_id);await page.getByRole('button',{name:'Sign out',exact:true}).click();
 });
 it('polls at five seconds, backs off when idle, pauses when hidden, and shows stale data after failed refreshes',async()=>{
  await page.addInitScript(()=>{
   const original=window.fetch;(window as any).pollTimes=[];
   window.fetch=(...args)=>{if(String(args[0]).includes('/owner/overview?'))(window as any).pollTimes.push(Date.now());return original(...args);};
  });
  await page.clock.install();await page.clock.pauseAt(new Date(Date.now()+100));await login();await ui(page.locator('#refresh-time')).toContainText('Last refreshed');
  let calls=0,fail=false;
  await page.route('**/owner/overview?**',async route=>{calls++;if(fail)await route.fulfill({status:503,json:{error:{message:'Service unavailable'},request_id:'test-refresh'}});else await route.continue();});
  const advance=async(ms:number)=>{await page.clock.runFor(ms);await new Promise(r=>setTimeout(r,70));};
  await advance(4999);expect(calls).toBe(0);await advance(1);await ui.poll(()=>calls).toBe(1);
  for(let i=0;i<20;i++)await advance(5000);
  const times:number[]=await page.evaluate(()=>(window as any).pollTimes);
  const intervals=times.slice(1).map((time,i)=>time-times[i]);
  expect(intervals).toContain(5000);expect(intervals).toContain(15000);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  const hidden=calls;await advance(30000);expect(calls).toBe(hidden);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await ui.poll(()=>calls).toBe(hidden+1);fail=true;
  await new Promise(r=>setTimeout(r,70));await advance(15000);await advance(15000);await advance(1000);await ui(page.locator('#stale')).toBeVisible();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.unroute('**/owner/overview?**');
 });

});
