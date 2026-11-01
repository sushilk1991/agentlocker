import { useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import type { KeyDetails, KeyInput } from '../lib/api';
import { ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { visibleText } from '../lib/review';
import { stamp, useOwnerTask } from '../lib/management';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { ConfirmDialog } from '../components/ui/confirm-dialog';

type EditorTarget = Omit<KeyDetails, 'agents'>;
export default function Keys() {
 const {api} = useSession(), client = useQueryClient(), task = useOwnerTask();
 const [target, setTarget] = useState<EditorTarget>(), [editor, setEditor] = useState(0), [conflict, setConflict] = useState(false);
 const [scheme, setScheme] = useState<'bearer' | 'plain'>('bearer'), [confirm, setConfirm] = useState<KeyDetails>();
 const header = useRef<HTMLInputElement>(null), formRef = useRef<HTMLFormElement>(null);
 const list = useInfiniteQuery({queryKey: ['keys'], initialPageParam: null as string | null,
  queryFn: ({pageParam, signal}) => api.keys(pageParam, signal), getNextPageParam: page => page.cursor ?? undefined});
 function edit(secret?: EditorTarget) {
  formRef.current?.reset(); setTarget(secret ? {...secret} : undefined); setScheme(secret?.scheme ?? 'bearer'); setEditor(value => value + 1); setConflict(false);
 }
 async function save(event: FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (task.busy || conflict) return;
  const form = event.currentTarget, fields = new FormData(form), value = form.elements.namedItem('value') as HTMLInputElement;
  const input: KeyInput = {name: String(fields.get('name')), hosts: String(fields.get('hosts')).split(/\s+/).filter(Boolean),
   injection_header: String(fields.get('header')), scheme, enabled: fields.get('enabled') === 'on'};
  if (value.value) input.value = value.value;
  // Clear before validation/network errors too. No saved value is ever loaded.
  value.value = '';
  await task.run(async () => {
   try {
    const saved = await api.saveKey(input, target); if (!api.active) return;
    edit(saved); await client.invalidateQueries({queryKey: ['keys']}); void client.invalidateQueries({queryKey: ['grant-keys']});
    return 'Secret saved. Its value cannot be retrieved. Waiting requests were invalidated.';
   } catch (error) {if (api.active && target && error instanceof ApiError && error.code === 'version_conflict') setConflict(true); throw error;}
   finally {delete input.value;}
  });
 }
 async function reload() {
  const data = await list.refetch();
  const current = data.data?.pages.flatMap(page => page.secrets).find(item => item.id === target?.id);
  if (data.error) throw data.error;
  if (api.active && current) edit(current);
  else if (api.active) throw new Error('Reload keys and select the secret again. Its name or page may have changed.');
 }
 return <>
  <p className="page-description">Save provider keys here. Agents use them through the proxy. Every outbound request needs your approval.</p>
  <form key={editor} ref={formRef} id="secret-form" className="panel" onSubmit={save}>
   <h2>{target ? 'Edit ' + visibleText(target.name) : 'Create a secret'}</h2>
   <p id="secret-version" className="hint">{target ? `Editing version ${target.version} · value version ${target.value_version}. Saved values stay hidden. Leave the replacement empty to keep the current key.` : 'A new secret has no agent grants.'}</p>
   <label htmlFor="secret-name">Secret name</label><input id="secret-name" name="name" required maxLength={100} defaultValue={target?.name ?? ''} autoComplete="off" />
   <label htmlFor="secret-value">{target ? 'Replacement value (optional)' : 'Secret value'}</label><input id="secret-value" name="value" type="password" autoComplete="new-password" spellCheck={false} required={!target} />
   <div className="form-grid"><div><label htmlFor="secret-scheme">Credential format</label><select id="secret-scheme" value={scheme} onChange={event => {const next = event.target.value as KeyInput['scheme']; setScheme(next); if (header.current) header.current.value = next === 'bearer' ? 'authorization' : 'x-api-key';}}><option value="bearer">Bearer token</option><option value="plain">Plain value in header</option></select></div>
    <div><label htmlFor="secret-header">Injection header</label><input ref={header} id="secret-header" name="header" defaultValue={target?.injection_header ?? 'authorization'} readOnly={scheme === 'bearer'} required /></div></div>
   <label htmlFor="secret-hosts">Exact allowed hosts</label><textarea id="secret-hosts" name="hosts" required rows={3} defaultValue={target?.hosts.join('\n') ?? ''} placeholder="api.example.com" /><p className="hint">One hostname per line. No wildcards, paths, or schemes.</p>
   <label className="check"><input type="checkbox" name="enabled" defaultChecked={target?.enabled ?? true} />Enabled</label>
   {conflict && <p className="warning">This version has changed. Reload the secret before saving again. Your policy edits stay here until reload.</p>}
   <div className="actions"><Button disabled={task.busy || conflict}>{target ? 'Save secret changes' : 'Create secret'}</Button>{target && <><Button variant="outline" type="button" disabled={task.busy} onClick={() => void task.run(reload)}>Reload secret</Button><Button variant="ghost" type="button" disabled={task.busy} onClick={() => edit()}>Create a new secret</Button></>}</div>
  </form>
  <p id="notice" role="status" className={task.error ? 'warning' : 'management-notice'}>{task.error || task.message}</p>
  {list.isPending && <Skeleton />}{list.error && <p role="alert" className="warning">{visibleText(list.error.message)} <Button variant="outline" onClick={() => void list.refetch()}>Reload keys</Button></p>}
  {list.data?.pages[0].secrets.length === 0 && <section className="panel empty"><KeyRound size={28} /><h2>No keys yet</h2><p>Create a secret, then grant an agent use through the proxy.</p></section>}
  <div id="secret-list" className="management-list">{list.data?.pages.flatMap(page => page.secrets).map(secret => <article className="panel" key={secret.id}>
   <div className="review-heading"><h3>{visibleText(secret.name)}</h3><Badge variant={secret.enabled ? 'default' : 'secondary'}>{secret.enabled ? 'Enabled' : 'Disabled'}</Badge></div>
   <p>{secret.enabled ? 'Enabled' : 'Disabled'} · version {secret.version} · value version {secret.value_version}</p>
   <p>Injection: {visibleText(secret.injection_header)}: {secret.scheme === 'bearer' ? 'Bearer ' : ''}[saved value]</p><p>Exact hosts: {visibleText(secret.hosts.join(', '))}</p>
   <p className="hint">Created {stamp(secret.created_at)} · updated {stamp(secret.updated_at)}</p><h4>Granted agents</h4>
   {!secret.agents.length && <p>No agents have a grant. Add named-secret use in Agents.</p>}
   {secret.agents.map(agent => <p key={agent.id}>{visibleText(agent.name)} · {agent.status} · {agent.expires_at && agent.expires_at <= Date.now() ? 'grant expired' : agent.expires_at ? 'grant expires ' + stamp(agent.expires_at) : 'no grant expiry'} · {secret.enabled ? 'proxy use only' : 'secret disabled'}</p>)}
   <div className="actions"><Button variant="outline" disabled={task.busy} onClick={() => edit(secret)}>Edit secret</Button><Button asChild variant="outline"><Link to={'/audit?' + new URLSearchParams({secret: secret.name, include_routine: 'true'})}>Use history</Link></Button>
    {secret.enabled && <Button variant="destructive" disabled={task.busy} onClick={() => setConfirm({...secret})}>Disable secret</Button>}</div>
  </article>)}</div>
  {list.hasNextPage && <Button variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>More keys</Button>}
  {confirm && <ConfirmDialog description={`Disable ${visibleText(confirm.name)} at version ${confirm.version}? Waiting requests will be invalidated.`} onCancel={() => setConfirm(undefined)} onConfirm={() => {
   const secret = confirm; setConfirm(undefined); void task.run(async () => {const saved = await api.disableKey(secret.id, secret.version); if (!api.active) return; if (target?.id === secret.id) edit(saved); await client.invalidateQueries({queryKey: ['keys']}); void client.invalidateQueries({queryKey: ['grant-keys']}); return 'Secret disabled. Waiting requests were invalidated.';});
  }} />}
 </>;
}
