import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DigestNotice } from './DigestNotice';
import { emptyTranscript, reduceEvents } from '../../lib/transcript';

describe('DigestNotice', () => {
  it('renders a digest as a markdown block with its numbered lines and a View link', () => {
    const html = renderToStaticMarkup(
      <DigestNotice
        message={'Digest from bot lane:\n\nRecommended: approve the REM quote\n\n1. REM #100117957 $412\n2. Vendor pricing/MAP: none'}
        onView={() => undefined}
      />,
    );
    expect(html).toContain('<ol');
    expect(html).toContain('REM #100117957 $412');
    expect(html).toContain('Vendor pricing/MAP: none');
    expect(html).toContain('View');
  });

  it('omits View without a lane thread', () => {
    expect(renderToStaticMarkup(<DigestNotice message="Digest from bot lane:\n\nNothing" />)).not.toContain('View');
  });

  it('keeps the digest format on the transcript item', () => {
    const state = reduceEvents(emptyTranscript(), [
      { type: 'notice', message: 'Digest from bot lane:\n\n1. one', format: 'digest', coordinationThreadId: 't' },
      { type: 'notice', message: 'Result from bot lane: done', coordinationThreadId: 't' },
    ] as never);
    expect(state.items.filter((i) => i.kind === 'notice')).toEqual([
      expect.objectContaining({ format: 'digest', coordinationThreadId: 't' }),
      expect.not.objectContaining({ format: 'digest' }),
    ]);
  });
});
