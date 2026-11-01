import { useMemo, useState } from 'react';
import { base64, visibleText } from '../lib/review';
const size = 48 * 1024;
function Section({label, start, end, length, index, render}: {label: string; start: number; end: number; length: number; index: number; render: (start: number, end: number) => string}) {
 const [opened, setOpened] = useState(false);
 return <details onToggle={event => {if (event.currentTarget.open) setOpened(true);}}><summary>Section {index} of {Math.ceil(length / size)} · {label === 'Base64' ? 'bytes' : 'text positions'} {start + 1}–{end} of {length}</summary>{opened && <pre>{visibleText(render(start, end))}</pre>}</details>;
}
function Parts({label, length, render}: {label: string; length: number; render: (start: number, end: number) => string}) {
 if (length <= size) return <pre>{visibleText(render(0, length))}</pre>;
 return <details><summary>{label}: all {Math.ceil(length / size)} sections, including the final bytes</summary>{Array.from({length: Math.ceil(length / size)}, (_, i) => <Section key={i} label={label} start={i * size} end={Math.min((i + 1) * size, length)} length={length} index={i + 1} render={render} />)}</details>;
}
export function ByteReview({bytes}: {bytes: Uint8Array}) {
 const text = useMemo(() => {try {return new TextDecoder('utf-8', {fatal: true}).decode(bytes);} catch {return null;}}, [bytes]);
 return <div className="byte-review"><p>{bytes.length.toLocaleString()} bytes · complete base64 (lossless)</p><Parts label="Base64" length={bytes.length} render={(start, end) => base64(bytes.subarray(start, end))} />
  {text === null ? <p>Binary content. Use the base64 above or download the bytes.</p> : <><p>Complete UTF-8 text. Control and direction markers appear as escaped codes.</p><Parts label="UTF-8 text" length={text.length} render={(start, end) => {
   if (start && /[\uDC00-\uDFFF]/.test(text[start])) start--;
   if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
   return text.slice(start, end);
  }} /></>}
 </div>;
}
