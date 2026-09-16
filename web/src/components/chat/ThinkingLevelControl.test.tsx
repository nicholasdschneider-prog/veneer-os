import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { levelIndexAt, nextLevelIndex, ThinkingLevelControl } from './ThinkingLevelControl';

const LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

describe('ThinkingLevelControl', () => {
  it('renders one radio per level with the pick checked and focusable', () => {
    const html = renderToStaticMarkup(
      <ThinkingLevelControl levels={LEVELS} value="high" onChange={() => undefined} />,
    );

    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)).toHaveLength(6);
    expect(html).toContain('aria-checked="true" tabindex="0"');
    expect(html.match(/aria-checked="false" tabindex="-1"/g)).toHaveLength(5);
    expect(html).toContain('>Default<');
    expect(html).toContain('>XHigh<');
  });

  it('slides the pill to the picked stop', () => {
    const html = renderToStaticMarkup(
      <ThinkingLevelControl levels={LEVELS} value="high" onChange={() => undefined} />,
    );

    expect(html).toContain('translateX(300%)');
    expect(html).toContain('calc((100% - 6px) / 6)');
  });

  it('treats an unknown value as the default stop', () => {
    const html = renderToStaticMarkup(
      <ThinkingLevelControl levels={LEVELS} value="ultra" onChange={() => undefined} />,
    );

    expect(html).toContain('translateX(0%)');
  });
});

describe('nextLevelIndex', () => {
  it('steps with arrows and clamps at the ends', () => {
    expect(nextLevelIndex('ArrowRight', 2, 6)).toBe(3);
    expect(nextLevelIndex('ArrowLeft', 2, 6)).toBe(1);
    expect(nextLevelIndex('ArrowRight', 5, 6)).toBe(5);
    expect(nextLevelIndex('ArrowLeft', 0, 6)).toBe(0);
  });

  it('jumps with Home/End and ignores other keys', () => {
    expect(nextLevelIndex('Home', 4, 6)).toBe(0);
    expect(nextLevelIndex('End', 1, 6)).toBe(5);
    expect(nextLevelIndex('Enter', 1, 6)).toBeNull();
  });
});

describe('levelIndexAt', () => {
  it('maps a pointer position to its stop and clamps outside the track', () => {
    expect(levelIndexAt(10, 0, 600, 6)).toBe(0);
    expect(levelIndexAt(350, 0, 600, 6)).toBe(3);
    expect(levelIndexAt(599, 0, 600, 6)).toBe(5);
    expect(levelIndexAt(-50, 0, 600, 6)).toBe(0);
    expect(levelIndexAt(900, 0, 600, 6)).toBe(5);
    expect(levelIndexAt(10, 0, 0, 6)).toBe(0);
  });
});
