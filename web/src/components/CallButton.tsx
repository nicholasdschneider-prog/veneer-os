import type { ComponentProps } from 'react';
import { AudioLines } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Shared live-call affordance; playback, dictation and ending a call are distinct. */
export function CallIcon({ className }: { className?: string }) {
  return <AudioLines aria-hidden="true" className={cn('size-5 shrink-0', className)} />;
}

export function CallButton({ children, className, type = 'button', ...props }: ComponentProps<'button'>) {
  return <button type={type} className={cn(
    'inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-2 rounded-full bg-blue-600 text-white hover:bg-blue-500 active:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40',
    children ? 'px-4 text-sm font-medium' : 'size-[44px]', className,
  )} {...props}><CallIcon />{children}</button>;
}
