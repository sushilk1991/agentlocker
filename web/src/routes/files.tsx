import { useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Folder, Upload } from 'lucide-react';
import type { FileEntry, FileRevision } from '../lib/api';
import { useSession } from '../lib/session';
import { hash, visibleText } from '../lib/review';
import { author, saveDownload, stamp, useOwnerTask } from '../lib/management';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { ConfirmDialog } from '../components/ui/confirm-dialog';

export default function Files() {
 const {api} = useSession(), client = useQueryClient(), task = useOwnerTask();
 const [prefix, setPrefix] = useState('/'), [target, setTarget] = useState<FileEntry>(), [history, setHistory] = useState<FileEntry>();
 const [confirm, setConfirm] = useState<{description: string; run: () => Promise<void>}>();
 const uploadForm = useRef<HTMLFormElement>(null), input = useRef<HTMLInputElement>(null);
 const files = useInfiniteQuery({queryKey: ['files', prefix], initialPageParam: null as string | null,
  queryFn: ({pageParam, signal}) => api.files(prefix, pageParam, signal), getNextPageParam: page => page.cursor ?? undefined});
 function reset() {setTarget(undefined); uploadForm.current?.reset();}
 async function changed() {await client.invalidateQueries({queryKey: ['files']});}
 async function upload(event: FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (task.busy) return;
  const form = new FormData(event.currentTarget), file = form.get('bytes') as File, path = target?.path ?? String(form.get('path'));
  await task.run(async () => {
   if (!file || file.size > 10 * 1024 * 1024) throw new Error('Choose a file of at most 10 MiB.');
   const bytes = new Uint8Array(await file.arrayBuffer()), digest = await hash(bytes);
   if (!api.active) return;
   const work = async () => {
    const result = await api.upload(path, bytes, file.type || 'application/octet-stream', target?.revision, digest);
    if (!api.active) return;
    reset(); setHistory(undefined); await changed(); return 'File saved at revision ' + result.result_revision + '.';
   };
   if (target) setConfirm({description: `Replace ${visibleText(path)} at exactly revision ${target.revision}? Current SHA-256: ${target.hash}. New file: ${bytes.length} bytes. New SHA-256: ${digest}`, run: async () => {await task.run(work);}});
   else return work();
  });
 }
 function remove(file: FileEntry) {
  setConfirm({description: `Delete ${visibleText(file.path)} at exactly revision ${file.revision}? SHA-256: ${file.hash}. Retained content can be restored until its deadline.`, run: async () => {await task.run(async () => {
   await api.deleteFile(file); if (!api.active) return;
   if (target?.path === file.path) reset(); setHistory({...file, deleted_at: Date.now()}); await changed();
   return 'File deleted. Its tombstone and retained revisions are shown.';
  });}});
 }
 function restore(file: FileEntry, revision: FileRevision) {
  setConfirm({description: `Restore ${visibleText(file.path)} from revision ${revision.revision}? SHA-256: ${revision.hash}. Replace exactly ${file.revision}${file.deleted_at ? ' (tombstone)' : ''}. This creates a new owner revision.`, run: async () => {await task.run(async () => {
   const result = await api.restore(revision.revision, file.revision); if (!api.active) return;
   if (target?.path === file.path) reset(); setHistory({...file, revision: result.result_revision, deleted_at: null}); await changed();
   return 'File restored as revision ' + result.result_revision + '.';
  });}});
 }
 const download = (file: FileEntry, revision?: string) => void task.run(async () => {const blob = await api.fileDownload(file.path, revision); if (api.active) saveDownload(blob, file.path.split('/').pop()!);});
 return <>
  <p className="page-description">Browse current files and tombstones. Retained versions count toward your quota.</p>
  <form id="file-filter" className="panel inline-form" onSubmit={event => {event.preventDefault(); const next = String(new FormData(event.currentTarget).get('prefix')); if (next === prefix) void files.refetch(); else setPrefix(next);}}>
   <div><label htmlFor="file-prefix">Folder prefix</label><input id="file-prefix" name="prefix" defaultValue="/" required /></div><Button disabled={task.busy}>Browse files</Button>
  </form>
  <form ref={uploadForm} id="file-upload" className="panel" onSubmit={upload}>
   <h2>{target ? 'Replace a file' : 'Upload a new file'}</h2><label htmlFor="upload-path">File path</label><input id="upload-path" name="path" key={target?.path ?? 'new'} defaultValue={target?.path ?? ''} readOnly={!!target} required placeholder="/work/notes.txt" />
   <p id="file-precondition" className="hint">{target ? `Replace only revision ${target.revision}. Current SHA-256: ${target.hash}. The new bytes will be hashed before confirmation.` : 'Create only. An existing path will be rejected.'}</p>
   <label htmlFor="upload-bytes">File to upload</label><input ref={input} id="upload-bytes" name="bytes" type="file" required /><p className="hint">Up to 10 MiB. Downloads preserve bytes. Uploaded HTML is never displayed as a page.</p>
   <div className="actions"><Button disabled={task.busy}><Upload size={16} />Upload file</Button>{target && <Button type="button" variant="outline" disabled={task.busy} onClick={reset}>Upload a new file</Button>}</div>
  </form>
  <p id="notice" role="status" className={task.error ? 'warning' : 'management-notice'}>{task.error || task.message}</p>
  {files.isPending && <Skeleton />}{files.error && <p role="alert" className="warning">{visibleText(files.error.message)} <Button variant="outline" onClick={() => void files.refetch()}>Reload files</Button></p>}
  <div id="file-list" className="management-list">{files.data?.pages.flatMap(page => page.files).map(file => <article className="panel" key={file.path}>
   <div className="review-heading"><h3>{visibleText(file.path)}</h3><Badge variant={file.deleted_at ? 'secondary' : 'default'}>{file.deleted_at ? 'Deleted' : 'Current'}</Badge></div>
   <p>{file.deleted_at ? 'Deleted · ' + stamp(file.deleted_at) : 'Modified · ' + stamp(file.modified_at)}</p>
   <pre>{`Revision: ${file.revision}\n${file.length ?? 0} bytes · ${visibleText(file.media_type ?? 'content expired')}\nSHA-256: ${file.hash ?? 'content expired'}\nAuthor: ${author(file)}`}</pre>
   <div className="actions">{!file.deleted_at && <><Button variant="outline" disabled={task.busy} onClick={() => download(file)}>Download file</Button><Button variant="outline" disabled={task.busy} onClick={() => {setTarget({...file}); if (input.current) {input.current.value = ''; input.current.focus();}}}>Replace file</Button><Button variant="destructive" disabled={task.busy} onClick={() => remove(file)}>Delete file</Button></>}
    <Button variant="outline" disabled={task.busy} onClick={() => setHistory({...file})}>Revisions and restore</Button></div>
  </article>)}</div>
  {files.data?.pages[0].files.length === 0 && <section className="panel empty"><Folder size={28} /><h2>No files in this folder</h2><p>Upload a file or browse another folder prefix.</p></section>}
  {files.hasNextPage && <Button variant="outline" disabled={files.isFetchingNextPage} onClick={() => void files.fetchNextPage()}>More files</Button>}
  {history && <History key={history.path + history.revision + history.deleted_at} file={history} busy={task.busy} restore={revision => restore(history, revision)} download={revision => download(history, revision)} />}
  {confirm && <ConfirmDialog description={confirm.description} onCancel={() => setConfirm(undefined)} onConfirm={() => {const action = confirm.run; setConfirm(undefined); void action();}} />}
 </>;
}
function History({file, busy, restore, download}: {file: FileEntry; busy: boolean; restore: (revision: FileRevision) => void; download: (revision: string) => void}) {
 const {api} = useSession();
 const list = useInfiniteQuery({queryKey: ['revisions', file.path, file.revision, file.deleted_at], initialPageParam: null as string | null,
  queryFn: ({pageParam, signal}) => api.revisions(file.path, pageParam, signal), getNextPageParam: page => page.cursor ?? undefined});
 return <section id="file-history" className="panel"><h2>Revisions of {visibleText(file.path)}</h2><p>Current path precondition: {file.revision}{file.deleted_at ? ' (tombstone)' : ''}. Restore creates a new owner revision.</p>
  {list.isPending && <Skeleton />}{list.error && <p role="alert" className="warning">{visibleText(list.error.message)} <Button onClick={() => void list.refetch()}>Reload revisions</Button></p>}
  {list.data?.pages[0].revisions.length === 0 && <p>No retained content remains. The tombstone still keeps this path.</p>}
  {list.data?.pages.flatMap(page => page.revisions).map(revision => <section className="revision-card" key={revision.revision}><h3>{revision.revision}</h3>
   <pre>{`${revision.current ? 'Current revision' : 'Retained revision'} · ${stamp(revision.created_at)}\n${revision.length} bytes · ${visibleText(revision.media_type ?? '')}\nSHA-256: ${revision.hash}\nAuthor: ${author(revision)}\nRestore deadline: ${revision.restore_deadline ? stamp(revision.restore_deadline) : 'None while current'}`}</pre>
   <div className="actions"><Button variant="outline" disabled={busy} onClick={() => download(revision.revision)}>Download revision</Button>{!revision.current && <Button variant="outline" disabled={busy || (revision.restore_deadline !== null && revision.restore_deadline <= Date.now())} onClick={() => restore(revision)}>Restore revision</Button>}</div>
  </section>)}
  {list.hasNextPage && <Button variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>More revisions</Button>}
 </section>;
}
