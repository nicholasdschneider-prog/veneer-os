import { MODEL_TIER_MAX } from '@/lib/modelTier';
import { cn } from '@/lib/utils';

/** Four dots, `tier` of them filled: an at-a-glance model capability hint. */
export function CapabilityDots({ tier, className }: { tier: number | null; className?: string }) {
  if (tier === null) return null;
  return (
    <span
      className={cn('flex shrink-0 items-center gap-[3px]', className)}
      role="img"
      aria-label={`Capability ${tier} of ${MODEL_TIER_MAX}`}
    >
      {Array.from({ length: MODEL_TIER_MAX }, (_, index) => (
        <span
          key={index}
          className={cn(
            'size-1.5 rounded-full',
            index < tier ? 'bg-foreground' : 'bg-foreground/15',
          )}
        />
      ))}
    </span>
  );
}
