import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PwaUpdateBanner } from './PwaUpdatePrompt';

describe('PwaUpdateBanner', () => {
  it('clears the larger mobile safe-area spacing without moving its desktop position', () => {
    const html = renderToStaticMarkup(<PwaUpdateBanner />);

    expect(html).toContain('top-[calc(env(safe-area-inset-top)+1.75rem)]');
    expect(html).toContain('md:top-[calc(env(safe-area-inset-top)+0.75rem)]');
  });
});
