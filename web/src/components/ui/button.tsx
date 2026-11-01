import type { ComponentProps } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
const variants = cva('button', {variants: {variant: {default: 'button-primary', outline: 'button-outline', ghost: 'button-ghost', destructive: 'button-destructive'}}, defaultVariants: {variant: 'default'}});
export function Button({className, variant, asChild, ...props}: ComponentProps<'button'> & VariantProps<typeof variants> & {asChild?: boolean}) {
 const Comp = asChild ? Slot : 'button';
 return <Comp data-slot="button" className={cn(variants({variant}), className)} {...props} />;
}
