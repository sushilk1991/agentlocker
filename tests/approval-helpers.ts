import { authenticate } from '../src/auth';
import { createAgent, issueToken, replaceGrants, setAgentStatus } from '../src/agents';
import { submitWrite } from '../src/file-actions';
import { bytes } from '../src/security';
import { saveSecret } from '../src/secrets';
import { reviewApproval, decideApproval } from '../src/approvals';
import { bearer, database } from './helpers';
export const key = () => crypto.randomUUID();
export const CANARY = 'provider-canary-NeverReturnThis-123';
export async function setupAgent(f: Awaited<ReturnType<typeof database>>,withSecret=true) {
 const owner=f.context(), a=await createAgent(owner,key()), t=await issueToken(owner,a.id,'approval-task');
 const secret=withSecret?await saveSecret(owner,{name:'key-'+key(),value:CANARY,hosts:['api.example.com'],injection_header:'Authorization',scheme:'bearer'}):null;
 await replaceGrants(owner,a.id,1,[{prefix:'/mine/',read:true,write:true,delete:true}],secret?[{secret_id:secret.id,read:true}]:[]);
 await setAgentStatus(owner,a.id,'enabled');
 const c=f.context(await authenticate(owner,bearer(t.token),false));
 return {owner,a,t,secret,c};
}
export const writeFile=(f:Awaited<ReturnType<typeof database>>,p='/mine/'+key())=>submitWrite(f.context(),p,bytes('original'),'text/plain',null,key());
export async function approve(f:Awaited<ReturnType<typeof database>>,a:{approval_id:any}) {
 const review=await reviewApproval(f.context(),a.approval_id);
 return decideApproval(f.context(),a.approval_id,review.digest,'approve');
}
export const requestFor=(secret:any,extra:Record<string,unknown>={})=>({secret:secret.name,url:'https://api.example.com/v1/send?a=1&b=2',method:'POST',headers:{'content-type':'text/plain'},body_text:'hello',...extra});
