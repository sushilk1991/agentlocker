import { AgentLockerError, HttpClient } from '@agentlocker/sdk';
import { createHash } from 'node:crypto';
export interface Review {
 id: string; approval_id: string; digest: string; status: string; operation: string;
 input: Record<string, any>; digest_context: {config_version: number; agent_id: string | null; token_id: string | null};
 [key: string]: unknown;
}
export interface ReviewFile { format: 'agentlocker-review-v1'; origin: string; review: Review; content_base64?: string }
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function canonical(value: any): string {
 if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
 if (value !== null && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
 return JSON.stringify(value);
}
const fail = () => { throw new AgentLockerError('review_mismatch', 0, 'Complete review data or hashes do not match. Load a new review before deciding.'); };
export function verifyReview(file: ReviewFile, origin: string, id: string) {
 if (file.format !== 'agentlocker-review-v1' || file.origin !== origin || file.review?.approval_id !== id) fail();
 const { review: r } = file;
 if (!r.input || !r.digest_context || hash(canonical({input: r.input, ...r.digest_context})) !== r.digest) fail();
 const input = r.input;
 if (input.request) {
  const bytes = Buffer.from(input.request.body_base64, 'base64');
  if (hash(bytes) !== input.request.body_hash || file.content_base64 !== bytes.toString('base64')) fail();
 } else if (input.revision || input.expected_revision) {
  if (typeof file.content_base64 !== 'string') fail();
  const bytes = Buffer.from(file.content_base64!, 'base64');
  if (bytes.toString('base64') !== file.content_base64 || hash(bytes) !== (input.revision ? input.hash : input.previous_hash) || bytes.length !== (input.revision ? input.length : input.previous_length)) fail();
 }
 return r;
}
export async function loadReview(http: HttpClient, id: string, signal?: AbortSignal): Promise<ReviewFile> {
 const review = await http.json<Review>('/api/v1/owner/approvals/' + encodeURIComponent(id), undefined, {signal});
 const file: ReviewFile = {format: 'agentlocker-review-v1', origin: http.base_url, review};
 if (review.input.request) file.content_base64 = review.input.request.body_base64;
 else if (review.input.revision || review.input.expected_revision) {
  const response = await http.request('/api/v1/owner/approvals/' + encodeURIComponent(id) + '/content', undefined, {signal});
  file.content_base64 = Buffer.from(await response.arrayBuffer()).toString('base64');
 }
 verifyReview(file, http.base_url, id);
 return file;
}
