import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Citation } from '../../lib/citations';
import { CitationChip } from './CitationChip';
import { CitationPanel } from './CitationPanel';

const citations: Citation[] = [
  {
    number: 1,
    url: 'https://example.com/jobs/42',
    title: 'Job record',
    site: 'example.com',
  },
  {
    number: 2,
    url: 'https://docs.example.org/report.pdf',
    title: 'Inspection report',
    site: 'docs.example.org',
  },
];

describe('CitationChip', () => {
  it('renders only when citations exist and carries the frozen-row payload', () => {
    expect(renderToStaticMarkup(<CitationChip citations={[]} />)).toBe('');
    const html = renderToStaticMarkup(<CitationChip citations={citations} />);
    expect(html).toContain('data-citations-trigger=""');
    expect(html).toContain('Open 2 citations');
    expect(html).toContain('2 citations');
    expect(html).toContain('Job record');
  });
});

describe('CitationPanel', () => {
  it('lists citation details and desktop actions', () => {
    const html = renderToStaticMarkup(
      <CitationPanel citations={citations} isDesktop onClose={vi.fn()} />,
    );
    expect(html).toContain('2 sources from this answer');
    expect(html).toContain('Job record');
    expect(html).toContain('example.com');
    expect(html).toContain('href="https://example.com/jobs/42"');
    expect(html).toContain('Open source');
    expect(html).toContain('aria-label="Close citations panel"');
  });

  it('uses a back-to-chat action on mobile', () => {
    const html = renderToStaticMarkup(
      <CitationPanel citations={citations.slice(0, 1)} isDesktop={false} onClose={vi.fn()} />,
    );
    expect(html).toContain('1 source from this answer');
    expect(html).toContain('aria-label="Back to chat"');
    expect(html).not.toContain('Close citations panel');
  });
});
