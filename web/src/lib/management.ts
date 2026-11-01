import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from './session';
import { visibleText } from './review';

export const stamp = (value: number | null) => value ? new Date(value).toLocaleString() : 'None';
export const author = (file: {author_kind: string | null; agent_id: string | null; token_id: string | null}) => file.author_kind === 'owner' ? 'Owner' : `Agent ${file.agent_id ?? 'unknown'} · token ${file.token_id ?? 'unknown'}`;
export function saveDownload(blob: Blob, name: string) {
 // All content, including uploaded HTML, stays an attachment. Never preview it.
 const url = URL.createObjectURL(new Blob([blob], {type: 'application/octet-stream'}));
 const link = document.createElement('a'); link.href = url; link.download = name; link.click();
 setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function useOwnerTask() {
 const {api} = useSession(), client = useQueryClient();
 const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
 async function run(work: () => Promise<string | void>) {
  if (busy || !api.active) return false;
  setBusy(true); setError(''); setMessage('');
  try {
   const text = await work(); if (!api.active) return false;
   setMessage(text ?? ''); void client.invalidateQueries({queryKey: ['overview']}); return true;
  } catch (error) {
   if (api.active) setError(visibleText(error instanceof Error ? error.message : 'The request failed.'));
   return false;
  } finally {if (api.active) setBusy(false);}
 }
 return {busy, error, message, run};
}
