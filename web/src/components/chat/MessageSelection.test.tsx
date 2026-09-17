import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { appendMessageQuote, ComposerQuote } from './MessageSelection';

describe('message quote context', () => {
  it('preserves the prompt and quotes every line, including blank lines and code', () => {
    expect(appendMessageQuote('/review Explain this', { role: 'assistant', text: 'First line\n\n```ts\nrun();\n```' }))
      .toBe('/review Explain this\n\nQuoted from assistant message:\n> First line\n> \n> ```ts\n> run();\n> ```');
  });
  it('supports quote-only sends and leaves ordinary messages unchanged', () => {
    expect(appendMessageQuote('', { role: 'user', text: 'Earlier request' }))
      .toBe('Quoted from user message:\n> Earlier request');
    expect(appendMessageQuote('Original draft', null)).toBe('Original draft');
  });
  it('renders quoted content as text with an accessible removal control', () => {
    const html = renderToStaticMarkup(<ComposerQuote quote={{ role: 'assistant', text: '<script>alert(1)</script>' }} onRemove={() => undefined} />);
    expect(html).toContain('aria-label="Remove quote"');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
