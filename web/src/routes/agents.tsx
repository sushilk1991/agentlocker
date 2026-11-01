import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Users, Plus, Copy, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import type { Agent } from '../lib/api';
import { useSession } from '../lib/session';
import { visibleText } from '../lib/review';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { GrantEditor } from '../components/grant-editor';

export default function Agents() {
 const {api} = useSession(), client = useQueryClient();
 const list = useQuery({queryKey: ['agents'], queryFn: ({signal}) => api.agents(signal)});
 const [creating, setCreating] = useState(false), [selected, setSelected] = useState<string>();
 const [busy, setBusy] = useState(false), [error, setError] = useState('');
 async function create(event: FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (busy) return;
  const form = new FormData(event.currentTarget); setBusy(true); setError('');
  try {
   const agent = await api.createAgent(String(form.get('name')), String(form.get('description')));
   if (!api.active) return;
   await client.invalidateQueries({queryKey: ['agents']});
   setCreating(false); setSelected(agent.id); toast.success('Agent created disabled. Review grants and a task token before enabling it.');
  } catch (error) {if (api.active) setError(visibleText(error instanceof Error ? error.message : 'Could not create agent.'));}
  finally {if (api.active) setBusy(false);}
 }
 const agent = list.data?.agents.find(item => item.id === selected);
 return <>
  <div className="queue-heading agents-heading"><p>Give each agent its own login. New agents start disabled with no access.</p><Button onClick={() => {setError(''); setCreating(true);}}><Plus size={16} />Create agent</Button></div>
  {list.isPending && <Skeleton />}
  {list.error && <p role="alert" className="warning">{visibleText(list.error.message)} <Button variant="outline" onClick={() => void list.refetch()}>Reload agents</Button></p>}
  {list.data?.agents.length === 0 && <section className="panel empty"><span className="empty-icon"><Users size={30} /></span><h2>No agents yet</h2><p>Create an agent, add narrow grants, and issue a short task token.</p></section>}
  {!!list.data?.agents.length && <section className="panel table-panel agents-table"><Table><TableHeader><TableRow><TableHead>Agent</TableHead><TableHead>Status</TableHead><TableHead>Task tokens</TableHead><TableHead>Access</TableHead></TableRow></TableHeader><TableBody>{list.data.agents.map(item => <TableRow key={item.id}>
   <TableCell><strong>{visibleText(item.name)}</strong><p>{visibleText(item.description || 'No description')}</p><small>Agent ID: {item.id}</small></TableCell>
   <TableCell><span className="mobile-cell-label">Status</span><Badge variant={item.status === 'enabled' ? 'default' : item.status === 'revoked' ? 'destructive' : 'secondary'}>{item.status}</Badge></TableCell>
   <TableCell><span className="mobile-cell-label">Task tokens</span>{item.tokens.filter(token => !token.revoked_at && token.expires_at > Date.now()).length} active</TableCell>
   <TableCell><Button variant="outline" onClick={() => setSelected(item.id)}>Manage {visibleText(item.name)}</Button></TableCell>
  </TableRow>)}</TableBody></Table></section>}
  {creating && <Dialog open onOpenChange={open => {if (!busy) setCreating(open);}}><DialogContent busy={busy}><DialogTitle>Create agent</DialogTitle><DialogDescription>Start with no access. Add grants and a task token, then review before enabling.</DialogDescription><form onSubmit={create}>
   <label htmlFor="agent-name">Agent name</label><input id="agent-name" name="name" required maxLength={100} autoComplete="off" />
   <label htmlFor="agent-description">Description (optional)</label><input id="agent-description" name="description" maxLength={1000} />
   {error && <p role="alert" className="warning">{error}</p>}<div className="actions"><Button disabled={busy}>Create agent</Button></div>
  </form></DialogContent></Dialog>}
  {agent && <ManageAgent key={agent.id} agent={agent} onClose={() => setSelected(undefined)} />}
 </>;
}

