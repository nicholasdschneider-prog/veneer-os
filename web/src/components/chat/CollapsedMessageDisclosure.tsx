import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function CollapsedMessageDisclosure({
  summary,
  summaryClassName,
  children,
  className,
  ...props
}: Omit<ComponentProps<'details'>, 'open'> & {
  summary: ReactNode;
  summaryClassName?: string;
}) {
  return (
    <details
      data-collapsed-message-disclosure
      className={cn('group/message-disclosure min-w-0', className)}
      {...props}
    >
      <summary
        className={cn(
          'relative flex w-full min-w-0 cursor-pointer list-none items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring after:absolute after:top-1/2 after:left-1/2 after:size-[max(100%,3rem)] after:-translate-1/2 pointer-fine:after:hidden [&::-webkit-details-marker]:hidden',
          summaryClassName,
        )}
      >
        {summary}
      </summary>
      {children}
    </details>
  );
}
