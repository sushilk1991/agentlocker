import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError, type Settings as SettingsData } from '../lib/api';
import { useSession } from '../lib/session';
import { visibleText } from '../lib/review';
import { stamp, useOwnerTask } from '../lib/management';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Skeleton } from '../components/ui/skeleton';

export default function Settings() {
 const {api} = useSession();
 const query = useQuery({queryKey: ['settings'], queryFn: ({signal}) => api.settings(signal), refetchOnReconnect: false, refetchOnMount: 'always'});
 const [loaded, setLoaded] = useState(false);
 useEffect(() => {if (query.isFetchedAfterMount && query.isSuccess) setLoaded(true);}, [query.isFetchedAfterMount, query.isSuccess]);
 return <section id="settings">{!loaded && !query.error && <Skeleton />}{query.error && <p role="alert" className="warning">{visibleText(query.error.message)} {!loaded && <Button onClick={() => void query.refetch()}>Reload settings</Button>}</p>}
  {loaded && query.data && <SettingsEditor initial={query.data} reload={async () => {const result = await query.refetch(); if (result.error) throw result.error; return result.data!;}} />}
 </section>;
}
function SettingsEditor({initial, reload}: {initial: SettingsData; reload: () => Promise<SettingsData>}) {
 const {api, signOut} = useSession(), task = useOwnerTask();
 // A separate draft pins the version even if Query is refreshed elsewhere.
 const [draft, setDraft] = useState(initial), [generation, setGeneration] = useState(0), [conflict, setConflict] = useState(false);
 const [confirmation, setConfirmation] = useState<Pick<SettingsData, 'approval_ttl' | 'quota_bytes' | 'retention_ms' | 'maintenance'>>();
 async function load() {const data = await reload(); if (api.active) {setDraft(data); setGeneration(value => value + 1); setConflict(false);}}
 function submit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (task.busy || conflict) return;
  const values = new FormData(event.currentTarget);
  setConfirmation({approval_ttl: Math.round(Number(values.get('expiry')) * 60000), quota_bytes: Number(values.get('quota')),
   retention_ms: Math.round(Number(values.get('retention')) * 86400000), maintenance: values.get('maintenance') === 'on'});
 }
 return <>
  <div className="panel"><h2>Locker settings</h2><p id="settings-version">Editing version {draft.version}. Updated {stamp(draft.updated_at)}.</p><p>Your URL: {visibleText(draft.public_origin)}</p>
   <form key={generation} id="settings-form" onSubmit={submit}>
    <label htmlFor="settings-expiry">Default approval expiry in minutes</label><input id="settings-expiry" name="expiry" type="number" min="1" max="60" step="any" required defaultValue={draft.approval_ttl / 60000} /><p className="hint">Applies to new requests. Unanswered approvals expire.</p>
    <label htmlFor="settings-quota">File quota in bytes</label><input id="settings-quota" name="quota" type="number" min="1" max="9007199254740991" required defaultValue={draft.quota_bytes} /><p className="hint">Current files, retained revisions, and staged uploads all count. Lowering the quota can block uploads.</p>
    <label htmlFor="settings-retention">File history retention in days</label><input id="settings-retention" name="retention" type="number" min="7" step="any" required defaultValue={draft.retention_ms / 86400000} /><p className="hint">At least seven days. Changes apply to later file changes. Each revision shows its actual restore deadline. Audit metadata is kept indefinitely. Action payloads and results normally expire after 24 hours.</p>
    <label className="check"><input type="checkbox" name="maintenance" defaultChecked={draft.maintenance} />Maintenance mode: stop protected calls and scheduled work</label><p className="hint">You can return to Settings to turn maintenance off. Saving settings invalidates pending and ready requests.</p>
    {conflict && <p className="warning">This version has changed. Reload settings before saving again. Your edits stay here until reload.</p>}
    <div className="actions"><Button disabled={task.busy || conflict}>Save settings</Button><Button type="button" variant="outline" disabled={task.busy} onClick={() => void task.run(load)}>Reload settings</Button><Button asChild variant="ghost"><Link to="/policy">Extra approval rules</Link></Button></div>
   </form>
  </div>
  <p id="notice" role="status" className={task.error ? 'warning' : 'management-notice'}>{task.error || task.message}</p>
  <section className="panel"><h2>Backups and key rotation</h2><p>See <code>docs/operations.md</code> in your project checkout for backup and key-rotation steps and current tooling gaps. See <code>docs/deploy.md</code> for Worker secret configuration.</p><p>File history and audit exports are not complete backups. Keep private copies of your data and separate offline copies of required encryption keys, their versions, and the deployment ID. A verified backup and recovery drill is still release work.</p><p>Owner tokens and storage encryption keys are Worker secrets. Change an owner token through Cloudflare or Wrangler. Do not reset setup or grants. Storage re-encryption tooling is unfinished. Do not replace the storage key or deployment ID on a populated locker as a routine update.</p><p>Replace provider keys in Keys. Issue and revoke agent task tokens in Agents.</p></section>
  <p>Approvals stay in this deployment’s web app. Native iOS push is future work.</p><div className="actions"><Button variant="outline" onClick={signOut}>Sign out of this locker</Button></div>
  {confirmation && <ConfirmDialog description={`Save settings at version ${draft.version}? Pending and ready requests will be invalidated.${confirmation.maintenance ? ' Maintenance stops protected calls and scheduled work.' : ''}`} onCancel={() => setConfirmation(undefined)} onConfirm={() => {
   const input = confirmation; setConfirmation(undefined); void task.run(async () => {try {await api.saveSettings(draft.version, input); if (!api.active) return; await load(); return 'Settings saved. Pending and ready requests were invalidated.';} catch (error) {if (api.active && error instanceof ApiError && error.status === 409) setConflict(true); throw error;}});
  }} />}
 </>;
}
