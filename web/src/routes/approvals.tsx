import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { Check, CheckCheck, Clock3, Inbox, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ActionState, DecisionResult, Overview } from '../lib/api';
import { useSession } from '../lib/session';
import { loadReview, visibleText } from '../lib/review';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { ApprovalReview } from '../components/approval-review';

export default function Approvals() {
 const {api} = useSession(), client = useQueryClient();
 const {overview, visible} = useOutletContext<{overview?: Overview; visible: boolean}>();
 const [state, setState] = useState('pending'), [offset, setOffset] = useState(0), [selected, setSelected] = useState<string[]>([]);
 const [reason, setReason] = useState(''), [result, setResult] = useState<DecisionResult>(), [states, setStates] = useState<Record<string, ActionState>>({});
 const [confirm, setConfirm] = useState<{description: string; run: () => void}>();
 const [now, setNow] = useState(Date.now());
 const list = useQuery({queryKey: ['approvals', state, offset, overview?.pending_version], queryFn: ({signal}) => api.approvals(state, offset, signal), placeholderData: keepPreviousData, enabled: visible});
 const reviews = useQueries({queries: selected.map(id => ({queryKey: ['review', id], queryFn: ({signal}: {signal: AbortSignal}) => loadReview(api, id, signal), staleTime: Infinity, gcTime: 0, refetchOnReconnect: false}))});
 const statuses = useQuery({queryKey: ['review-states', selected, overview?.pending_version], queryFn: async ({signal}) => {
  const entries = await Promise.all(selected.map(async id => {
   const review = client.getQueryData<Awaited<ReturnType<typeof loadReview>>>(['review', id]);
   return review ? [id, (await api.action(review.data.id, signal)).status] as const : null;
  })); return Object.fromEntries(entries.filter(entry => entry !== null));
 }, enabled: visible && selected.length > 0 && reviews.every(review => !!review.data), gcTime: 0});
 useEffect(() => {if (statuses.data) setStates(previous => ({...previous, ...statuses.data}));}, [statuses.data]);
 // Expiry is a local deadline, independent of polling or network availability.
 useEffect(() => {
  const next = Math.min(...reviews.map(r => r.data?.data.expires_at ?? Infinity).filter(time => time > now));
  if (!Number.isFinite(next)) return;
  const timer = setTimeout(() => setNow(Date.now()), Math.min(2147483647, Math.max(1, next - Date.now() + 1)));
  return () => clearTimeout(timer);
 }, [reviews, now]);
 const mutation = useMutation({mutationFn: async ({decision, ids}: {decision: 'approve' | 'deny'; ids: string[]}) => {
  const members = ids.map(id => {
   const review = reviews[selected.indexOf(id)]?.data;
   if (!review || (decision === 'approve' && (!review.verified || (states[id] ?? review.data.status) !== 'pending' || review.data.expires_at <= Date.now()))) throw new Error('Every selected request must be loaded, verified, and pending.');
   return {id, digest: review.data.digest};
  }); return api.decide(members, decision, reason);
 }, onSuccess: data => {
  if (!api.active) return;
  setResult(data); setStates(previous => ({...previous, ...Object.fromEntries(data.results.filter(item => item.status).map(item => [item.approval_id, item.status!]))}));
  toast.success('Decision recorded. Check each request’s execution state.');
  void client.invalidateQueries({queryKey: ['overview']}); void client.invalidateQueries({queryKey: ['approvals']}); void client.invalidateQueries({queryKey: ['review-states']});
 }, onError: error => {if (api.active) toast.error(visibleText(error.message));}});
 const revoke = useMutation({mutationFn: (id: string) => api.revokeAgent(id), onSuccess: () => {if (!api.active) return; toast.success('Agent revoked.'); void client.invalidateQueries({queryKey: ['overview']});}, onError: error => {if (api.active) toast.error(visibleText(error.message));}});
 const busy = mutation.isPending || revoke.isPending;
 const decide = (decision: 'approve' | 'deny', ids = selected) => setConfirm({description: `${decision === 'approve' ? 'Approve' : 'Deny'} exactly ${ids.length} selected request${ids.length === 1 ? '' : 's'}? This decision applies only to the digests shown.`, run: () => mutation.mutate({decision, ids})});
 const valid = reviews.length > 0 && reviews.every((review, i) => review.data?.verified && (states[selected[i]] ?? review.data.data.status) === 'pending' && review.data.data.expires_at > Math.max(now, Date.now()));
 const canDeny = reviews.length > 0 && reviews.every((review, i) => review.data && (states[selected[i]] ?? review.data.data.status) === 'pending' && review.data.data.expires_at > Math.max(now, Date.now()));
 const groups = useMemo(() => {
  const grouped = new Map<string, NonNullable<typeof list.data>['approvals']>();
  for (const item of list.data?.approvals ?? []) {const key = item.agent_name + ' · ' + item.operation; grouped.set(key, [...(grouped.get(key) ?? []), item]);}
  return grouped;
 }, [list.data]);
 function select(id: string, checked: boolean) {
  if (!checked) {setSelected(previous => previous.filter(member => member !== id)); return;}
  if (selected.length >= 20) {toast.error('Select at most 20 requests per batch.'); return;}
  setSelected(previous => [...previous, id]);
 }
 return <>
  <p className="page-description">A clear view before anything changes. Review each complete request, then approve or deny.</p>
  <div className="summary-cards"><div className="panel summary-card"><span className="icon-wash"><Inbox size={20} /></span><div><p>Awaiting your review</p><strong>{overview?.pending_count ?? '–'}</strong></div></div><div className="panel summary-card"><span className="icon-wash"><Clock3 size={20} /></span><div><p>Oldest pending request</p><strong>{overview?.oldest_pending_at ? Math.max(0, Math.floor((Date.now() - overview.oldest_pending_at) / 60000)) + ' min' : 'None'}</strong></div></div></div>
  <div className="queue-heading"><div><h2>Review requests</h2><p>Nothing starts selected. Every send, deletion, and replacement needs a decision.</p></div><div><label htmlFor="approval-state">Show approvals</label><select id="approval-state" value={state} onChange={event => {setState(event.target.value); setOffset(0);}}>{['pending', 'all', 'approved', 'denied', 'expired', 'invalidated'].map(value => <option key={value} value={value}>{value === 'all' ? 'All states' : value[0].toUpperCase() + value.slice(1)}</option>)}</select></div></div>
  {list.isLoading && <Skeleton />}{list.error && <p role="alert" className="warning">{visibleText(list.error.message)} {list.data && 'Showing the last successful list.'}</p>}
  <div id="approval-list" aria-busy={list.isFetching}>{!list.isLoading && !list.error && list.data?.approvals.length === 0 && <div className="panel empty"><span className="empty-icon"><CheckCheck size={30} /></span><h3>All clear for now</h3><p>No requests in this view. New requests will appear here automatically.</p><p className="hint">Approvals wait in this app and expire if unanswered.</p></div>}
   {[...groups].map(([group, items]) => <section className="panel queue-group" key={group}><h3>{visibleText(group)} <span className="badge">{items.length}</span></h3>{items.map(item => <label className="queue-row" key={item.approval_id}><input type="checkbox" checked={selected.includes(item.approval_id)} onChange={event => select(item.approval_id, event.target.checked)} /><span className="queue-text"><strong>{visibleText(item.target)}</strong><span>{visibleText(item.agent_name)} · {visibleText(item.token_label)} · {visibleText(item.operation)}</span><small>Created {new Date(item.created_at).toLocaleString()} · expires {new Date(item.expires_at).toLocaleString()}</small></span><span className="badge">{item.status === 'pending' && item.expires_at <= Date.now() ? 'expired' : item.status}</span></label>)}</section>)}
  </div><div className="actions pagination">{offset > 0 && <Button variant="outline" onClick={() => setOffset(Math.max(0, offset - 50))}>Previous requests</Button>}{list.data?.approvals.length === 50 && <Button variant="outline" onClick={() => setOffset(offset + 50)}>More requests</Button>}</div>
  <div id="review-list">{selected.map((id, i) => <ApprovalReview key={id} review={reviews[i].data} error={reviews[i].error} status={states[id] ?? reviews[i].data?.data.status} busy={busy} changedHost={reviews.some(other => other.data?.data.input.secret && other.data.data.input.secret === reviews[i].data?.data.input.secret && other.data.data.input.request && reviews[i].data?.data.input.request && new URL(other.data.data.input.request.url).hostname !== new URL(reviews[i].data.data.input.request.url).hostname)} onDecide={decision => decide(decision, [id])} onRevoke={() => {
   const agentId = reviews[i].data?.data.digest_context.agent_id;
   if (agentId) setConfirm({description: 'Revoke this agent and invalidate its unexecuted requests? Dispatched sends cannot be recalled.', run: () => revoke.mutate(agentId)});
  }} />)}</div>
  {selected.length > 0 && <section id="batch" className="panel batch"><h3>Decide selected requests</h3><p>{selected.length} explicitly selected request{selected.length === 1 ? '' : 's'}. Each complete request and digest is shown above. Loading does not mean you have read it.</p><label htmlFor="decision-reason">Reason (optional)</label><input id="decision-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} /><div className="actions"><Button disabled={!valid || busy} onClick={() => decide('approve')}><Check size={16} />Approve {selected.length} selected</Button><Button variant="outline" disabled={!canDeny || busy} onClick={() => decide('deny')}><X size={16} />Deny {selected.length} selected</Button><Button variant="ghost" disabled={busy} onClick={() => {setSelected([]); setReason(''); setResult(undefined);}}>Clear selection</Button></div><pre id="decision-result" role="status">{result ? visibleText(JSON.stringify(result, null, 2)) : ''}</pre></section>}
  {confirm && <ConfirmDialog description={confirm.description} onCancel={() => setConfirm(undefined)} onConfirm={() => {confirm.run(); setConfirm(undefined);}} />}
 </>;
}
