import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DesktopPanel, FullView, shouldDockDesktop } from './FloatingDesktop';

describe('Agent Browser desktop panel', () => {
  it('renders the shared browser as a right-column panel with panel controls', () => {
    const html = renderToStaticMarkup(<DesktopPanel onMinimize={vi.fn()} onHide={vi.fn()} />);

    expect(html).toContain('Agent Browser');
    expect(html).toContain('Shared desktop · Live');
    expect(html).toContain('title="Agent Browser (live)"');
    expect(html).toContain('aria-label="Minimize browser to thumbnail"');
    expect(html).toContain('aria-label="Close browser panel"');
    expect(html).not.toContain('fixed inset-0');
    expect(html).not.toContain('Browser Use');
    expect(html).not.toContain('Stop Browser Use');
  });

  it('docks only a full browser view on desktop', () => {
    expect(shouldDockDesktop('full', true)).toBe(true);
    expect(shouldDockDesktop('full', false)).toBe(false);
    expect(shouldDockDesktop('mini', true)).toBe(false);
    expect(shouldDockDesktop('hidden', true)).toBe(false);
  });

  it('keeps the mobile full-screen controls inside the safe area with large tap targets', () => {
    const html = renderToStaticMarkup(<FullView onMinimize={vi.fn()} onHide={vi.fn()} />);

    expect(html).toContain('safe-area-inset-left');
    expect(html).toContain('safe-area-inset-right');
    expect(html).toContain('aria-label="Close live view"');
    expect(html).toContain('size-[48px]');
  });
});