function ManageAgent({agent, onClose}: {agent: Agent; onClose: () => void}) {
 const {api} = useSession(), client = useQueryClient();
 const [token, setToken] = useState(''), [label, setLabel] = useState(''), [hours, setHours] = useState('24');
 const [busy, setBusy] = useState(false), [error, setError] = useState('');
 const [confirm, setConfirm] = useState<{description: string; run: () => Promise<unknown>}>();
 const revoked = agent.status === 'revoked';
 async function run(work: () => Promise<unknown>, message: string) {
  if (busy) return; setBusy(true); setError('');
  try {
   await work(); if (!api.active) return;
   await Promise.all([client.invalidateQueries({queryKey: ['agents']}), client.invalidateQueries({queryKey: ['grants', agent.id]}), client.invalidateQueries({queryKey: ['overview']})]);
   if (api.active) toast.success(message);
  } catch (error) {if (api.active) setError(visibleText(error instanceof Error ? error.message : 'Could not save change.'));}
  finally {if (api.active) setBusy(false);}
 }
 async function issue(event: FormEvent) {
  event.preventDefault();
  await run(async () => {
   const issued = await api.issueToken(agent.id, label, Math.round(Number(hours) * 3600000));
   if (api.active) {setToken(issued.token); setLabel('');}
  }, 'Task token issued. Save it now.');
 }
 const changeStatus = (status: Agent['status']) => api.setAgentStatus(agent.id, status);
 async function copyToken() {
  try {await navigator.clipboard.writeText(token); if (api.active) toast.success('Token copied. Keep it private.');}
  catch {if (api.active) setError('Clipboard unavailable. Copy the token from its text.');}
 }
 return <Dialog open onOpenChange={open => {if (!open && !busy) onClose();}}><DialogContent className="agent-dialog" busy={busy}>
  <DialogTitle>{visibleText(agent.name)}</DialogTitle><DialogDescription>Agent ID: {agent.id}. Manage its task tokens and exact grants.</DialogDescription>
  <div className="actions"><Badge variant={agent.status === 'enabled' ? 'default' : 'secondary'}>{agent.status}</Badge><Button asChild variant="outline"><Link to={'/audit?' + new URLSearchParams({agent_id: agent.id})}>View agent activity</Link></Button>
   {!revoked && <><Button variant="outline" disabled={busy || agent.status !== 'enabled'} onClick={() => setConfirm({description: 'Disable this agent and invalidate its unexecuted requests? You can enable it after reviewing access. Dispatched sends cannot be recalled.', run: () => changeStatus('disabled')})}>Disable agent</Button><Button variant="destructive" disabled={busy} onClick={() => setConfirm({description: `Permanently revoke ${visibleText(agent.name)} and all its tokens? Unexecuted requests will be invalidated. Dispatched sends cannot be recalled.`, run: () => changeStatus('revoked')})}>Revoke agent</Button></>}
  </div>
  {error && <p role="alert" className="warning">{error}</p>}
  {token && <section className="token-once" aria-label="New task token"><h3>Save this token now</h3><p>It is shown once. Keep it private. Hiding it or leaving this screen clears it.</p><pre id="issued-token">{token}</pre><div className="actions"><Button variant="outline" onClick={() => void copyToken()}><Copy size={16} />Copy token</Button><Button variant="ghost" onClick={() => setToken('')}>Hide token</Button></div>
   <pre>{`HTTP: ${location.origin}/api/v1/\nMCP: ${location.origin}/mcp (Streamable HTTP)\nAuthorization: Bearer AGENT_TOKEN\nCLI / SDK: use this deployment URL and AGENT_TOKEN.`}</pre><p className="hint">Replace AGENT_TOKEN with this agent’s token. Remove direct copies of protected provider keys from agent configs.</p>
  </section>}
  <h3 className="section-title"><KeyRound size={17} />Task tokens</h3>
  {agent.tokens.length === 0 ? <p>No tokens yet.</p> : <Table><TableHeader><TableRow><TableHead>Task</TableHead><TableHead>Expiry and status</TableHead><TableHead>Action</TableHead></TableRow></TableHeader><TableBody>{agent.tokens.map(item => <TableRow key={item.id}><TableCell>{visibleText(item.label)}<p>{visibleText(item.prefix)}…</p><small>Token ID: {item.id}</small></TableCell><TableCell><Badge>{item.revoked_at ? 'revoked' : item.expires_at <= Date.now() ? 'expired' : 'active'}</Badge><p>{new Date(item.expires_at).toLocaleString()}</p></TableCell><TableCell>{!item.revoked_at && !revoked && <Button variant="outline" disabled={busy} onClick={() => setConfirm({description: `Revoke task token ${visibleText(item.label)}? Its unexecuted requests will be invalidated. Dispatched sends cannot be recalled.`, run: () => api.revokeToken(agent.id, item.id)})}>Revoke {visibleText(item.label)}</Button>}</TableCell></TableRow>)}</TableBody></Table>}
  {!revoked && <form className="token-form" onSubmit={issue}><div><label htmlFor="task-label">Task token label</label><input id="task-label" required maxLength={100} value={label} onChange={event => setLabel(event.target.value)} /></div><div><label htmlFor="task-hours">Lifetime in hours (max 720)</label><input id="task-hours" type="number" required min="0.016667" max="720" step="any" value={hours} onChange={event => setHours(event.target.value)} /></div><Button disabled={busy || !!token}>Issue token</Button></form>}
  <GrantEditor agent={agent} busy={busy} onEnable={() => setConfirm({description: `Enable ${visibleText(agent.name)} with the reviewed grants and task tokens shown?`, run: () => changeStatus('enabled')})} />
  {confirm && <ConfirmDialog description={confirm.description} onCancel={() => setConfirm(undefined)} onConfirm={() => {void run(confirm.run, 'Access updated. Unexecuted requests use the current policy.'); setConfirm(undefined);}} />}
 </DialogContent></Dialog>;
}
