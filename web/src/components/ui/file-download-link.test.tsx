import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FileDownloadLink } from './file-download-link';

describe('FileDownloadLink', () => {
  it('renders a normal named download when no PWA browser environment is present', () => {
    const html = renderToStaticMarkup(
      <FileDownloadLink href="/api/generated-files/file-1/download/report.csv" name="report.csv" />,
    );

    expect(html).toContain('download="report.csv"');
    expect(html).toContain('data-download-strategy="native"');
    expect(html).toContain('aria-label="Download report.csv"');
    expect(html).not.toContain('target="_blank"');
  });

  it('provides a 48px touch target for compact artifact actions', () => {
    const html = renderToStaticMarkup(
      <FileDownloadLink href="/api/download" name="report.csv" showLabel={false} className="size-6" />,
    );

    expect(html).toContain('after:size-12');
  });
});
