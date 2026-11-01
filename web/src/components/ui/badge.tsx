import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
const variants = cva('badge', {variants: {variant: {default: 'badge-default', secondary: 'badge-secondary', destructive: 'badge-destructive', outline: 'badge-outline'}}, defaultVariants: {variant: 'secondary'}});
export function Badge({className, variant, ...props}: ComponentProps<'span'> & VariantProps<typeof variants>) {
 return <span data-slot="badge" className={cn(variants({variant}), className)} {...props} />;
}
