import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, ShieldCheck } from 'lucide-react';
import { ApiError, type Agent, type AgentGrants, type FolderGrant, type KeyGrant, type KeyMetadata } from '../lib/api';
import { useSession } from '../lib/session';
import { visibleText } from '../lib/review';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { Badge } from './ui/badge';
import { ConfirmDialog } from './ui/confirm-dialog';

export function GrantEditor({agent, busy, onEnable}: {agent: Agent; busy: boolean; onEnable: () => void}) {
 const {api} = useSession();
 const grants = useQuery({queryKey: ['grants', agent.id], queryFn: ({signal}) => api.grants(agent.id, signal)});
 const keys = useQuery({queryKey: ['grant-keys'], queryFn: ({signal}) => api.allKeys(signal), staleTime: 0});
 return <section id="grant-editor"><h3 className="section-title"><ShieldCheck size={17} />Folder and key grants</h3>
  <p>Access adds together across unexpired grants. A narrow grant does not override a broad one. Read, write, and delete are separate. Delete and replacement still need approval.</p>
  {(grants.isPending || keys.isPending) && <Skeleton />}
  {(grants.error || keys.error) && <p role="alert" className="warning">{visibleText((grants.error || keys.error)!.message)} <Button variant="outline" onClick={() => {void grants.refetch(); void keys.refetch();}}>Reload grants and keys</Button></p>}
  {grants.data && keys.data && !grants.error && !keys.error && <GrantForm key={grants.data.version} agent={agent} data={grants.data} keys={keys.data} busy={busy} onEnable={onEnable} onReload={() => {void grants.refetch(); void keys.refetch();}} />}
 </section>;
}

type FolderRow = Omit<FolderGrant, 'expires_at'> & {rowId: string; expiry: string};
function localTime(value: number | null) {
 if (value === null) return '';
 return new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, -1);
}
const expiry = (value: string) => value ? new Date(value).getTime() : null;

