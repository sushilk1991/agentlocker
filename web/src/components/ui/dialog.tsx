import { useRef, type ComponentProps } from 'react';
import * as Primitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from './button';
import { cn } from '../../lib/utils';
export const Dialog = Primitive.Root;
export const DialogTitle = Primitive.Title;
export const DialogDescription = Primitive.Description;
export function DialogContent({className, children, busy = false, ...props}: ComponentProps<typeof Primitive.Content> & {busy?: boolean}) {
 const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
 return <Primitive.Portal><Primitive.Overlay className="overlay" /><Primitive.Content data-slot="dialog-content" className={cn('content-dialog', className)} onCloseAutoFocus={event => {event.preventDefault(); const target = opener.current; (target?.isConnected ? target : document.getElementById('main'))?.focus();}} onEscapeKeyDown={event => {if (busy) event.preventDefault();}} onPointerDownOutside={event => {if (busy) event.preventDefault();}} {...props}>
  {children}<Primitive.Close asChild><Button type="button" variant="ghost" className="dialog-close" aria-label="Close dialog" disabled={busy}><X size={18} /></Button></Primitive.Close>
 </Primitive.Content></Primitive.Portal>;
}
