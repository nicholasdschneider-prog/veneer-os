import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PromptDisclosure } from './PromptDisclosure';

describe('PromptDisclosure', () => {
  it('starts collapsed behind a native, keyboard-accessible disclosure', () => {
    const html = renderToStaticMarkup(<PromptDisclosure text={'First line\nSecond line'} />);

    expect(html).toContain('<details data-prompt-disclosure="true"');
    expect(html).not.toContain('<details open=""');
    expect(html).toContain('<summary');
    expect(html).toContain('Show');
  });

  it('keeps the complete message available when the disclosure is expanded', () => {
    const html = renderToStaticMarkup(<PromptDisclosure text={'First line\nSecond line'} />);

    expect(html).toContain('data-prompt-disclosure-body="true"');
    expect(html).toContain('First line\nSecond line');
    expect(html).toContain('Hide');
  });
});
