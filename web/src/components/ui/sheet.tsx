import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';
export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export function SheetContent({children}: {children: ReactNode}) {
 return <Dialog.Portal><Dialog.Overlay className="overlay" /><Dialog.Content className="sheet">
  <Dialog.Title className="sr-only">Workspace navigation</Dialog.Title><Dialog.Description className="sr-only">Choose a page in your locker.</Dialog.Description>
  <Dialog.Close asChild><Button variant="ghost" className="sheet-close" aria-label="Close navigation"><X size={20} /></Button></Dialog.Close>{children}
 </Dialog.Content></Dialog.Portal>;
}
