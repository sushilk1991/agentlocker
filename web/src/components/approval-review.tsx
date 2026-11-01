import { Download, Check, X, ShieldAlert } from 'lucide-react';
import { ByteReview } from './byte-review';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { download, visibleText, type LoadedReview } from '../lib/review';
import type { ActionState } from '../lib/api';
export function ApprovalReview({review, error, status, busy, changedHost, onDecide, onRevoke}: {
 review?: LoadedReview; error?: Error | null; status?: ActionState; busy: boolean; changedHost: boolean;
 onDecide: (decision: 'approve' | 'deny') => void; onRevoke: () => void;
}) {
 if (!review) return <article className="panel">{error ? <p role="alert" className="warning">{visibleText(error.message)}</p> : <><p>Loading complete review. Approval stays disabled until every byte is verified.</p><Skeleton /></>}</article>;
 const {data, content, verified} = review, input = data.input;
 const reading = data.operation === 'file.read';
 const active = status === 'pending' && data.expires_at > Date.now();
 const reason = data.operation === 'proxy.request' ? 'Every outbound request needs approval.' : data.operation === 'file.delete' ? 'Every deletion needs approval.' : data.operation === 'file.write' && input.expected_revision ? 'Replacing an existing revision needs approval.' : 'An owner rule requires review.';
 const state = status === 'pending' && !active ? 'expired' : status;
 return <article className="panel review-card"><div className="review-heading"><div><p className="eyebrow">COMPLETE REVIEW</p><h3>{visibleText(data.agent.name)} · {visibleText(data.operation)}</h3></div><span className="badge">{state}</span></div>
  <p>Task: {visibleText(data.token.label)} · created {new Date(data.created_at).toLocaleString()} · expires {new Date(data.expires_at).toLocaleString()}</p><p>{reason}</p>
  {input.path && <div className="revision-grid"><section><h4>{data.operation === 'file.delete' ? 'Delete this revision' : 'Current revision'}</h4><p>{visibleText(input.path)}</p><p>Revision: {visibleText((reading ? input.revision : input.expected_revision) || 'New file')}</p><p>SHA-256: {visibleText((reading ? input.hash : input.previous_hash) || 'None')}</p><p>Size: {(reading ? input.length : input.previous_length) ?? 0} bytes</p></section>{input.revision && !reading && <section><h4>{input.expected_revision ? 'Replacement revision' : 'New revision'}</h4><p>Revision: {visibleText(input.revision)}</p><p>SHA-256: {visibleText(input.hash || '')}</p><p>Size: {input.length} bytes</p></section>}</div>}
  {input.request && <section className="request-summary"><h4>{visibleText(input.request.method)} {visibleText(new URL(input.request.url).hostname)}</h4><p>Full path and query: {visibleText(new URL(input.request.url).pathname + new URL(input.request.url).search)}</p><p>Credential placeholder: {visibleText(input.injection_header || '')}: {input.scheme === 'bearer' ? 'Bearer ' : ''}[secret {visibleText(input.secret || '')}, value version {input.value_version}]. Only the stored key bytes are hidden.</p></section>}
  {changedHost && <p className="warning">Changed destination: selected requests using this secret have different hosts.</p>}
  {data.scope?.folders.some(g => g.prefix === '/' && (!g.expires_at || g.expires_at > Date.now())) && <p className="warning">Broad access: this agent has a root folder grant.</p>}
  <h4>Effective scope at review</h4><pre>{visibleText(JSON.stringify(data.scope, null, 2))}</pre>
  <h4>Complete action input</h4><pre>{visibleText(JSON.stringify(input, null, 2))}</pre>
  <p className="digest">Digest: {visibleText(data.digest)}</p>
  {review.error && <p role="alert" className="warning">{visibleText(review.error)}</p>}
  {content && <><ByteReview bytes={content} /><Button variant="outline" onClick={() => download(content)}><Download size={15} />Download complete content</Button></>}
  {verified && <p className="verified"><Check size={16} />Complete review data loaded and verified. Check the full request before deciding.</p>}
  <div className="actions"><Button disabled={!verified || !active || busy} onClick={() => onDecide('approve')}><Check size={16} />Approve this request</Button><Button variant="outline" disabled={!active || busy} onClick={() => onDecide('deny')}><X size={16} />Deny this request</Button><Button variant="ghost" disabled={busy} onClick={onRevoke}><ShieldAlert size={16} />Revoke this agent</Button></div>
  <p className="hint">Approval permits execution. Ready and executing are unfinished. Investigate an unknown send at its destination before submitting again.</p>
 </article>;
}
