import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
export function Textarea({className,...props}:ComponentProps<'textarea'>) {
  return <textarea className={cn('min-h-24 w-full rounded-lg border bg-background p-3 text-base leading-6 focus-visible:outline focus-visible:outline-ring disabled:opacity-60',className)} {...props} />;
}
