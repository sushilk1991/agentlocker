import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import { OwnerApi, type Session } from './lib/api';
import { SessionContext } from './lib/session';
import { ThemeToggle } from './lib/theme';
import { visibleText } from './lib/review';
import { Button } from './components/ui/button';
import { Skeleton } from './components/ui/skeleton';
import { ShieldCheck } from 'lucide-react';
const Shell = lazy(() => import('./components/shell'));
const Approvals = lazy(() => import('./routes/approvals'));
const Agents = lazy(() => import('./routes/agents'));
const Files = lazy(() => import('./routes/files'));
const Keys = lazy(() => import('./routes/keys'));
const Audit = lazy(() => import('./routes/audit'));
const Settings = lazy(() => import('./routes/settings'));
const Policy = lazy(() => import('./routes/policy'));

function Workspace() {
 const [queryClient] = useState(() => new QueryClient({defaultOptions: {queries: {retry: false, refetchOnWindowFocus: false}, mutations: {retry: false}}}));
 const [session, setSession] = useState<{api: OwnerApi; data: Session} | null>(null);
 const apiRef = useRef<OwnerApi | null>(null), generation = useRef(0);
 const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
 const navigate = useNavigate();
 const signOut = () => {
  generation.current++; apiRef.current?.dispose(); apiRef.current = null;
  void queryClient.cancelQueries(); queryClient.clear(); toast.dismiss();
  setSession(null); setNotice(''); setBusy(false); navigate('/', {replace: true});
 };
 useEffect(() => {
  const leave = () => signOut();
  window.addEventListener('pagehide', leave);
  return () => {window.removeEventListener('pagehide', leave); apiRef.current?.dispose(); queryClient.clear();};
 }, [queryClient]);
 async function signIn(event: FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (busy) return;
  const form = event.currentTarget, input = form.elements.namedItem('token') as HTMLInputElement;
  let authenticated = false;
  const api = new OwnerApi(input.value, () => {if (authenticated) signOut();}); input.value = ''; apiRef.current?.dispose(); apiRef.current = api;
  const current = ++generation.current; setBusy(true); setNotice('');
  try {const data = await api.session(); if (current === generation.current) {authenticated = true; setSession({api, data});}}
  catch (error) {if (current === generation.current) {api.dispose(); apiRef.current = null; setNotice(error instanceof Error ? visibleText(error.message) : 'Sign-in failed.');}}
  finally {if (current === generation.current) setBusy(false);}
 }
 return <QueryClientProvider client={queryClient}>
  {!session ? <div className="auth-layout"><div className="auth-top"><Brand /><ThemeToggle /></div><main id="main" className="auth-card">
   <span className="eyebrow">OWNER WORKSPACE</span><h1>Sign in to your locker</h1><p>Review your agents’ requests and stay in control of what happens next.</p>
   <form onSubmit={signIn}><label htmlFor="owner-token">Owner token</label><input id="owner-token" name="token" type="password" autoComplete="off" required spellCheck={false} autoFocus />
    <p className="hint">Use the token saved during deployment. It stays in this tab’s memory. Reloading signs you out.</p><Button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button></form>
   <p id="notice" role="status" className={notice ? "warning" : undefined}>{notice}</p><details><summary>First time here?</summary><p>Set OWNER_TOKEN and a separate LOCKER_ENCRYPTION_KEY as Worker secrets. Keep your owner token in a password manager and an offline copy of your encryption key and its version.</p><p>Replace a lost owner token through Cloudflare or Wrangler.</p></details>
  </main></div> : <SessionContext.Provider value={{api: session.api, signOut}}>
   {!session.data.setup_complete ? <Setup session={session.data} api={session.api} onDone={() => setSession({...session, data: {...session.data, setup_complete: true}})} signOut={signOut} /> :
    <Suspense fallback={<main className="page"><Skeleton /></main>}><Routes><Route element={<Shell />}>
     <Route index element={<Navigate to="/approvals" replace />} /><Route path="approvals" element={<Approvals />} />
     <Route path="agents" element={<Agents />} />
     <Route path="files" element={<Files />} /><Route path="secrets" element={<Keys />} />
     <Route path="audit" element={<Audit />} /><Route path="settings" element={<Settings />} /><Route path="policy" element={<Policy />} />
     <Route path="*" element={<Navigate to="/approvals" replace />} />
    </Route></Routes></Suspense>}
  </SessionContext.Provider>}
  <Toaster key={session ? 'private' : 'public'} position="bottom-right" toastOptions={{unstyled: true}} />
 </QueryClientProvider>;
}
function Setup({session, api, onDone, signOut}: {session: Session; api: OwnerApi; onDone: () => void; signOut: () => void}) {
 const [busy, setBusy] = useState(false), [error, setError] = useState('');
 async function submit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault(); const values = new FormData(event.currentTarget); setBusy(true);
  try {await api.setup({approval_ttl: Number(values.get('expiry')) * 60000, quota_bytes: session.quota_bytes, retention_ms: session.retention_ms}); onDone();}
  catch (error) {if (!apiIsAborted(error)) setError(visibleText(error instanceof Error ? error.message : 'Setup failed.'));}
  finally {setBusy(false);}
 }
 return <main className="auth-card"><Brand /><h1>Set up your locker</h1><p>Your URL: {visibleText(session.public_origin)}</p><p>Approvals wait here. Requests expire if nobody opens the app.</p>
  <form onSubmit={submit}><label htmlFor="expiry">Approval expiry in minutes</label><input id="expiry" name="expiry" type="number" min="1" max="60" required defaultValue={session.approval_ttl / 60000} />
   <p>File quota: {session.quota_bytes.toLocaleString()} bytes. File history: {session.retention_ms / 86400000} days. Audit history is kept indefinitely.</p>
   <label className="check"><input type="checkbox" required />I saved my owner token and an offline copy of my encryption key.</label><Button disabled={busy}>Confirm and finish setup</Button></form>
  <p role="status">{error}</p><Button variant="ghost" onClick={signOut}>Sign out</Button>
 </main>;
}
export function apiIsAborted(error: unknown) { return error instanceof DOMException && error.name === 'AbortError'; }
export function Brand() {return <div className="brand"><span className="brand-mark"><ShieldCheck size={21} /></span><span>Agent Locker<small>Owner workspace</small></span></div>;}
export default function App() { return <BrowserRouter><Workspace /></BrowserRouter>; }
