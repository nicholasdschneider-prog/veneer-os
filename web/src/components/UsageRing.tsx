import { cn } from '@/lib/utils';
import { ProviderIcon } from './ProviderIcon';

/**
 * The subscription usage ring that lives at the foot of the desktop rail and in
 * the mobile bottom bar. A track circle plus a fill arc drawn with
 * stroke-dasharray/offset and rotated -90deg so it starts at twelve o'clock;
 * the provider's brand mark sits in the middle, with a tiny window label
 * ("5hr" for Claude's five-hour window, "week" for Codex's weekly) beneath.
 *
 * Fill = percentage USED, so a filling ring reads as headroom running out.
 * Colours are theme tokens, never literals: brand below 80%, amber from 80%,
 * destructive at 100%, and a dashed muted arc only when there is no reading
 * (older than five minutes, or missing entirely) — an honest "we don't know"
 * rather than a confident wrong number.
 */

/** Stroke width in user units; also the inset that keeps the arc off the edge. */
export const RING_STROKE = 3;

export type RingTone = 'normal' | 'warn' | 'critical' | 'unknown';

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}

/** Radius for a square ring of `size` px: half, less a full stroke of inset. */
export function ringRadius(size: number): number {
  return size / 2 - RING_STROKE;
}

export function ringCircumference(size: number): number {
  return 2 * Math.PI * ringRadius(size);
}

/**
 * Dash offset for a used percentage: the whole circumference at 0% (nothing
 * drawn) down to 0 at 100% (a full ring). Values outside 0…100 clamp.
 */
export function ringDashOffset(percent: number, size: number): number {
  return ringCircumference(size) * (1 - clampPercent(percent) / 100);
}

/**
 * Colour band for a reading. An old reading keeps its last known colour (it is
 * most likely still right); only a reading we never had at all goes muted.
 */
export function ringTone(percent: number, unknown: boolean): RingTone {
  if (unknown) return 'unknown';
  if (percent >= 100) return 'critical';
  if (percent >= 80) return 'warn';
  return 'normal';
}

/** Tailwind classes for the fill arc of a tone (theme tokens, light + dark). */
export function ringFillClass(tone: RingTone): string {
  if (tone === 'unknown') return 'stroke-muted-foreground/70 [stroke-dasharray:2_3]';
  if (tone === 'critical') return 'stroke-destructive';
  if (tone === 'warn') return 'stroke-amber-500';
  return 'stroke-brand';
}

export function UsageRing({
  provider,
  percent,
  label,
  ariaLabel,
  onActivate,
  unknown = false,
  dimmed = false,
  size = 44,
  showLabel = true,
  className,
}: {
  provider: 'claude' | 'codex';
  /** Percentage of the window USED (0…100); clamped for drawing. */
  percent: number;
  /** Window shorthand under the ring: "5hr", "week". */
  label: string;
  /** Full sentence for screen readers — same text the tooltip shows. */
  ariaLabel: string;
  onActivate: () => void;
  /** Snapshot older than five minutes (or absent): dashed, muted. */
  /** No reading at all for this window (not merely an old one). */
  unknown?: boolean;
  /** The other provider while a chat of this one's is open. */
  dimmed?: boolean;
  size?: number;
  showLabel?: boolean;
  className?: string;
}) {
  const tone = ringTone(percent, unknown);
  const radius = ringRadius(size);
  const circumference = ringCircumference(size);
  const centre = size / 2;
  // Literal classes (not an interpolated arbitrary value) so Tailwind's scanner
  // can see them; the two call sites are the 44px rail and the 38px mobile bar.
  const glyphClass = size >= 44 ? 'size-[18px]' : 'size-[15px]';

  return (
    <button
      type="button"
      onPointerUp={onActivate}
      aria-label={ariaLabel}
      data-usage-ring={provider}
      data-usage-tone={tone}
      className={cn(
        'flex flex-none flex-col items-center gap-1 transition-opacity',
        dimmed && 'opacity-55',
        className,
      )}
    >
      <span className="relative block" style={{ width: size, height: size }}>
        <svg
          viewBox={`0 0 ${size} ${size}`}
          aria-hidden="true"
          className="absolute inset-0 -rotate-90"
        >
          <circle
            cx={centre}
            cy={centre}
            r={radius}
            fill="none"
            strokeWidth={RING_STROKE}
            className="stroke-border"
          />
          <circle
            cx={centre}
            cy={centre}
            r={radius}
            fill="none"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={ringDashOffset(percent, size)}
            className={cn('transition-[stroke-dashoffset] duration-500', ringFillClass(tone))}
          />
        </svg>
        <span className="absolute inset-0 grid place-items-center">
          <ProviderIcon provider={provider} variant="color" className={glyphClass} />
        </span>
      </span>
      {showLabel ? (
        <span className="text-[0.625rem] leading-none tracking-tight text-muted-foreground">{label}</span>
      ) : null}
    </button>
  );
}
