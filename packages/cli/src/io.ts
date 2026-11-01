import { createWriteStream } from 'node:fs';
import { link, rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Download } from '@agentlocker/sdk';

/** Publish a complete download atomically. link() enforces no overwrite at commit. */
export async function saveStream(file: string, body: ReadableStream<Uint8Array> | null, force = false) {
 const temporary = file + '.agentlocker-' + crypto.randomUUID() + '.tmp';
 try {
  const source = body ? Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]) : Readable.from([]);
  await pipeline(source, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
  if (force) await rename(temporary, file); else await link(temporary, file);
 } finally { await rm(temporary, { force: true }); }
}
export async function saveDownload(file: string, download: Download, force = false) {
 await saveStream(file, download.body, force);
 return { output: file, request_id: download.request_id, revision: download.revision, hash: download.hash };
}
export function safeJson(value: unknown, pretty = false) {
 return JSON.stringify(value, null, pretty ? 2 : undefined).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
  value => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'));
}
