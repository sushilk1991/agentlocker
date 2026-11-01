import { audit, auditStatement } from './audit';
import { actionSummary, authoritySQL } from './action-records';
import { DAY, idempotencyKey } from './file-actions';
import { changedOne, storageError } from './file-transaction';
import { base64, bounded, canonical, open, proxyInput, redact, safeResponseHeaders, seal, secretValue, sha, unbase64 } from './security';
import { secretHosts, selectedSecret } from './secrets';
import { assert, Context, LIMITS, NOW, one, opaqueId, Row, settings, statement } from './types';

export async function submitProxy(c: Context, request: any, key: string) {
 const secret=await selectedSecret(c,request?.secret); idempotencyKey(key);
 // Owner sends also go through review; the owner decision is explicit authority.
 const normalized=proxyInput(request,secret,await secretHosts(c,secret.id),c.env.PUBLIC_ORIGIN);
 normalized.body_hash=await sha(unbase64(normalized.body_base64));
 const submission=await sha(canonical({secret:secret.name,...normalized})), identity=c.actor.kind==='owner'?'owner':`agent:${c.actor.agentId}`;
 const replay=async()=>{
  const old=await one(c,`SELECT k.input_digest,a.* FROM idempotency_keys k JOIN actions a ON a.id=k.action_id WHERE k.identity=? AND k.caller_key=? AND k.expires_at>${NOW}`,identity,key);
  if(!old)return null; assert(old.input_digest===submission,'idempotency_conflict',409);
  await audit(c,'proxy.request',secret.id,'allow','replayed',{actionId:old.id}); return actionSummary(old);
 };
 const old=await replay(); if(old)return old;
 const s=await settings(c); assert(s.setup_complete&&!s.maintenance,'maintenance',503);
 const id=opaqueId(), approval=opaqueId();
 const input={operation:'proxy.request',target:secret.id,secret:secret.name,value_version:secret.value_version,
  injection_header:secret.injection_header,scheme:secret.scheme,request:normalized};
 const digest=await sha(canonical({input,config_version:s.config_version,agent_id:c.actor.agentId??null,token_id:c.actor.tokenId??null}));
 const encrypted=await seal(c.env,'action.input',id,1,canonical(input));
 try {
  await c.env.DB.batch([
   statement(c,`DELETE FROM idempotency_keys WHERE identity=? AND caller_key=? AND expires_at<=${NOW}`,identity,key),
   statement(c,`INSERT INTO idempotency_keys VALUES(?,?,?,?,${NOW},${NOW}+?)`,identity,key,submission,id,7*DAY),
   statement(c,`INSERT INTO actions(id,agent_id,token_id,request_id,operation,target,digest,submission_digest,input_cipher,input_nonce,key_version,config_version,secret_id,secret_version,status,approval_id,created_at,updated_at,expires_at)
    SELECT ?,?,?,?,'proxy.request',?,?,?,?,?,?,?,?,?,'pending',?,${NOW},${NOW},${NOW}+? FROM settings WHERE id=1 AND setup_complete=1 AND maintenance=0 AND config_version=?`,
    id,c.actor.agentId,c.actor.tokenId,c.requestId,secret.id,digest,submission,encrypted.cipher,encrypted.nonce,encrypted.keyVersion,s.config_version,secret.id,secret.version,approval,s.approval_ttl,s.config_version),
   ...changedOne(c),
   statement(c,`INSERT INTO approvals(id,action_id,state,created_at,expires_at) SELECT ?,id,'pending',created_at,expires_at FROM actions WHERE id=?`,approval,id),
   auditStatement(c,'proxy.request',secret.id,'pending','accepted',{actionId:id,approvalId:approval,metadata:{digest,method:normalized.method,hostname:normalized.hostname,secret_id:secret.id,secret_version:secret.value_version}}),
  ]);
 } catch(error) {const winner=await replay(); if(winner)return winner; storageError(error);}
 return actionSummary((await one(c,'SELECT * FROM actions WHERE id=?',id))!);
}

