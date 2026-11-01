import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, type KeyMetadata, type Policy as PolicyData, type PolicyRule } from '../lib/api';
import { useSession } from '../lib/session';
import { visibleText } from '../lib/review';
import { useOwnerTask } from '../lib/management';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { ConfirmDialog } from '../components/ui/confirm-dialog';

export default function Policy() {
 const {api} = useSession();
 const query = useQuery({queryKey: ['policy'], queryFn: async ({signal}) => {const [policy, keys] = await Promise.all([api.policy(signal), api.allKeys(signal)]); return {policy, keys};}, refetchOnReconnect: false, refetchOnMount: 'always'});
 const [loaded, setLoaded] = useState(false);
 useEffect(() => {if (query.isFetchedAfterMount && query.isSuccess) setLoaded(true);}, [query.isFetchedAfterMount, query.isSuccess]);
 return <>
  <p className="page-description">Agents always need approval to delete, replace, or send. Extra rules can also require review for reads, new writes, folder listings, or secret listings. Rules do not grant access.</p>
  {!loaded && !query.error && <Skeleton />}{query.error && <p role="alert" className="warning">{visibleText(query.error.message)} {!loaded && <Button onClick={() => void query.refetch()}>Reload policy</Button>}</p>}
  {loaded && query.data && <PolicyEditor initial={query.data.policy} keys={query.data.keys} reload={async () => {const result = await query.refetch(); if (result.error) throw result.error; return result.data!.policy;}} />}
 </>;
}
function PolicyEditor({initial, keys, reload}: {initial: PolicyData; keys: KeyMetadata[]; reload: () => Promise<PolicyData>}) {
 const {api} = useSession(), task = useOwnerTask();
 const [draft, setDraft] = useState(initial), [conflict, setConflict] = useState(false), [confirmation, setConfirmation] = useState<PolicyRule[]>();
 const [rules, setRules] = useState(() => initial.rules.map(rule => ({...rule, localId: crypto.randomUUID()})));
 const change = (id: string, patch: Partial<PolicyRule>) => setRules(old => old.map(rule => rule.localId === id ? {...rule, ...patch} : rule));
 async function load() {const policy = await reload(); if (api.active) {setDraft(policy); setRules(policy.rules.map(rule => ({...rule, localId: crypto.randomUUID()}))); setConflict(false);}}
 return <section className="panel"><h2>Extra approval rules</h2><p id="policy-version">Editing version {draft.version}. Mandatory approvals: delete, replace, and every proxy send.</p>
  <form onSubmit={event => {event.preventDefault(); if (!conflict && !task.busy) setConfirmation(rules.map(rule => ({operation: rule.operation, ...(rule.operation === 'secrets.list' ? (rule.secret_id ? {secret_id: rule.secret_id} : {}) : (rule.prefix ? {prefix: rule.prefix} : {}))})));}}>
   <div id="policy-rules">{rules.map(rule => <fieldset className="grant-row" key={rule.localId}><legend>Approval rule</legend>
    <label htmlFor={'operation-' + rule.localId}>Operation</label><select id={'operation-' + rule.localId} value={rule.operation} onChange={event => change(rule.localId, {operation: event.target.value as PolicyRule['operation']})}>
     <option value="file.read">Read file content or metadata</option><option value="file.write">Write a new file</option><option value="files.list">List files in a folder</option><option value="secrets.list">List secret metadata</option>
    </select>
    {rule.operation === 'secrets.list' ? <><label htmlFor={'scope-' + rule.localId}>Secret scope</label><select id={'scope-' + rule.localId} value={rule.secret_id ?? ''} onChange={event => change(rule.localId, {secret_id: event.target.value})}><option value="">All granted secrets</option>{keys.map(key => <option key={key.id} value={key.id}>{visibleText(key.name)}{key.enabled ? '' : ' (disabled)'}</option>)}</select></> :
     <><label htmlFor={'prefix-' + rule.localId}>Folder prefix (empty means all folders)</label><input id={'prefix-' + rule.localId} value={rule.prefix ?? ''} onChange={event => change(rule.localId, {prefix: event.target.value})} placeholder="/work/" /></>}
    <div className="actions"><Button type="button" variant="outline" disabled={task.busy} onClick={() => setRules(old => old.filter(item => item.localId !== rule.localId))}>Remove rule</Button></div>
   </fieldset>)}</div>
   {conflict && <p className="warning">This version has changed. Reload policy before saving again. Your edits stay here until reload.</p>}
   <div className="actions"><Button type="button" variant="outline" disabled={task.busy || rules.length >= 100} onClick={() => setRules(old => [...old, {operation: 'file.read', prefix: '/', localId: crypto.randomUUID()}])}>Add rule</Button><Button disabled={task.busy || conflict}>Save policy</Button><Button type="button" variant="outline" disabled={task.busy} onClick={() => void task.run(load)}>Reload policy</Button></div>
  </form>
  <p id="notice" role="status" className={task.error ? 'warning' : 'management-notice'}>{task.error || task.message}</p><p className="hint">Saving rules invalidates pending and ready requests. Already dispatched sends cannot be recalled.</p>
  {confirmation && <ConfirmDialog description={`Save ${confirmation.length} extra approval rules at version ${draft.version}? Pending and ready requests will be invalidated.`} onCancel={() => setConfirmation(undefined)} onConfirm={() => {const input = confirmation; setConfirmation(undefined); void task.run(async () => {try {await api.savePolicy(draft.version, input); if (!api.active) return; await load(); return 'Policy saved. Pending and ready requests were invalidated.';} catch (error) {if (api.active && error instanceof ApiError && error.status === 409) setConflict(true); throw error;}});}} />}
 </section>;
}
