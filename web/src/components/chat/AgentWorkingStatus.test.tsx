import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AgentWorkingMarker, AgentWorkingStopButton } from './AgentWorkingStatus';

describe('AgentWorkingStatus', () => {
  it('places the matching activity orb to the left of each status label', () => {
    const thinking = renderToStaticMarkup(<AgentWorkingMarker thinking />);
    const working = renderToStaticMarkup(<AgentWorkingMarker thinking={false} />);

    expect(thinking).toContain('<canvas');
    expect(thinking).toContain('data-orb-state="searching"');
    expect(thinking).toContain('Thinking…');
    expect(thinking).toContain('width:29px;height:29px');
    expect(thinking).toContain('pt-0.5 pb-1');
    expect(working).toContain('<canvas');
    expect(working).toContain('data-orb-state="solving"');
    expect(working).toContain('Working…');
  });

  it('keeps context compaction explicit while maintenance is running', () => {
    const html = renderToStaticMarkup(<AgentWorkingMarker thinking compacting />);

    expect(html).toContain('data-orb-state="solving"');
    expect(html).toContain('Compacting context…');
    expect(html).not.toContain('Thinking…');
    expect(html).not.toContain('Working…');
  });

  it('keeps the orb-only stop control clearly labelled', () => {
    const html = renderToStaticMarkup(<AgentWorkingStopButton onPointerUp={vi.fn()} />);

    expect(html).toContain('aria-label="Stop agent"');
    expect(html).toContain('title="Stop agent"');
    expect(html).toContain('<canvas');
    expect(html).toContain('data-orb-state="shaping"');
    expect(html).toContain('scale-110');
    expect(html).not.toContain('<svg');
  });
});
