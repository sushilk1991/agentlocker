import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { actionResult, batchDecision, decideApproval, executeAction, getAction, reviewApproval, sweepActions } from '../src/approvals';
import { submitDelete, submitWrite } from '../src/file-actions';
import { gateFileRead } from '../src/file-read-actions';
import { readFile } from '../src/files';
import { replaceGrants, revokeToken } from '../src/agents';
import { submitProxy } from '../src/proxy';
import { bytes } from '../src/security';
import { NOW } from '../src/types';
import { database } from './helpers';
import { approve, key, requestFor, setupAgent, writeFile } from './approval-helpers';

let f:Awaited<ReturnType<typeof database>>;
const row=(id:string)=>f.db.prepare('SELECT * FROM actions WHERE id=?').bind(id).first<any>();
async function expire(id:string) {
 // Change only a fixture's immutable deadline. Reinstall the production trigger.
 const trigger=await f.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='action_immutable'").first<string>('sql');
 await f.db.prepare('DROP TRIGGER action_immutable').run();
 await f.db.prepare(`UPDATE actions SET expires_at=${NOW} WHERE id=?`).bind(id).run();
 await f.db.prepare(trigger!).run();
 await f.db.prepare(`UPDATE approvals SET expires_at=${NOW} WHERE action_id=? AND state='pending'`).bind(id).run();
}