function GrantForm({agent, data, keys, busy, onEnable, onReload}: {agent: Agent; data: AgentGrants; keys: KeyMetadata[]; busy: boolean; onEnable: () => void; onReload: () => void}) {
 const {api} = useSession(), client = useQueryClient();
 const [folders, setFolders] = useState<FolderRow[]>(() => data.folders.map(g => ({prefix: g.prefix, read: !!g.read, write: !!g.write, delete: !!g.delete, rowId: crypto.randomUUID(), expiry: localTime(g.expires_at)})));
 const [keyGrants, setKeyGrants] = useState(() => Object.fromEntries(keys.map(key => {
  const saved = data.secrets.find(grant => grant.secret_id === key.id);
  return [key.id, {checked: !!saved, expiry: localTime(saved?.expires_at ?? null)}];
 })));
 const [saving, setSaving] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false);
 const [confirmation, setConfirmation] = useState<{folders: FolderGrant[]; secrets: KeyGrant[]}>();
 const disabled = busy || saving || agent.status === 'revoked';
 const update = (index: number, value: Partial<FolderRow>) => {setDirty(true); setFolders(previous => previous.map((row, i) => i === index ? {...row, ...value} : row));};
 function submit(event: FormEvent) {
  event.preventDefault(); if (disabled || conflict) return;
  setConfirmation({folders: folders.map(({rowId: _id, expiry: date, ...folder}) => ({...folder, expires_at: expiry(date)})), secrets: keys.filter(key => keyGrants[key.id]?.checked).map(key => ({secret_id: key.id, read: true, expires_at: expiry(keyGrants[key.id].expiry)}))});
 }
 async function save() {
  if (!confirmation || disabled) return;
  const input = confirmation; setConfirmation(undefined); setSaving(true); setError('');
  try {
   await api.saveGrants(agent.id, data.version, input.folders, input.secrets);
   if (!api.active) return;
   await Promise.all([client.invalidateQueries({queryKey: ['grants', agent.id]}), client.invalidateQueries({queryKey: ['agents']}), client.invalidateQueries({queryKey: ['overview']})]);
   if (api.active) toast.success('Grants saved. Outstanding requests checked against older policy are invalidated.');
  } catch (error) {
   if (api.active) {setError(visibleText(error instanceof Error ? error.message : 'Could not save grants.')); setConflict(error instanceof ApiError && error.code === 'version_conflict');}
  } finally {if (api.active) setSaving(false);}
 }
 return <>
  <details><summary>Effective grants now · version {data.version}</summary><pre>{visibleText(JSON.stringify(data.effective, null, 2))}</pre></details>
  <form onSubmit={submit}>
   <fieldset disabled={disabled}><legend>Folder grants</legend>
    {!folders.length && <p>No folder grants. This agent cannot access any files.</p>}
    {folders.map((folder, index) => <div className="grant-row" key={folder.rowId}>
     <label htmlFor={'prefix-' + folder.rowId}>Folder prefix</label><input id={'prefix-' + folder.rowId} required placeholder="/projects/example/" value={folder.prefix} onChange={event => update(index, {prefix: event.target.value})} />
     <div className="actions permissions">{(['read', 'write', 'delete'] as const).map(permission => <label className="check" key={permission}><input type="checkbox" checked={folder[permission]} onChange={event => update(index, {[permission]: event.target.checked})} />{permission}</label>)}</div>
     <label htmlFor={'expiry-' + folder.rowId}>Folder expires (optional)</label><input id={'expiry-' + folder.rowId} type="datetime-local" step="0.001" value={folder.expiry} onChange={event => update(index, {expiry: event.target.value})} />
     {folder.expiry && new Date(folder.expiry).getTime() <= Date.now() && <Badge>expired</Badge>}
     {folder.prefix === '/' && <p className="warning">Root access covers every file in this locker.</p>}
     <Button type="button" variant="ghost" onClick={() => {setDirty(true); setFolders(previous => previous.filter((_, i) => i !== index));}}>Remove folder</Button>
    </div>)}
    <Button type="button" variant="outline" disabled={folders.length >= 100} onClick={() => {setDirty(true); setFolders(previous => [...previous, {rowId: crypto.randomUUID(), prefix: '', read: false, write: false, delete: false, expiry: ''}]);}}><Plus size={16} />Add folder</Button>
   </fieldset>
   <fieldset disabled={disabled}><legend>Named keys · Use through proxy</legend><p>The Worker reads the key for this agent. The agent never receives the saved value. Every outbound request needs approval.</p>
    {!keys.length && <p>No saved keys yet.</p>}
    {keys.map(key => <div className="grant-row" key={key.id}><label className="check"><input type="checkbox" checked={keyGrants[key.id]?.checked ?? false} onChange={event => {setDirty(true); setKeyGrants(previous => ({...previous, [key.id]: {...previous[key.id], checked: event.target.checked}}));}} />{visibleText(key.name)}{!key.enabled && <Badge>disabled</Badge>}</label><p>Exact hosts: {visibleText(key.hosts.join(', '))}</p>
     <label htmlFor={'key-expiry-' + key.id}>Key grant expires (optional) · {visibleText(key.name)}</label><input id={'key-expiry-' + key.id} type="datetime-local" step="0.001" disabled={!keyGrants[key.id]?.checked} value={keyGrants[key.id]?.expiry ?? ''} onChange={event => {setDirty(true); setKeyGrants(previous => ({...previous, [key.id]: {...previous[key.id], expiry: event.target.value}}));}} />
     {keyGrants[key.id]?.expiry && new Date(keyGrants[key.id].expiry).getTime() <= Date.now() && <Badge>grant expired</Badge>}
    </div>)}
   </fieldset>
   {error && <p role="alert" className="warning">{error}{conflict && ' This version changed. Reload grants, then review your edits again.'}</p>}
   <div className="actions"><Button disabled={disabled || conflict}>Save reviewed grants</Button><Button type="button" variant="outline" disabled={disabled} onClick={onReload}>Reload grants</Button></div>
  </form>
  {agent.status === 'disabled' && <div className="actions"><p>Review the effective grants and task tokens above before enabling this agent.</p><Button type="button" disabled={disabled || dirty || conflict || agent.tokens.every(token => !!token.revoked_at || token.expires_at <= Date.now())} onClick={onEnable}>Enable {visibleText(agent.name)}</Button>{dirty && <p className="hint">Save your grant edits before enabling.</p>}</div>}
  {confirmation && <ConfirmDialog description={(confirmation.folders.some(folder => folder.prefix === '/') ? 'Grant root folder access? These permissions cover the whole locker. ' : '') + `Save the reviewed grants at version ${data.version}? Outstanding requests checked against older policy will be invalidated.`} onCancel={() => setConfirmation(undefined)} onConfirm={() => void save()} />}
 </>;
}
