import { cn } from '@/lib/utils';

interface CreatorAvatarProps {
  name: string;
  className?: string;
  ariaLabel?: string;
}

export function CreatorAvatar({ name, className, ariaLabel }: CreatorAvatarProps) {
  const initial = name.trim().charAt(0).toLocaleUpperCase() || '?';

  return (
    <span
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      role={ariaLabel ? 'img' : undefined}
      title={`Created by ${name}`}
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[11px] font-semibold text-brand',
        className,
      )}
    >
      {initial}
    </span>
  );
}