// A dispatch marker is committed before fetch. No code retries this attempt.
export async function executeProxy(c: Context,a: Row,input: any,fetcher: typeof fetch=fetch) {
 const secret=await selectedSecret(c,input.secret);
 const value=secretValue(await open(c.env,'secret.value',secret.id,secret.value_version,secret.encrypted_value,secret.nonce,secret.key_version));
 const headers=new Headers(input.request.headers);
 headers.set(secret.injection_header,(secret.scheme==='bearer'?'Bearer ':'')+value);
 headers.set('accept-encoding','identity');
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),20000);
 try {
  await c.env.DB.batch([
   statement(c,`UPDATE execution_attempts SET state='dispatched',dispatch_started_at=${NOW} WHERE id=? AND state='claimed'
    AND EXISTS(SELECT 1 FROM actions a WHERE a.id=execution_attempts.action_id AND a.status='executing' AND a.claim_id=execution_attempts.id AND a.expires_at>${NOW} AND ${authoritySQL})`,a.claim_id),
   ...changedOne(c),
   auditStatement(c,'proxy.dispatch',a.target,'allow','dispatched',{actionId:a.id,attemptId:a.claim_id,metadata:{method:input.request.method,hostname:input.request.hostname}}),
  ]);
  let response: Response|undefined;
  try {
   const request=input.request;
   response=await fetcher(request.url,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:unbase64(request.body_base64),redirect:'manual',signal:controller.signal});
   const body=redact(await bounded(response.body,LIMITS.response),value);
   assert(body.length<=LIMITS.response,'too_large',413);
   const responseHeaders=safeResponseHeaders(response.headers,value);
   delete responseHeaders[secret.injection_header]; delete responseHeaders['content-length']; delete responseHeaders['content-encoding'];
   const result={upstream_status:response.status,headers:responseHeaders,body_base64:base64(body)};
   const encrypted=await seal(c.env,'action.result',a.id,1,canonical(result));
   await c.env.DB.batch([
    statement(c,`UPDATE actions SET status='succeeded',result_cipher=?,result_nonce=?,result_key_version=?,result_metadata=?,updated_at=${NOW},result_expires_at=${NOW}+?
     WHERE id=? AND status='executing' AND claim_id=?`,encrypted.cipher,encrypted.nonce,encrypted.keyVersion,JSON.stringify({upstream_status:response.status,length:body.length}),DAY,a.id,a.claim_id),
    ...changedOne(c),
    statement(c,`UPDATE execution_attempts SET state='succeeded',completed_at=${NOW},upstream_status=? WHERE id=? AND state='dispatched'`,response.status,a.claim_id),
    auditStatement(c,'proxy.result',a.target,'allow','succeeded',{actionId:a.id,attemptId:a.claim_id,metadata:{upstream_status:response.status,length:body.length}}),
   ]);
  } catch {
   // Includes result persistence failures. A later sweep can reconcile if D1 is
   // unavailable here. Never include an upstream exception or body in an error.
   await finishAttempt(c,a,'unknown','upstream_outcome_unknown',response?.status).catch(()=>{});
  }
 } finally {clearTimeout(timer);controller.abort();}
}
export async function finishAttempt(c: Context,a: Row,state: 'unknown'|'failed',code: string,upstreamStatus?: number) {
 await c.env.DB.batch([
  statement(c,`UPDATE actions SET status=?,error_code=?,result_metadata=?,updated_at=${NOW},result_expires_at=${NOW}+? WHERE id=? AND status='executing' AND claim_id=?`,state,code,upstreamStatus?JSON.stringify({upstream_status:upstreamStatus}):null,DAY,a.id,a.claim_id),
  ...changedOne(c),
  statement(c,`UPDATE execution_attempts SET state=?,error_code=?,completed_at=${NOW},upstream_status=? WHERE id=? AND state IN('claimed','dispatched')`,state,code,upstreamStatus,a.claim_id),
  auditStatement(c,'action.result',a.target,'deny',state,{actionId:a.id,attemptId:a.claim_id,reason:code}),
 ]);
}
