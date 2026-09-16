import { useId } from 'react';
import { cn } from '@/lib/utils';

/**
 * The Veneer brand mark: a slightly bowed rectangular panel with a "V" knocked
 * out of it. Monochrome — the panel is `fill="currentColor"` and the V is a
 * mask cutout, so it inherits color from whatever it sits on and themes
 * correctly in light and dark. Source of truth is Veneer Studio's header mark
 * (mirrored in web/public/icons/veneer-mark.svg).
 *
 * viewBox is 200×260 (taller than wide); it centers within a square box, so
 * pass a square sizing class (e.g. `size-6`) and it letterboxes cleanly.
 *
 * The mask id is per-instance (useId) so multiple marks on one page don't
 * collide on a shared `url(#…)` reference.
 */
export function VeneerMark({ className }: { className?: string }) {
  const maskId = useId();
  return (
    <svg viewBox="0 0 200 260" fill="none" role="img" aria-label="Veneer" className={cn('inline-block', className)}>
      <defs>
        <mask id={maskId}>
          <rect width="200" height="260" fill="white" />
          <path
            d="M70 90 L100 180 L130 90"
            fill="none"
            stroke="black"
            strokeWidth="22"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </mask>
      </defs>
      <path
        d="M14 8 C60 4, 140 4, 186 8 C198 70, 198 190, 186 252 C140 256, 60 256, 14 252 C2 190, 2 70, 14 8 Z"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}
