import { useState, type FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Download } from 'lucide-react';
import { useSession } from '../lib/session';
import { visibleText } from '../lib/review';
import { saveDownload, stamp, useOwnerTask } from '../lib/management';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
const fields = [
 ['from', 'From', 'datetime-local'], ['to', 'Until', 'datetime-local'], ['agent_id', 'Agent ID'], ['token_id', 'Token ID'], ['operation', 'Operation'],
 ['path', 'Exact file path'], ['prefix', 'Folder prefix'], ['secret', 'Secret name'], ['host', 'Destination host'], ['decision', 'Decision'],
 ['outcome', 'Outcome'], ['request_id', 'Request ID'], ['action_id', 'Action ID'],
];
function localTime(value: string | null) {if (!value) return ''; const date = new Date(Number(value)); if (!Number.isFinite(date.getTime())) return ''; return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23);}
export default function Audit() {
 const {api} = useSession(), task = useOwnerTask(), [search, setSearch] = useSearchParams();
 const params = new URLSearchParams(search); if (!params.has('include_routine')) params.set('include_routine', 'false');
 const applied = params.toString();
 const [expanded, setExpanded] = useState<number>();
 const list = useInfiniteQuery({queryKey: ['audit', applied], initialPageParam: null as number | null,
  queryFn: ({pageParam, signal}) => api.audit(applied, pageParam, signal), getNextPageParam: page => page.next_cursor ?? undefined});
 function apply(event: FormEvent<HTMLFormElement>) {
  event.preventDefault(); const next = new URLSearchParams();
  for (const [key, value] of new FormData(event.currentTarget)) if (value && key !== 'include_routine') next.set(key, ['from', 'to'].includes(key) ? String(new Date(String(value)).getTime()) : String(value));
  next.set('include_routine', (event.currentTarget.elements.namedItem('include_routine') as HTMLInputElement).checked ? 'true' : 'false');
  if (next.toString() === applied) void list.refetch(); else setSearch(next);
 }
 return <>
  <p className="page-description">Audit metadata is kept indefinitely. Routine reads and polls stay in the log even when hidden here.</p>
  <form id="audit-filter" className="panel form-grid" key={applied} onSubmit={apply}>{fields.map(([name, label, type]) => <div key={name}><label htmlFor={'audit-' + name}>{label}</label><input id={'audit-' + name} name={name} type={type ?? 'text'} step={type ? '0.001' : undefined} defaultValue={type ? localTime(search.get(name)) : search.get(name) ?? ''} /></div>)}
   <label className="check"><input name="include_routine" type="checkbox" defaultChecked={params.get('include_routine') === 'true'} />Include routine reads and polls</label><div className="actions"><Button>Apply filters</Button><Button type="button" variant="ghost" onClick={event => {event.currentTarget.form?.reset(); setSearch(new URLSearchParams({include_routine: 'false'}));}}>Clear filters</Button></div>
  </form>
  <div className="actions export-actions">{(['jsonl', 'csv'] as const).map(format => <Button key={format} variant="outline" disabled={task.busy} onClick={() => void task.run(async () => {const blob = await api.exportAudit(applied, format); if (api.active) saveDownload(blob, 'agent-locker-audit.' + format);})}><Download size={15} />Export {format.toUpperCase()}</Button>)}</div>
  {task.error && <p role="alert" className="warning">{task.error}</p>}{list.isPending && <Skeleton />}
  {list.error && <p role="alert" className="warning">{visibleText(list.error.message)} <Button variant="outline" onClick={() => void list.refetch()}>Reload audit</Button></p>}
  <section id="audit-events" className="panel table-panel">{list.data?.pages[0].events.length === 0 ? <p className="empty">No matching events.</p> : <Table><TableHeader><TableRow><TableHead>Time / actor</TableHead><TableHead>Action / target</TableHead><TableHead>Decision / result</TableHead><TableHead>Trace</TableHead></TableRow></TableHeader><TableBody>{list.data?.pages.flatMap(page => page.events).map(event => <TableRow key={event.id}>
   <TableCell>{stamp(event.timestamp)}<p>{visibleText(event.actor_name)} ({event.actor_kind})</p><small>Event {event.id}</small></TableCell>
   <TableCell><strong>{visibleText(event.operation)}</strong><p>{visibleText(event.target)}</p></TableCell>
   <TableCell><Badge variant={['failed', 'unknown', 'denied'].includes(event.result) ? 'destructive' : 'outline'}>{event.decision} · {event.result}</Badge><p>{visibleText(event.reason_code)}</p></TableCell>
   <TableCell><small>Request: {visibleText(event.request_id)}</small>{event.action_id && <p><Link className="text-link" to={'/audit?' + new URLSearchParams({action_id: event.action_id, include_routine: 'true'})}>Action: {event.action_id}</Link></p>}{event.token_id && <p>Token: {event.token_id}</p>}
    <Button variant="ghost" aria-expanded={expanded === event.id} onClick={() => setExpanded(expanded === event.id ? undefined : event.id)}>Event details {event.id}</Button>
    {expanded === event.id && <pre>{visibleText(JSON.stringify(event, null, 2))}</pre>}</TableCell>
  </TableRow>)}</TableBody></Table>}</section>
  {list.hasNextPage && <Button variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Older events</Button>}
 </>;
}
