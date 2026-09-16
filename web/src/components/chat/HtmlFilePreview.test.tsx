import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UNTRUSTED_PREVIEW_SANDBOX } from '../ui/embedded-preview-frame';
import { HtmlFilePreview, HtmlPreviewFrame, isHtmlFileName } from './HtmlFilePreview';

describe('HtmlFilePreview', () => {
  it.each(['index.html', 'archive.HTM'])('recognizes HTML file %s', (fileName) => {
    expect(isHtmlFileName(fileName)).toBe(true);
  });

  it.each(['index.html.txt', 'page.xhtml', 'html'])('rejects non-HTML file %s', (fileName) => {
    expect(isHtmlFileName(fileName)).toBe(false);
  });

  it('opens rendered without eagerly loading source', () => {
    const loadSource = vi.fn(async () => ({ content: '<h1>Source</h1>' }));
    const html = renderToStaticMarkup(
      <HtmlFilePreview title="index.html" url="/api/files/index.html?inline=1" loadSource={loadSource} />,
    );

    expect(loadSource).not.toHaveBeenCalled();
    expect(html).toContain('Rendered');
    expect(html).toContain('Source');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Rendered/);
    expect(html).toContain('src="/api/files/index.html?inline=1"');
    expect(html).toContain(`sandbox="${UNTRUSTED_PREVIEW_SANDBOX}"`);
    expect(html).not.toContain('allow-same-origin');
  });

  it('keeps editor HTML in an opaque-origin srcDoc frame', () => {
    const html = renderToStaticMarkup(
      <HtmlPreviewFrame title="draft.html" html={'<!doctype html><h1 data-test="preview">Draft</h1>'} />,
    );

    expect(html).toContain('srcDoc="&lt;!doctype html&gt;');
    expect(html).toContain(`sandbox="${UNTRUSTED_PREVIEW_SANDBOX}"`);
    expect(html).not.toContain('allow-same-origin');
  });
});
