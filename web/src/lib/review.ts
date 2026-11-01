import type { OwnerApi, Review } from './api';
export const visibleText = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
export function canonical(value: unknown): string {
 if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
 if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
 return JSON.stringify(value);
}
export async function hash(bytes: Uint8Array) {
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), b => b.toString(16).padStart(2, '0')).join('');
}
export function base64(bytes: Uint8Array) {
 let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text);
}
export interface LoadedReview { data: Review; content?: Uint8Array; verified: boolean; error?: string }
export async function loadReview(api: OwnerApi, id: string, signal: AbortSignal): Promise<LoadedReview> {
 const data = await api.review(id, signal);
 try {
  const computed = await hash(new TextEncoder().encode(canonical({input: data.input, ...data.digest_context})));
  if (computed !== data.digest) throw new Error('Action digest does not match. Approval is blocked.');
  const input = data.input;
  let content: Uint8Array | undefined;
  if (input.request) {
   content = Uint8Array.from(atob(input.request.body_base64), c => c.charCodeAt(0));
   if (content.length > 64 * 1024 || await hash(content) !== input.request.body_hash) throw new Error('Body hash does not match. Approval is blocked.');
  } else if (input.revision || input.expected_revision) {
   content = await api.content(id, signal);
   if (content.length > 10 * 1024 * 1024 || content.length !== (input.revision ? input.length : input.previous_length) || await hash(content) !== (input.revision ? input.hash : input.previous_hash)) throw new Error('File bytes do not match the reviewed revision. Approval is blocked.');
  }
  signal.throwIfAborted(); return {data, content, verified: true};
 } catch (error) {
  signal.throwIfAborted(); return {data, verified: false, error: error instanceof Error ? error.message : 'Review failed. Approval is blocked.'};
 }
}
export function download(bytes: Uint8Array) {
 const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
 const link = document.createElement('a'); link.href = url; link.download = 'approval-content.bin'; link.click();
 setTimeout(() => URL.revokeObjectURL(url), 1000);
}
