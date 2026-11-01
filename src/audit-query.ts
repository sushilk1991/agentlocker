import { requireOwner } from './auth';
import { audit } from './audit';
import { csvCell, path } from './security';
import { all, assert, Context, Row } from './types';

const columns=['id','timestamp','request_id','action_id','approval_id','attempt_id','batch_id','actor_kind','agent_id','token_id','actor_name','operation','target','decision','result','http_status','reason_code','metadata'];
const keys=['from','to','agent_id','token_id','operation','path','prefix','secret','host','decision','outcome','request_id','action_id','cursor','limit','include_routine'];
export function auditFilter(params: URLSearchParams, exporting=false) {
 for(const k of params.keys())assert((keys.includes(k)||(exporting&&k==='format'))&&params.getAll(k).length===1,'invalid_query');
 const clauses:string[]=[],args:(string|number)[]=[];
 const number=(k:string,fallback:number)=>{const value=params.get(k);assert(value===null||/^\d+$/.test(value),'invalid_query');const n=value===null?fallback:Number(value);assert(Number.isSafeInteger(n)&&n>=0,'invalid_query');return n;};
 const limit=number('limit',50);assert(limit>=1&&limit<=100,'invalid_limit');
 const cursor=number('cursor',0);
 if(cursor){clauses.push('id<?');args.push(cursor);}
 for(const [key,op] of [['from','>='],['to','<=']] as const)if(params.has(key)){clauses.push('timestamp'+op+'?');args.push(number(key,0));}
 assert(!params.has('from')||!params.has('to')||number('from',0)<=number('to',0),'invalid_time_range');
 for(const [key,column] of Object.entries({agent_id:'agent_id',token_id:'token_id',operation:'operation',decision:'decision',outcome:'result',request_id:'request_id',action_id:'action_id',path:'target'})) {
  const value=params.get(key);if(value!==null){assert(value.length>0&&value.length<=1024,'invalid_query');if(key==='path')path(value);clauses.push(column+'=?');args.push(value);}
 }
 const prefix=params.get('prefix');if(prefix!==null){path(prefix,true);clauses.push('substr(target,1,length(?))=?');args.push(prefix,prefix);}
 for(const [key,jsonKey] of [['secret','secret_name'],['host','hostname']]) {
  const value=params.get(key);if(value!==null){assert(value.length>0&&value.length<=256,'invalid_query');clauses.push(`json_extract(metadata,'$.${jsonKey}')=?`);args.push(value);}
 }
 const routine=params.get('include_routine');assert(routine===null||routine==='true'||routine==='false','invalid_query');
 if(routine==='false')clauses.push("operation NOT IN('action.get','owner.overview','owner.session','files.usage','agents.list','grants.read','approvals.list','approval.review','audit.list')");
 return {where:clauses.length?' WHERE '+clauses.join(' AND '):'',args,limit};
}
export async function readAudit(c: Context,params: URLSearchParams) {
 requireOwner(c);const {where,args,limit}=auditFilter(params);
 await audit(c,'audit.list','/','allow','read');
 const events=await all(c,'SELECT * FROM audit_events'+where+' ORDER BY id DESC LIMIT ?',...args,limit+1);
 const more=events.length>limit; if(more)events.pop();
 return {events,next_cursor:more?events.at(-1)!.id:null};
}
export async function exportAudit(c: Context,params: URLSearchParams) {
 requireOwner(c);const {where,args}=auditFilter(params,true),format=params.get('format')??'jsonl';
 assert(format==='jsonl'||format==='csv','invalid_format');
 await audit(c,'audit.export','/','allow','exported');
 const high=(await all(c,'SELECT COALESCE(MAX(id),0) AS id FROM audit_events'))[0].id;
 let cursor=high+1,started=false;
 // Fetch bounded pages when the consumer asks for more. A fixed high-water mark
 // keeps activity arriving during export out of this download.
 const stream=new ReadableStream<Uint8Array>({async pull(controller){
  try {
   const rows=await all(c,'SELECT * FROM audit_events'+(where?where+' AND ':' WHERE ')+'id<? ORDER BY id DESC LIMIT 100',...args,cursor);
   const lines:string[]=[];
   if(!started&&format==='csv')lines.push(columns.join(',')+'\r\n');started=true;
   for(const row of rows)lines.push(format==='jsonl'?JSON.stringify(row)+'\n':columns.map(k=>csvCell((row as Row)[k])).join(',')+'\r\n');
   controller.enqueue(new TextEncoder().encode(lines.join('')));
   if(rows.length<100)controller.close();else cursor=rows.at(-1)!.id;
  }catch{controller.error(new Error('Export interrupted. Try again.'));}
 }});
 return new Response(stream,{headers:{'content-type':format==='csv'?'text/csv; charset=utf-8':'application/x-ndjson','content-disposition':`attachment; filename="agent-locker-audit.${format}"`}});
}
