import html from '../public/index.html';
import css from '../public/style.css';
import script from '../public/app.js';
import { Env } from './types';

const legacy: Record<string, [string, string]> = {
 '/legacy': [html, 'text/html; charset=utf-8'],
 '/app.js': [script, 'text/javascript; charset=utf-8'],
 '/style.css': [css, 'text/css; charset=utf-8'],
};
const pages = new Set(['/', '/approvals', '/agents', '/files', '/secrets', '/policy', '/audit', '/settings']);
export async function staticAsset(request: Request, env: Env) {
 const url = new URL(request.url), asset = legacy[url.pathname];
 // Only known app paths fall back to HTML. API, MCP, health and unknown routes
 // always remain Worker routes, including requests with browser Accept headers.
 if (!asset && !pages.has(url.pathname) && !url.pathname.startsWith('/assets/')) return null;
 const nonce = btoa(crypto.randomUUID());
 const headers = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
 };
 if (url.origin !== env.PUBLIC_ORIGIN) return new Response('Unexpected origin', {status: 403, headers});
 if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', {status: 405, headers: {...headers, allow: 'GET, HEAD'}});
 if (asset) return new Response(request.method === 'HEAD' ? null : asset[0], {headers: {...headers, 'content-type': asset[1]}});
 if (!env.ASSETS) return new Response('Web assets unavailable', {status: 503, headers});
 const target = new URL(pages.has(url.pathname) ? '/index.html' : url.pathname, url.origin);
 const response = await env.ASSETS.fetch(new Request(target, {method: request.method}));
 const isHtml = response.headers.get('content-type')?.includes('text/html');
 const body = isHtml && request.method !== 'HEAD'
  ? (await response.text()).replace('<head>', `<head><meta name="csp-nonce" content="${nonce}">`)
  : response.body;
 const secured = new Response(body, response);
 for (const [key, value] of Object.entries(headers)) secured.headers.set(key, value);
 return secured;
}
