import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CollapsedMessageDisclosure } from './CollapsedMessageDisclosure';

describe('CollapsedMessageDisclosure', () => {
  it('uses one closed native disclosure for sender-side message details', () => {
    const html = renderToStaticMarkup(
      <CollapsedMessageDisclosure summary="Messaged SwapBot">
        Exact outbound message.
      </CollapsedMessageDisclosure>,
    );

    expect(html.match(/<details[^>]*>/)?.[0]).not.toContain('open=');
    expect(html).toContain('<summary');
    expect(html.indexOf('Messaged SwapBot')).toBeLessThan(html.indexOf('Exact outbound message.'));
    expect(html).toContain('pointer-fine:after:hidden');
  });
});
