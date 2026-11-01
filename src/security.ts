import { assert, Env, LIMITS, LockerError } from './types';
const encoder = new TextEncoder();
export const bytes = (s: string) => encoder.encode(s);
export function base64(data: Uint8Array): string { let s=''; for(let i=0;i<data.length;i+=8192) s+=String.fromCharCode(...data.subarray(i,i+8192)); return btoa(s); }
export function unbase64(s: string): Uint8Array<ArrayBuffer> { try { assert(/^[A-Za-z0-9+/]*={0,2}$/.test(s),'invalid_base64'); return Uint8Array.from(atob(s),c=>c.charCodeAt(0)); } catch { throw new LockerError('invalid_base64'); } }
export async function sha(data: string | Uint8Array) { const h=await crypto.subtle.digest('SHA-256',typeof data==='string'?bytes(data):data as Uint8Array<ArrayBuffer>); return Array.from(new Uint8Array(h),b=>b.toString(16).padStart(2,'0')).join(''); }
export function canonical(value: unknown): string {
 if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
 if(value!==null && typeof value==='object') return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
export async function equalToken(a: string,b: string) { const x=await sha(a),y=await sha(b); let diff=0; for(let i=0;i<64;i++) diff|=x.charCodeAt(i)^y.charCodeAt(i); return diff===0; }
export function path(input: string, folder=false): string {
 assert(typeof input==='string' && input.startsWith('/') && input===input.normalize('NFC') && bytes(input).length<=1024,'invalid_path');
 assert(!/[\\%?#\p{Cc}\p{Cs}]/u.test(input) && !input.includes('//'),'invalid_path');
 assert(folder ? input==='/' || input.endsWith('/') : input!=='/' && !input.endsWith('/'),'invalid_path');
 for(const segment of input.split('/').filter(Boolean)) assert(segment!=='.' && segment!=='..' && bytes(segment).length<=255,'invalid_path');
 return input;
}
export const matches = (prefix: string,target: string) => (prefix==='/' || prefix.startsWith('/')&&prefix.endsWith('/')) && target.startsWith(prefix);
export function host(input: string): string {
 assert(typeof input==='string' && input.length<=253 && !/[\s/:@#?*%]/.test(input),'invalid_host');
 let h: string; try { h=new URL('https://'+input).hostname.toLowerCase(); } catch { throw new LockerError('invalid_host'); }
 assert(h.includes('.') && /^[a-z0-9.-]+$/.test(h) && !h.endsWith('.') && !/^\d+(\.\d+)*$/.test(h),'invalid_host');
 assert(!/(^|\.)(localhost|local|internal|lan|home|test|invalid|onion)$/.test(h),'invalid_host');
 assert(h.split('.').every(x=>x.length>0 && x.length<=63 && !x.startsWith('-')&&!x.endsWith('-')),'invalid_host');
 return h;
}
const forbidden=/^(authorization|proxy-authorization|cookie|cookie2|host|connection|keep-alive|transfer-encoding|te|trailer|upgrade|expect|content-length|accept-encoding|via|forwarded|x-forwarded-.*|cf-.*|sec-.*|proxy-.*)$/i;
export function injection(header: string,scheme: string) {
 assert(scheme==='bearer'||scheme==='plain','invalid_injection');
 assert(scheme==='bearer'?header.toLowerCase()==='authorization': /^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(header)&&!forbidden.test(header)&&!/^content-/i.test(header),'invalid_injection');
 return header.toLowerCase();
}
export function secretValue(value: string) { assert(typeof value==='string' && value.length>0 && bytes(value).length<=LIMITS.secret && /^[\x20-\x7e]+$/.test(value),'invalid_secret'); return value; }
export function proxyInput(input: any, secret: any, hosts: string[], origin: string) {
 let url: URL; try {url=new URL(input.url);} catch {throw new LockerError('invalid_url');}
 assert(url.protocol==='https:' && !url.username&&!url.password&&!url.hash && (!url.port||url.port==='443'),'invalid_url');
 const h=host(url.hostname); assert(hosts.includes(h)&&url.origin!==origin,'not_found_or_not_allowed',404);
 const method=input.method; assert(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(method),'invalid_method');
 const headers: Record<string,string>={}; let size=0;
 for(const [k,v] of Object.entries(input.headers||{})) {
  assert(typeof v==='string' && /^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(k) && !forbidden.test(k) && k.toLowerCase()!==secret.injection_header && !/[\r\n\0]/.test(v),'invalid_header');
  assert(!Object.hasOwn(headers,k.toLowerCase()),'duplicate_header'); headers[k.toLowerCase()]=v; size+=bytes(k+': '+v+'\r\n').length;
 }
 assert(size<=LIMITS.headers,'too_large',413);
 const body=input.body_base64!==undefined?unbase64(input.body_base64):bytes(input.body_text??'');
 assert(!(input.body_base64!==undefined&&input.body_text!==undefined),'ambiguous_content');
 assert(body.length<=LIMITS.proxyBody,'too_large',413);
 assert(!['GET','HEAD'].includes(method)||body.length===0,'body_not_allowed');
 return {url:url.href, method, headers:Object.fromEntries(Object.entries(headers).sort()), body_base64:base64(body), body_hash:'', hostname:h};
}
function key(env: Env, version: string) {
 let encoded: string|undefined;
 if(version===env.ENCRYPTION_KEY_VERSION) encoded=env.LOCKER_ENCRYPTION_KEY;
 else if(version===env.PREVIOUS_KEY_VERSION) encoded=env.PREVIOUS_ENCRYPTION_KEY;
 assert(encoded,'missing_encryption_key',503); const raw=unbase64(encoded); assert(raw.length===32,'invalid_encryption_key',503); return raw;
}
export async function seal(env: Env,type: string,id: string,version: number,value: string) {
 const keyVersion=env.ENCRYPTION_KEY_VERSION, nonce=crypto.getRandomValues(new Uint8Array(12));
 const k=await crypto.subtle.importKey('raw',key(env,keyVersion),'AES-GCM',false,['encrypt']);
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:bytes(canonical([env.DEPLOYMENT_ID,type,id,version,keyVersion]))},k,bytes(value));
 return {cipher:base64(new Uint8Array(ciphertext)),nonce:base64(nonce),keyVersion};
}
export async function open(env: Env,type: string,id: string,version: number,cipher: string,nonce: string,keyVersion: string) {
 try { const k=await crypto.subtle.importKey('raw',key(env,keyVersion),'AES-GCM',false,['decrypt']);
 return new TextDecoder('utf-8',{fatal:true}).decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unbase64(nonce),additionalData:bytes(canonical([env.DEPLOYMENT_ID,type,id,version,keyVersion]))},k,unbase64(cipher))); }
 catch {throw new LockerError('encrypted_record_unavailable',503);}
}
export function validateConfig(env: Env) {
 assert(env.DB&&env.FILES&&env.OWNER_TOKEN?.length>=43&&env.DEPLOYMENT_ID?.length>=16,'not_configured',503);
 key(env,env.ENCRYPTION_KEY_VERSION);
 let url: URL; try{url=new URL(env.PUBLIC_ORIGIN);}catch{throw new LockerError('not_configured',503);}
 assert(url.origin===env.PUBLIC_ORIGIN&&(url.protocol==='https:'||['localhost','127.0.0.1'].includes(url.hostname)),'not_configured',503);
}
export async function bounded(stream: ReadableStream<Uint8Array>|null,limit: number): Promise<Uint8Array> {
 if(!stream)return new Uint8Array(); const reader=stream.getReader(),chunks:Uint8Array[]=[]; let length=0;
 try {while(true){const {value,done}=await reader.read();if(done)break; length+=value.length; if(length>limit){await reader.cancel();throw new LockerError('too_large',413);}chunks.push(value);}}
 finally{reader.releaseLock();} const result=new Uint8Array(length);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
export function redact(data: Uint8Array,secret: string): Uint8Array {
 const needle=bytes(secret), replacement=bytes('[REDACTED]'), out:number[]=[];
 for(let i=0;i<data.length;){if(data[i]===needle[0]&&needle.every((b,j)=>data[i+j]===b)){out.push(...replacement);i+=needle.length;}else out.push(data[i++]);}return new Uint8Array(out);
}
export function safeResponseHeaders(headers: Headers,secret: string) {
 const out:Record<string,string>={};for(const [k,v] of headers) if(!forbidden.test(k)&&k!=='set-cookie'&&k!=='www-authenticate')out[k]=v.split(secret).join('[REDACTED]');return out;
}
export const csvCell = (v: unknown) => '"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
