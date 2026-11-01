import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerApi } from '../web/src/lib/api';
import { canonical, visibleText } from '../web/src/lib/review';
import { canonical as serverCanonical } from '../src/security';

afterEach(() => {vi.unstubAllGlobals();});
describe('owner browser client security', () => {
 it('keeps the same idempotency key and exact payload after a failed decision without replaying it', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({error:{message:'Unavailable'},request_id:'test-request'}, {status:503}))
   .mockResolvedValue(Response.json({results:[]}));
  vi.stubGlobal('fetch', fetcher);
  const api = new OwnerApi('disposable-test-token', () => {}), members = [{id:'approval',digest:'a'.repeat(64)}];
  await expect(api.decide(members,'approve','Reviewed')).rejects.toThrow('test-request');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await api.decide(members,'approve','Reviewed');
  const first = fetcher.mock.calls[0][1], second = fetcher.mock.calls[1][1];
  expect(first.body === second.body).toBe(true);
  expect(first.headers['idempotency-key'] === second.headers['idempotency-key']).toBe(true);
  expect(first.redirect).toBe('error');expect(first.cache).toBe('no-store');api.dispose();
 });
 it('aborts all outstanding requests and refuses a response received after sign-out', async () => {
  let release!: (response: Response) => void;
  const fetcher=vi.fn().mockImplementation(()=>new Promise<Response>(resolve=>{release=resolve;}));vi.stubGlobal('fetch',fetcher);
  const api=new OwnerApi('disposable-test-token',()=>{}), request=api.session();
  api.dispose();expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  release(Response.json({setup_complete:true}));await expect(request).rejects.toMatchObject({name:'AbortError'});
 });
 it('ends the session on a non-JSON 401 and returns a useful typed error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unauthorized', {status:401})));
  const ended=vi.fn(), api=new OwnerApi('disposable-test-token', ended);
  await expect(api.session()).rejects.toMatchObject({name:'ApiError',status:401,message:'Request failed (401)'});
  expect(ended).toHaveBeenCalledOnce();api.dispose();
 });
 it('keeps the server error code and request ID for a failed owner request', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({error:{code:'version_conflict',message:'Reload and review again'},request_id:'test-conflict'}, {status:409})));
  const api=new OwnerApi('disposable-test-token',()=>{});
  await expect(api.session()).rejects.toMatchObject({name:'ApiError',status:409,code:'version_conflict',requestId:'test-conflict',message:'Reload and review again · Request test-conflict'});
  api.dispose();
 });
 it('uses the server canonical encoding without letting control and direction markers alter text', () => {
  const input={input:{headers:{z:'<script>text</script>',a:'\u001b\u202e'},bytes:42,options:[true,null,{},'😀'],omitted:undefined},config_version:1,agent_id:'agent',token_id:'task'};
  expect(canonical(input)).toBe(serverCanonical(input));
  expect(visibleText('\u001b\u202e\u2066\u0000')).toBe('\\u001b\\u202e\\u2066\\u0000');
 });
});
