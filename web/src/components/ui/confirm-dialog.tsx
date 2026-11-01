import { useRef } from 'react';
import { Button } from './button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from './alert-dialog';
export function ConfirmDialog({description, onConfirm, onCancel}: {description: string; onConfirm: () => void; onCancel: () => void}) {
 const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
 return <AlertDialog open onOpenChange={open => {if (!open) onCancel();}}><AlertDialogContent onCloseAutoFocus={event => {event.preventDefault(); if (opener.current?.isConnected) opener.current.focus();}}>
  <AlertDialogTitle>Confirm your decision</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription>
  <div className="actions"><AlertDialogCancel asChild><Button variant="outline" onClick={onCancel}>Cancel</Button></AlertDialogCancel><AlertDialogAction asChild><Button onClick={onConfirm}>Confirm decision</Button></AlertDialogAction></div>
 </AlertDialogContent></AlertDialog>;
}
