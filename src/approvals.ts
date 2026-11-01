import { actionAccess, actionActor, actionInput, actionSummary, authoritySQL, verifyAction } from './action-records';
import { requireFolder, requireOwner, requireSecret } from './auth';
import { audit, auditStatement } from './audit';
import { DAY, executeFileAction } from './file-actions';
import { changedOne, storageError } from './file-transaction';
import { current, download, fileBytes, fileMetadata, listFiles, pageLimit } from './files';
import { executeProxy, finishAttempt } from './proxy';
import { listSecrets } from './secrets';
import { canonical, open, seal, unbase64 } from './security';
import { all, assert, Context, json, LockerError, NOW, one, opaqueId, Row, statement } from './types';

async function transition(c: Context,a: Row,status: 'expired'|'invalidated',code: string) {
 try {
  await c.env.DB.batch([
   statement(c,`UPDATE actions SET status=?,error_code=?,updated_at=${NOW},result_expires_at=${NOW}+? WHERE id=? AND status IN('pending','ready')`,status,code,DAY,a.id),
   ...changedOne(c),
   statement(c,`UPDATE approvals SET state=?,decided_at=${NOW},decision_request_id=? WHERE action_id=? AND state='pending'`,status,c.requestId,a.id),
   auditStatement(c,'approval.'+status,a.target,'deny',status,{actionId:a.id,approvalId:a.approval_id,reason:code}),
  ]);
 } catch(error) {
  if(!String(error).includes('file_commit_conflict'))storageError(error);
 }
}
export async function refreshAction(c: Context,id: string) {
 let a=await one(c,'SELECT * FROM actions WHERE id=?',id); assert(a,'not_found_or_not_allowed',404);
 if(['pending','ready'].includes(a.status)) {
  const check=await one(c,`SELECT expires_at<=${NOW} AS expired,(${authoritySQL}) AS valid FROM actions a WHERE id=?`,id);
  if(check?.expired)await transition(c,a,'expired','approval_expired');
  else if(!check?.valid)await transition(c,a,'invalidated','authority_changed');
  a=(await one(c,'SELECT * FROM actions WHERE id=?',id))!;
 }
 return a;
}
export async function getAction(c: Context,id: string) {
 const found=await one(c,'SELECT * FROM actions WHERE id=?',id); assert(found,'not_found_or_not_allowed',404);
 await actionAccess(c,found);
 const a=await refreshAction(c,id);
 await audit(c,'action.get',a.target,'allow','read',{actionId:id});
 const approval=a.approval_id?await one(c,'SELECT state,decided_at FROM approvals WHERE id=?',a.approval_id):null;
 const attempt=await one(c,'SELECT claimed_at,dispatch_started_at,completed_at,state,upstream_status FROM execution_attempts WHERE action_id=?',id);
 return {...actionSummary(a),approval,attempt};
}
export async function listApprovals(c: Context,state='pending',limit=50,after=0) {
 requireOwner(c); pageLimit(limit); assert(['pending','approved','denied','expired','invalidated','all'].includes(state),'invalid_state');
 assert(Number.isSafeInteger(after)&&after>=0,'invalid_cursor');
 const rows=await all(c,`SELECT p.id AS approval_id,p.state AS approval_state,a.id,a.operation,a.target,a.digest,a.status,a.created_at,a.expires_at,g.name AS agent_name,t.label AS token_label
  FROM approvals p JOIN actions a ON a.id=p.action_id LEFT JOIN agents g ON g.id=a.agent_id LEFT JOIN agent_tokens t ON t.id=a.token_id
  WHERE (?='all' OR p.state=?) ORDER BY a.created_at,a.id LIMIT ? OFFSET ?`,state,state,limit,after);
 await audit(c,'approvals.list','/','allow','listed'); return {approvals:rows};
}
async function approvalAction(c: Context,id: string) {
 requireOwner(c);
 const p=await one(c,'SELECT action_id FROM approvals WHERE id=?',id); assert(p,'not_found',404);
 return refreshAction(c,p.action_id);
}
async function verified(c: Context,a: Row) {
 try {return await verifyAction(c,a);}
 catch(error) {
  if(error instanceof LockerError && ['action_integrity_error','content_integrity_error','content_unavailable','revision_conflict','policy_changed','secret_changed','credential_revoked','not_found_or_not_allowed','encrypted_record_unavailable'].includes(error.code)) {
   await transition(c,a,'invalidated',error.code);
  }
  throw error;
 }
}
export async function reviewApproval(c: Context,id: string) {
 const a=await approvalAction(c,id);
 const input=['pending','ready'].includes(a.status)?(await verified(c,a)).input:await actionInput(c,a);
 const agent=await one(c,'SELECT name,description FROM agents WHERE id=?',a.agent_id);
 const token=await one(c,'SELECT label,expires_at FROM agent_tokens WHERE id=?',a.token_id);
 const scope=a.agent_id?{folders:await all(c,`SELECT prefix,read,write,"delete",expires_at FROM folder_grants WHERE agent_id=?`,a.agent_id),
  secrets:await all(c,'SELECT secret_id,expires_at FROM secret_grants WHERE agent_id=?',a.agent_id)}:null;
 await audit(c,'approval.review',a.target,'allow','read',{actionId:a.id,approvalId:id,metadata:{digest:a.digest}});
 return {...actionSummary(a),digest:a.digest,operation:a.operation,target:a.target,input,agent,token,scope};
}
export async function approvalContent(c: Context,id: string) {
 const a=await approvalAction(c,id), {input}=await verified(c,a);
 await audit(c,'approval.content',a.target,'allow','read',{actionId:a.id,approvalId:id});
 if(a.operation==='proxy.request')return new Response(unbase64(input.request.body_base64),{headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="request-body"'}});
 assert(a.operation.startsWith('file.'),'no_content',404);
 const revision=a.operation==='file.read'?input.revision:input.revision??input.expected_revision;
 assert(revision,'no_content',404); const {data,r}=await fileBytes(c,revision); return download(data,r);
}
export async function decideApproval(c: Context,id: string,digest: string,decision: 'approve'|'deny',reason='',batchId?: string) {
 requireOwner(c);
 assert(typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest),'invalid_digest');
 assert(decision==='approve'||decision==='deny','invalid_decision');
 assert(typeof reason==='string'&&reason.length<=1000&&!/[\p{Cc}]/u.test(reason),'invalid_reason');
 const a=await approvalAction(c,id);
 assert(a.status==='pending','decision_conflict',409); assert(a.digest===digest,'digest_conflict',409);
 await verified(c,a);
 try {
  await c.env.DB.batch([
   statement(c,`UPDATE actions AS a SET status=?,updated_at=${NOW},result_expires_at=CASE WHEN ?='deny' THEN ${NOW}+? ELSE NULL END
    WHERE id=? AND digest=? AND status='pending' AND expires_at>${NOW} AND ${authoritySQL}
    AND EXISTS(SELECT 1 FROM approvals p WHERE p.id=? AND p.action_id=a.id AND p.state='pending' AND p.expires_at>${NOW})`,decision==='approve'?'ready':'denied',decision,DAY,a.id,digest,id),
   ...changedOne(c),
   statement(c,`UPDATE approvals SET state=?,decided_at=${NOW},decision_request_id=?,reason=?,batch_id=? WHERE id=? AND state='pending'`,decision==='approve'?'approved':'denied',c.requestId,reason,batchId,id),
   ...changedOne(c),
   auditStatement(c,'approval.decision',a.target,decision,decision==='approve'?'ready':'denied',{actionId:a.id,approvalId:id,batchId,metadata:{digest,decision_request_id:c.requestId}}),
  ]);
 } catch(error) {
  if(String(error).includes('file_commit_conflict')||String(error).includes('action_expired')) {
   await refreshAction(c,a.id); throw new LockerError('decision_conflict',409);
  }
  storageError(error);
 }
 return actionSummary((await one(c,'SELECT * FROM actions WHERE id=?',a.id))!);
}
export async function batchDecision(c: Context,members: {id:string;digest:string}[],decision: 'approve'|'deny',reason='') {
 requireOwner(c);
 assert(Array.isArray(members)&&members.length>=1&&members.length<=20,'invalid_batch');
 assert(decision==='approve'||decision==='deny','invalid_decision');
 assert(members.every(m=>m&&typeof m.id==='string'&&typeof m.digest==='string'&&/^[a-f0-9]{64}$/.test(m.digest)&&Object.keys(m).every(k=>['id','digest'].includes(k)))&&new Set(members.map(m=>m.id)).size===members.length,'invalid_batch');
 const batchId=opaqueId(),results=[];
 for(const m of members) {
  try {results.push(await decideApproval(c,m.id,m.digest,decision,reason,batchId));}
  catch(error) {if(!(error instanceof LockerError))throw error; results.push({approval_id:m.id,error_code:error.code});}
 }
 return {batch_id:batchId,results};
}

export async function executeAction(c: Context,id: string,fetcher: typeof fetch=fetch) {
 // Executors are internal owner/system calls. An agent never chooses a claim.
 requireOwner(c);
 let a=await refreshAction(c,id); if(a.status!=='ready')return actionSummary(a);
 let checked;
 try {checked=await verified(c,a);} catch(error) {if(error instanceof LockerError)return actionSummary((await one(c,'SELECT * FROM actions WHERE id=?',id))!);throw error;}
 const claim=opaqueId();
 try {
  await c.env.DB.batch([
   statement(c,`UPDATE actions AS a SET status='executing',claim_id=?,updated_at=${NOW} WHERE id=? AND status='ready' AND expires_at>${NOW} AND ${authoritySQL}
    AND (approval_id IS NULL OR EXISTS(SELECT 1 FROM approvals p WHERE p.id=a.approval_id AND p.state='approved'))`,claim,id),
   ...changedOne(c),
   statement(c,`INSERT INTO execution_attempts(id,action_id,claimed_at,state) VALUES(?,?,${NOW},'claimed')`,claim,id),
   auditStatement(checked.execution,'action.claim',a.target,'allow','executing',{actionId:id,approvalId:a.approval_id,attemptId:claim}),
  ]);
 } catch(error) {
  if(String(error).includes('file_commit_conflict')||String(error).includes('action_expired'))return actionSummary(await refreshAction(c,id));
  storageError(error);
 }
 a={...a,status:'executing',claim_id:claim};
 try {
  if(a.operation==='proxy.request')await executeProxy(checked.execution,a,checked.input,fetcher);
  else if(['file.write','file.delete','file.restore'].includes(a.operation))await executeFileAction(c,id,claim);
  else await executeRead(checked.execution,a,checked.input);
 } catch {
  // A dispatch marker, even without an observed fetch, makes a send uncertain.
  const attempt=await one(c,'SELECT dispatch_started_at FROM execution_attempts WHERE id=?',claim);
  await finishAttempt(checked.execution,a,attempt?.dispatch_started_at!=null&&a.operation==='proxy.request'?'unknown':'failed','execution_unavailable').catch(()=>{});
 }
 return actionSummary((await one(c,'SELECT * FROM actions WHERE id=?',id))!);
}

async function executeRead(c: Context,a: Row,input: any) {
 let result: unknown;
 if(a.operation==='file.read') {
  const f=await current(c,a.target); assert(f&&f.current_revision_id===input.revision,'revision_conflict',409);
  await fileBytes(c,input.revision);
  result=input.parameters.metadata?fileMetadata(f):{revision:input.revision,hash:input.hash,length:input.length};
 } else if(a.operation==='secrets.list')result=await listSecrets(c);
 else {assert(a.operation==='files.list','invalid_operation');result=await listFiles(c,a.target,input.parameters.limit,input.parameters.cursor);}
 const encrypted=await seal(c.env,'action.result',a.id,1,canonical(result));
 await c.env.DB.batch([
  statement(c,`UPDATE actions AS a SET status='succeeded',result_cipher=?,result_nonce=?,result_key_version=?,result_metadata=?,updated_at=${NOW},result_expires_at=${NOW}+? WHERE id=? AND status='executing' AND claim_id=? AND ${authoritySQL}`,
   encrypted.cipher,encrypted.nonce,encrypted.keyVersion,JSON.stringify({kind:a.operation==='file.read'&&!input.parameters.metadata?'file':'json'}),DAY,a.id,a.claim_id),
  ...changedOne(c),
  statement(c,`UPDATE execution_attempts SET state='succeeded',completed_at=${NOW} WHERE id=? AND state='claimed'`,a.claim_id),
  auditStatement(c,'action.result',a.target,'allow','succeeded',{actionId:a.id,attemptId:a.claim_id}),
 ]);
}
export async function actionResult(c: Context,id: string) {
 const a=await one(c,'SELECT * FROM actions WHERE id=?',id); assert(a,'not_found_or_not_allowed',404); await actionAccess(c,a);
 assert(a.status==='succeeded','result_not_ready',409);
 if(c.actor.kind!=='owner'&&['files.list','secrets.list'].includes(a.operation))assert(await one(c,'SELECT 1 FROM settings WHERE id=1 AND config_version=?',a.config_version),'not_found_or_not_allowed',404);
 assert(await one(c,`SELECT 1 FROM actions WHERE id=? AND result_expires_at>${NOW}`,id),'result_expired',410);
 await audit(c,'action.result.read',a.target,'allow','intent',{actionId:id});
 let response: Response;
 if(a.operation==='file.read'&&JSON.parse(a.result_metadata).kind==='file') {
  const {data,r}=await fileBytes(c,a.result_revision); response=download(data,r);
 } else if(a.result_cipher) {
  const result=JSON.parse(await open(c.env,'action.result',id,1,a.result_cipher,a.result_nonce,a.result_key_version));
  if(c.actor.kind!=='owner') {
   if(a.operation==='files.list')for(const file of result.files)await requireFolder(c,file.path,'read');
   if(a.operation==='secrets.list')for(const secret of result.secrets)await requireSecret(c,secret.name);
  }
  response=json(result);
 }
 else response=json(JSON.parse(a.result_metadata));
 await actionAccess(c,a); await audit(c,'action.result.read',a.target,'allow','read',{actionId:id}); return response;
}
export async function sweepActions(c: Context,fetcher: typeof fetch=fetch) {
 requireOwner(c);
 // Reconciliation is terminal. In particular, abandoned sends are never leased
 // again. A late completion cannot pass its conditional final write.
 const abandoned=await all(c,`SELECT * FROM actions WHERE status='executing' AND updated_at<=${NOW}-60000 ORDER BY updated_at LIMIT 20`);
 for(const a of abandoned)await finishAttempt(await actionActor(c,a),a,a.operation==='proxy.request'?'unknown':'failed','execution_interrupted').catch(()=>{});
 const candidates=await all(c,`SELECT id FROM actions WHERE status IN('pending','ready') ORDER BY created_at LIMIT 100`);
 let executed=0;
 for(const item of candidates) {
  const a=await refreshAction(c,item.id);
  if(a.status==='ready'&&executed++<10)await executeAction(c,a.id,fetcher);
 }
 await c.env.DB.batch([
  statement(c,`UPDATE actions SET input_cipher=NULL,input_nonce=NULL,key_version=NULL,result_cipher=NULL,result_nonce=NULL,result_key_version=NULL WHERE id IN(SELECT id FROM actions WHERE status NOT IN('pending','ready','executing') AND result_expires_at<=${NOW} LIMIT 100)`),
  statement(c,`DELETE FROM idempotency_keys WHERE rowid IN(SELECT rowid FROM idempotency_keys WHERE expires_at<=${NOW} LIMIT 100)`),
 ]);
}
