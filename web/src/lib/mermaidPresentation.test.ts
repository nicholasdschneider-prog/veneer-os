import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  MERMAID_CHART_SELECTOR,
  isMermaidChartTarget,
  isMermaidTap,
  openMermaidFullscreen,
  type MermaidPointerStart,
} from './mermaidPresentation';

function mermaidDom() {
  const click = vi.fn();
  const button = { click };
  const block = {
    closest: () => null,
    querySelector: (selector: string) => selector === "button[aria-label='View fullscreen']"
      ? button
      : null,
  };
  const chart = {
    closest: (selector: string) => selector === "[data-streamdown='mermaid-block']"
      ? block
      : null,
    querySelector: () => null,
  };
  const target = {
    closest: (selector: string) => selector === MERMAID_CHART_SELECTOR ? chart : null,
  } as unknown as EventTarget;
  return { click, target };
}

describe('Mermaid presentation', () => {
  it('opens Streamdown fullscreen when the rendered chart is tapped', () => {
    const { click, target } = mermaidDom();

    expect(isMermaidChartTarget(target)).toBe(true);
    expect(openMermaidFullscreen(target)).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  });

  it('does not treat a pan gesture as a chart tap', () => {
    const { target } = mermaidDom();
    const start: MermaidPointerStart = {
      pointerId: 4,
      clientX: 20,
      clientY: 30,
      target,
    };

    expect(isMermaidTap(start, { pointerId: 4, clientX: 24, clientY: 33 })).toBe(true);
    expect(isMermaidTap(start, { pointerId: 4, clientX: 36, clientY: 30 })).toBe(false);
    expect(isMermaidTap(start, { pointerId: 5, clientX: 20, clientY: 30 })).toBe(false);
  });

  it('keeps non-Mermaid content inert', () => {
    const target = { closest: () => null } as unknown as EventTarget;

    expect(isMermaidChartTarget(target)).toBe(false);
    expect(openMermaidFullscreen(target)).toBe(false);
  });

  it('keeps Mermaid at normal message width with only Expand visible inline', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    const chat = readFileSync(new URL('../screens/Chat.tsx', import.meta.url), 'utf8');

    expect(css).toContain("[data-streamdown='mermaid-block'] > :first-child");
    expect(css).toContain("[data-streamdown='mermaid-block-actions']");
    expect(css).toContain("button[aria-label='Download diagram']");
    expect(css).toContain("button[aria-label='Copy Code']");
    expect(css).toContain("button[aria-label='View fullscreen']");
    expect(css).toContain("button[aria-label='Zoom in']");
    expect(css).toContain("> div:has(> [data-streamdown='mermaid-block-actions'])");
    expect(css).toContain('margin-top: -3rem');
    expect(css).toContain('height: 3rem');
    expect(css).not.toContain('max-width: 64rem');
    expect(chat).toContain('h-full w-full max-w-none flex-col');
    expect(chat).not.toContain('h-full max-w-5xl flex-col');
    expect(chat.match(/data-vp-mermaid-row/g)).toHaveLength(2);
    expect(css).toContain("[data-vp-mermaid-row] > [data-slot='message-content'] > [data-slot='bubble']");
  });

  it('groups expanded controls at the top right on desktop and mobile', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

    expect(css).toContain("[data-streamdown='mermaid-fullscreen']");
    expect(css).toContain('right: calc(4vw + 6.25rem)');
    expect(css).toContain('flex-direction: row');
    expect(css).toContain('@media (max-width: 639px)');
    expect(css).toContain('right: calc(env(safe-area-inset-right) + 10rem)');
    expect(css).toContain('cursor: zoom-in');
  });
});
