import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../Markdown';
import { isMarkdownFileName, MarkdownFilePreview } from './MarkdownFilePreview';
import { api } from '../../lib/api';

describe('MarkdownFilePreview', () => {
  it('keeps each report image route separate when the parser caches identical Markdown', () => {
    for (const id of ['first-report', 'second-report', 'first-report']) {
      const html = renderToStaticMarkup(createElement(MarkdownFilePreview, {
        content: '![Screenshot](./shot.png)',
        imageBaseUrl: api.generatedFileMarkdownImageUrl(id, ''),
      }));
      expect(html).toContain(`src="/api/generated-files/${id}/preview?image=.%2Fshot.png"`);
    }
  });
  it.each([
    '/Users/sam/Crew Seating/output/shot.png',
    '</Users/sam/Crew Seating/output/shot.png>',
    '/Users/sam/Crew%20Seating/output/shot.png',
    './shot.png',
    '<./My Images/shot.png>',
  ])('routes document images through the authorized report: %s', (target) => {
    const html = renderToStaticMarkup(createElement(MarkdownFilePreview, {
      content: `![Screenshot](${target})`,
      imageBaseUrl: api.generatedFileMarkdownImageUrl('report-id', ''),
    }));
    expect(html).toContain('src="/api/generated-files/report-id/preview?image=');
    expect(html).toContain('alt="Screenshot"');
    expect(html).not.toContain('Image unavailable');
  });

  it('retains remote images and ordinary file links in documents', () => {
    const html = renderToStaticMarkup(createElement(MarkdownFilePreview, {
      content: '![Remote](https://example.com/image.png)\n\n[Code](/Users/sam/Crew Seating/code.ts)',
      imageBaseUrl: api.generatedFileMarkdownImageUrl('report-id', ''),
    }));
    expect(html).toContain('src="https://example.com/image.png"');
    expect(html).toContain('href="/Users/sam/Crew%20Seating/code.ts"');
  });

  it('preserves the relative destination before the library resolves it against the website root', () => {
    const html = renderToStaticMarkup(createElement(MarkdownFilePreview, {
      content: '![Screenshot](<./My Images/shot.png>)',
      imageBaseUrl: api.generatedFileMarkdownImageUrl('report-id', ''),
    }));
    expect(html).toContain('src="/api/generated-files/report-id/preview?image=.%2FMy%2520Images%2Fshot.png"');
    expect(html).not.toContain('image=%2FMy');
  });
  it.each(['report.md', 'REPORT.MD', 'notes.markdown', '/tmp/review.Markdown'])('recognizes %s', (name) => {
    expect(isMarkdownFileName(name)).toBe(true);
  });

  it.each(['report.txt', 'report.md.txt', 'markdown'])('does not recognize %s', (name) => {
    expect(isMarkdownFileName(name)).toBe(false);
  });

  it('renders Markdown structure instead of raw source', () => {
    const html = renderToStaticMarkup(createElement(Markdown, {
      markdown: '# Report\n\n- **Passed**\n- Complete',
    }));

    expect(html).toContain('<h1>Report</h1>');
    expect(html).toContain('<li><strong>Passed</strong></li>');
    expect(html).not.toContain('# Report');
  });

  it('tolerates incomplete Markdown', () => {
    const html = renderToStaticMarkup(createElement(Markdown, {
      markdown: '# Draft\n\n[unfinished',
    }));

    expect(html).toContain('<h1>Draft</h1>');
    expect(html).toContain('[unfinished');
  });

  it('uses the shared renderer for math in document previews', () => {
    const html = renderToStaticMarkup(createElement(Markdown, {
      markdown: '\\[\\frac{1}{2}\\]',
    }));

    expect(html).toContain('class="katex-display"');
    expect(html).toContain('mfrac');
  });
});