describe('durable exact approvals and execution with real D1/R2',()=>{
 beforeAll(async()=>{f=await database();});
 afterAll(async()=>{await f?.runtime.dispose();});
 it('requires an exact digest and separates approval from execution and polling',async()=>{
  const {c}=await setupAgent(f,false),p='/mine/'+key(), first=await writeFile(f,p);
  const pending=await submitDelete(c,p,first.result_revision!,key());
  const review=await reviewApproval(f.context(),pending.approval_id!);
  expect(review.input).toMatchObject({path:p,expected_revision:first.result_revision,previous_length:8,file_id:expect.any(String)});
  expect(review.token.label).toBe('approval-task');
  await expect(decideApproval(f.context(),pending.approval_id!,'a'.repeat(64),'approve')).rejects.toHaveProperty('code','digest_conflict');
  await expect(decideApproval(c,pending.approval_id!,review.digest,'approve')).rejects.toHaveProperty('code','forbidden');
  expect((await approve(f,pending)).status).toBe('ready');
  for(let i=0;i<3;i++)expect((await getAction(c,pending.id)).status).toBe('ready');
  expect((await readFile(c,p)).r.id).toBe(first.result_revision);
  expect(await executeAction(f.context(),pending.id)).toMatchObject({status:'succeeded'});
  expect((await getAction(c,pending.id)).attempt?.state).toBe('succeeded');
  await expect(readFile(c,p)).rejects.toHaveProperty('code','not_found_or_not_allowed');
  await expect(decideApproval(f.context(),pending.approval_id!,review.digest,'deny')).rejects.toHaveProperty('code','decision_conflict');
 });
 it('permits one concurrent decision and preserves the winning state and one audit event',async()=>{
  const {c,secret}=await setupAgent(f),a=await submitProxy(c,requestFor(secret),key());
  const review=await reviewApproval(f.context(),a.approval_id);
  const outcomes=await Promise.allSettled(['approve','deny'].map(d=>decideApproval(f.context(),a.approval_id,review.digest,d as any)));
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect(['ready','denied']).toContain((await row(a.id)).status);
  expect(await f.db.prepare("SELECT count(*) FROM audit_events WHERE action_id=? AND operation='approval.decision'").bind(a.id).first('count(*)')).toBe(1);
 });
 it('denial is terminal and never sends',async()=>{
  const {c,secret}=await setupAgent(f),a=await submitProxy(c,requestFor(secret),key());
  const review=await reviewApproval(f.context(),a.approval_id),fetcher=vi.fn();
  await decideApproval(f.context(),a.approval_id,review.digest,'deny','Not this request');
  expect((await executeAction(f.context(),a.id,fetcher)).status).toBe('denied');expect(fetcher).not.toHaveBeenCalled();
  await expect(f.db.prepare("UPDATE actions SET status='ready' WHERE id=?").bind(a.id).run()).rejects.toThrow('invalid_action_transition');
 });
 it('expires pending and ready actions at the D1 boundary, without relying on a sweep or application time',async()=>{
  const {c,secret}=await setupAgent(f);
  const pending=await submitProxy(c,requestFor(secret),key()),ready=await submitProxy(c,requestFor(secret),key());
  const review=await reviewApproval(f.context(),pending.approval_id);await approve(f,ready);
  await expire(pending.id);await expire(ready.id);
  await expect(f.db.prepare("UPDATE actions SET status='ready' WHERE id=?").bind(pending.id).run()).rejects.toThrow('action_expired');
  const clock=vi.spyOn(Date,'now').mockReturnValue(0);
  try {
   await expect(decideApproval(f.context(),pending.approval_id,review.digest,'approve')).rejects.toHaveProperty('code','decision_conflict');
   expect((await executeAction(f.context(),ready.id)).status).toBe('expired');
  } finally {clock.mockRestore();}
  expect((await getAction(c,pending.id)).status).toBe('expired');
  expect(await f.db.prepare('SELECT count(*) FROM execution_attempts WHERE action_id IN(?,?)').bind(pending.id,ready.id).first('count(*)')).toBe(0);
 });
 it('invalidates stale file revisions and tampered staged bytes before approval',async()=>{
  const {c}=await setupAgent(f,false),p='/mine/'+key(),first=await writeFile(f,p);
  const a=await submitDelete(c,p,first.result_revision!,key()),review=await reviewApproval(f.context(),a.approval_id!);
  const next=await submitWrite(f.context(),p,bytes('new'),'text/plain',first.result_revision,key());
  await expect(decideApproval(f.context(),a.approval_id!,review.digest,'approve')).rejects.toHaveProperty('code','decision_conflict');
  expect((await row(a.id)).status).toBe('invalidated');
  const replacement=await submitWrite(c,p,bytes('proposal'),'text/plain',next.result_revision,key());
  const r=await f.db.prepare('SELECT object_key FROM file_revisions WHERE action_id=?').bind(replacement.id).first<any>();
  await f.env.FILES.put(r.object_key,bytes('tampered'));
  await expect(reviewApproval(f.context(),replacement.approval_id!)).rejects.toHaveProperty('code','content_integrity_error');
  expect((await row(replacement.id)).status).toBe('invalidated');
 });
 it('rechecks original credentials and grant expiry before execution',async()=>{
  const {c,secret,a,t}=await setupAgent(f),pending=await submitProxy(c,requestFor(secret),key());await approve(f,pending);
  await revokeToken(f.context(),a.id,t.id);
  const fetcher=vi.fn();expect((await executeAction(f.context(),pending.id,fetcher)).status).toBe('invalidated');
  const other=await setupAgent(f),job=await submitProxy(other.c,requestFor(other.secret),key());await approve(f,job);
  await f.db.prepare('UPDATE secret_grants SET expires_at=1 WHERE agent_id=?').bind(other.a.id).run();
  expect((await executeAction(f.context(),job.id,fetcher)).status).toBe('invalidated');expect(fetcher).not.toHaveBeenCalled();
 });
 it('races immediate and scheduled executors with only one claim and dispatch',async()=>{
  const {c,secret}=await setupAgent(f),a=await submitProxy(c,requestFor(secret),key());await approve(f,a);
  const fetcher=vi.fn(async()=>new Response('done'));
  await Promise.all([executeAction(f.context(),a.id,fetcher),sweepActions(f.context(),fetcher),executeAction(f.context(),a.id,fetcher)]);
  expect(fetcher).toHaveBeenCalledTimes(1);expect((await row(a.id)).status).toBe('succeeded');
  expect(await f.db.prepare('SELECT count(*) FROM execution_attempts WHERE action_id=?').bind(a.id).first('count(*)')).toBe(1);
 });
 it('reconciles abandoned sends to unknown and rejects a late successful write',async()=>{
  const {c,secret}=await setupAgent(f),a=await submitProxy(c,requestFor(secret),key());await approve(f,a);
  let release!:(r:Response)=>void,started!:()=>void;
  const dispatched=new Promise<void>(r=>{started=r;});
  const fetcher=vi.fn(()=>{started();return new Promise<Response>(r=>{release=r;});});
  const running=executeAction(f.context(),a.id,fetcher);await dispatched;
  await f.db.prepare('UPDATE actions SET updated_at=1 WHERE id=?').bind(a.id).run();
  await sweepActions(f.context(),fetcher);expect((await row(a.id)).status).toBe('unknown');
  release(new Response('late'));await running;
  expect((await row(a.id)).status).toBe('unknown');await sweepActions(f.context(),fetcher);expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('allows an already dispatched request to finish after its approval deadline',async()=>{
  const {c,secret}=await setupAgent(f),a=await submitProxy(c,requestFor(secret),key());await approve(f,a);
  const fetcher=vi.fn(async()=>{await expire(a.id);return new Response('ok');});
  expect((await executeAction(f.context(),a.id,fetcher)).status).toBe('succeeded');
 });
 it('returns per-member batch outcomes with a shared id, and validates selections',async()=>{
  const {c,secret}=await setupAgent(f),jobs=[];
  for(let i=0;i<4;i++){const a=await submitProxy(c,requestFor(secret),key());jobs.push({a,r:await reviewApproval(f.context(),a.approval_id)});}
  await expire(jobs[1].a.id);await decideApproval(f.context(),jobs[3].a.approval_id,jobs[3].r.digest,'deny');
  const members=jobs.map(({a,r},i)=>({id:a.approval_id,digest:i===2?'b'.repeat(64):r.digest}));
  const batch=await batchDecision(f.context(),members,'approve');
  expect(batch.results.map(r=>'status' in r?r.status:r.error_code)).toEqual(['ready','decision_conflict','digest_conflict','decision_conflict']);
  expect(await f.db.prepare('SELECT batch_id FROM approvals WHERE id=?').bind(jobs[0].a.approval_id).first('batch_id')).toBe(batch.batch_id);
  for(const invalid of [[],Array(21).fill({id:'x',digest:'a'.repeat(64)}),[members[0],members[0]],[{id:'x'}]])await expect(batchDecision(f.context(),invalid as any,'approve')).rejects.toHaveProperty('code','invalid_batch');
  expect((await batchDecision(f.context(),[{id:'missing',digest:'a'.repeat(64)}],'deny')).results[0]).toMatchObject({error_code:'not_found'});
 });
 it('completes rule-gated reads, preserves exact bytes, and never runs them from result GET',async()=>{
  const {c}=await setupAgent(f,false),p='/mine/'+key(),first=await writeFile(f,p);
  await f.db.prepare("INSERT INTO approval_rules VALUES(?, 'file.read', '/mine/', NULL, 1, 0)").bind(key()).run();
  const a=await gateFileRead(c,'file.read',p,key());expect(a?.status).toBe('pending');
  await expect(actionResult(c,a!.id)).rejects.toHaveProperty('code','result_not_ready');
  await approve(f,a!);await executeAction(f.context(),a!.id);
  await submitWrite(f.context(),p,bytes('later'),'text/plain',first.result_revision,key());
  expect(await (await actionResult(c,a!.id)).text()).toBe('original');
  const other=await setupAgent(f,false);await expect(actionResult(other.c,a!.id)).rejects.toHaveProperty('code','not_found_or_not_allowed');
  await f.db.prepare('DELETE FROM folder_grants WHERE agent_id=?').bind(c.actor.agentId).run();
  await expect(actionResult(c,a!.id)).rejects.toHaveProperty('code','not_found_or_not_allowed');
 });
 it('rolls back decision and claim when the linked audit insert fails',async()=>{
  const {c,secret}=await setupAgent(f),a=await submitProxy(c,requestFor(secret),key()),review=await reviewApproval(f.context(),a.approval_id);
  await f.db.prepare("CREATE TRIGGER fail_decision BEFORE INSERT ON audit_events WHEN NEW.operation='approval.decision' BEGIN SELECT RAISE(ABORT,'test_failure'); END").run();
  try {await expect(decideApproval(f.context(),a.approval_id,review.digest,'approve')).rejects.toHaveProperty('code','storage_unavailable');}
  finally {await f.db.prepare('DROP TRIGGER fail_decision').run();}
  expect((await row(a.id)).status).toBe('pending');await approve(f,a);
  await f.db.prepare("CREATE TRIGGER fail_claim BEFORE INSERT ON audit_events WHEN NEW.operation='action.claim' BEGIN SELECT RAISE(ABORT,'test_failure'); END").run();
  const fetcher=vi.fn();try {await expect(executeAction(f.context(),a.id,fetcher)).rejects.toHaveProperty('code','storage_unavailable');}
  finally {await f.db.prepare('DROP TRIGGER fail_claim').run();}
  expect((await row(a.id)).status).toBe('ready');expect(fetcher).not.toHaveBeenCalled();
 });
 it('erases expired payloads across successive bounded sweeps without revisiting cleared rows',async()=>{
  const prefix='retention-'+key();
  // More than one sweep's limit. These terminal fixtures need no execution.
  await f.db.prepare(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<105)
   INSERT INTO actions(id,request_id,operation,target,digest,submission_digest,config_version,status,
    created_at,updated_at,expires_at,result_expires_at,input_cipher,input_nonce,key_version,result_cipher,result_nonce,result_key_version)
   SELECT ?||value,'retention-test','proxy.request','retention','digest','submission',1,'succeeded',0,0,1,1,
    'expired-cipher','nonce','1','expired-result','nonce','1' FROM n`).bind(prefix).run();
  await sweepActions(f.context());
  expect(await f.db.prepare('SELECT count(*) FROM actions WHERE id LIKE ? AND input_cipher IS NOT NULL').bind(prefix+'%').first('count(*)')).toBeGreaterThan(0);
  await sweepActions(f.context());
  expect(await f.db.prepare(`SELECT count(*) FROM actions WHERE id LIKE ? AND
   (input_cipher IS NOT NULL OR input_nonce IS NOT NULL OR key_version IS NOT NULL OR result_cipher IS NOT NULL OR result_nonce IS NOT NULL OR result_key_version IS NOT NULL)`)
   .bind(prefix+'%').first('count(*)')).toBe(0);
  expect(await f.db.prepare('SELECT count(*) FROM actions WHERE id LIKE ?').bind(prefix+'%').first('count(*)')).toBe(105);
 });
});
