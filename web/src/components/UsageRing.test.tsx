import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  RING_STROKE,
  UsageRing,
  ringCircumference,
  ringDashOffset,
  ringFillClass,
  ringRadius,
  ringTone,
} from './UsageRing';

describe('usage ring geometry', () => {
  it('insets the arc by a full stroke so it never clips the box', () => {
    expect(ringRadius(44)).toBe(22 - RING_STROKE);
    expect(ringRadius(38)).toBe(19 - RING_STROKE);
  });

  it('maps used percent onto the dash offset: empty at 0, closed at 100', () => {
    const circumference = ringCircumference(44);
    expect(ringDashOffset(0, 44)).toBeCloseTo(circumference, 6);
    expect(ringDashOffset(50, 44)).toBeCloseTo(circumference / 2, 6);
    expect(ringDashOffset(100, 44)).toBeCloseTo(0, 6);
  });

  it('clamps out-of-range and non-numeric readings rather than overdrawing', () => {
    const circumference = ringCircumference(38);
    expect(ringDashOffset(140, 38)).toBeCloseTo(0, 6);
    expect(ringDashOffset(-20, 38)).toBeCloseTo(circumference, 6);
    expect(ringDashOffset(Number.NaN, 38)).toBeCloseTo(circumference, 6);
  });
});

describe('usage ring tone', () => {
  it('warns from 80% and goes destructive at the limit', () => {
    expect(ringTone(0, false)).toBe('normal');
    expect(ringTone(79.9, false)).toBe('normal');
    expect(ringTone(80, false)).toBe('warn');
    expect(ringTone(99, false)).toBe('warn');
    expect(ringTone(100, false)).toBe('critical');
    expect(ringTone(120, false)).toBe('critical');
  });

  it('goes muted and dashed only when there is no reading at all', () => {
    expect(ringTone(95, true)).toBe('unknown');
    expect(ringTone(0, true)).toBe('unknown');
    expect(ringFillClass('unknown')).toContain('stroke-dasharray');
    expect(ringFillClass('unknown')).toContain('stroke-muted-foreground');
  });

  it('paints each band from a theme token, never a literal colour', () => {
    expect(ringFillClass('normal')).toBe('stroke-brand');
    expect(ringFillClass('warn')).toBe('stroke-amber-500');
    expect(ringFillClass('critical')).toBe('stroke-destructive');
  });
});

describe('UsageRing render', () => {
  it('draws a rotated track + fill pair with the brand mark and window label', () => {
    const html = renderToStaticMarkup(
      <UsageRing
        provider="claude"
        percent={42}
        label="5hr"
        ariaLabel="Claude · Pro · 42% of 5hr used. Open usage settings."
        onActivate={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Claude · Pro · 42% of 5hr used. Open usage settings."');
    expect(html).toContain('-rotate-90');
    expect(html).toContain('stroke-border');
    expect(html).toContain('stroke-brand');
    expect(html).toContain(`stroke-dashoffset="${ringDashOffset(42, 44)}"`);
    expect(html).toContain('data-usage-tone="normal"');
    expect(html).toContain('>5hr<');
  });

  it('marks an unknown reading dashed and drops the label when asked', () => {
    const html = renderToStaticMarkup(
      <UsageRing
        provider="codex"
        percent={63}
        label="week"
        unknown
        showLabel={false}
        dimmed
        size={38}
        ariaLabel="Codex · 63% of week used. Open usage settings."
        onActivate={() => {}}
      />,
    );

    expect(html).toContain('data-usage-tone="unknown"');
    expect(html).toContain('stroke-dasharray:2_3');
    expect(html).toContain('opacity-55');
    expect(html).not.toContain('>week<');
    expect(html).toContain('viewBox="0 0 38 38"');
  });
});
