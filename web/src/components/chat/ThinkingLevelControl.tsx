import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

export function effortLabel(level: string): string {
  return level === 'xhigh' ? 'XHigh' : capitalize(level);
}

/** Keyboard step for a radiogroup: arrows move one stop, Home/End jump. */
export function nextLevelIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return Math.min(count - 1, index + 1);
    case 'ArrowLeft':
    case 'ArrowDown':
      return Math.max(0, index - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** Which stop a pointer x-position lands on, for drag across the track. */
export function levelIndexAt(x: number, left: number, width: number, count: number): number {
  if (width <= 0) return 0;
  const rel = (x - left) / width;
  return Math.max(0, Math.min(count - 1, Math.floor(rel * count)));
}

/**
 * Thinking level as a sliding segmented control: equal-width stops with one
 * dark pill that slides to the pick. Tap a stop, drag across the track, or
 * use arrow keys. `levels` includes '' for the provider default first.
 */
export function ThinkingLevelControl({
  levels,
  value,
  onChange,
  className,
}: {
  levels: string[];
  value: string;
  onChange: (level: string) => void;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const count = levels.length;
  const selectedIndex = Math.max(0, levels.indexOf(value));

  const pickAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    // The 3px padding on the track is excluded so the first/last stops are
    // hit exactly at the pill edges.
    const index = levelIndexAt(clientX, rect.left + 3, rect.width - 6, count);
    if (index !== selectedIndex) onChange(levels[index]!);
  };

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label="Thinking level"
      className={cn(
        'relative grid select-none touch-none rounded-xl bg-muted p-[3px]',
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        pickAt(event.clientX);
      }}
      onPointerMove={(event) => {
        if (dragging) pickAt(event.clientX);
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={(event) => {
        const next = nextLevelIndex(event.key, selectedIndex, count);
        if (next === null) return;
        event.preventDefault();
        if (next !== selectedIndex) onChange(levels[next]!);
      }}
    >
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-[3px] left-[3px] rounded-[9px] bg-foreground shadow-sm',
          dragging ? '' : 'transition-transform duration-200 ease-out',
        )}
        style={{
          width: `calc((100% - 6px) / ${count})`,
          transform: `translateX(${selectedIndex * 100}%)`,
        }}
      />
      {levels.map((level, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={level || 'default'}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={cn(
              'relative z-10 rounded-[9px] px-0.5 py-2 text-[11px] font-medium transition-colors',
              selected ? 'text-background' : 'text-muted-foreground',
            )}
          >
            {level ? effortLabel(level) : 'Default'}
          </button>
        );
      })}
    </div>
  );
}
