import html from '../public/index.html';
import css from '../public/style.css';
import script from '../public/app.js';
import { Env } from './types';
const assets:Record<string,[string,string]>={'/':[html,'text/html; charset=utf-8'],'/app.js':[script,'text/javascript; charset=utf-8'],'/style.css':[css,'text/css; charset=utf-8']};
export function staticAsset(request: Request,env: Env) {
 const url=new URL(request.url),asset=assets[url.pathname];if(!asset)return null;
 const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
  'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"};
 if(url.origin!==env.PUBLIC_ORIGIN)return new Response('Unexpected origin',{status:403,headers});
 if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers:{...headers,allow:'GET, HEAD'}});
 return new Response(request.method==='HEAD'?null:asset[0],{headers:{...headers,'content-type':asset[1]}});
}
