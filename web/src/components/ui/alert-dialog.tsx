import type { ComponentProps } from 'react';
import * as Primitive from '@radix-ui/react-alert-dialog';
import { cn } from '../../lib/utils';

export const AlertDialog = Primitive.Root;
export const AlertDialogTitle = Primitive.Title;
export const AlertDialogDescription = Primitive.Description;
export const AlertDialogCancel = Primitive.Cancel;
export const AlertDialogAction = Primitive.Action;
export function AlertDialogContent({className, ...props}: ComponentProps<typeof Primitive.Content>) {
 return <Primitive.Portal><Primitive.Overlay className="overlay alert-overlay" /><Primitive.Content data-slot="alert-dialog-content" className={cn('confirm-dialog', className)} {...props} /></Primitive.Portal>;
}
