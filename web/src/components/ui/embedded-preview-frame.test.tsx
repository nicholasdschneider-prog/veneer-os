import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  APP_PREVIEW_SANDBOX,
  EmbeddedPreviewFrame,
  PREVIEW_PERMISSIONS,
  UNTRUSTED_PREVIEW_SANDBOX,
} from './embedded-preview-frame';

describe('EmbeddedPreviewFrame', () => {
  it('allows common user-initiated preview actions without exposing the parent app', () => {
    const html = renderToStaticMarkup(<EmbeddedPreviewFrame src="https://pages.example.com/example" title="Page" />);

    expect(UNTRUSTED_PREVIEW_SANDBOX.split(' ')).toEqual(
      expect.arrayContaining([
        'allow-downloads',
        'allow-forms',
        'allow-modals',
        'allow-popups',
        'allow-popups-to-escape-sandbox',
        'allow-scripts',
      ]),
    );
    expect(UNTRUSTED_PREVIEW_SANDBOX).not.toContain('allow-same-origin');
    expect(UNTRUSTED_PREVIEW_SANDBOX).not.toContain('allow-top-navigation');
    expect(html).toContain(`sandbox="${UNTRUSTED_PREVIEW_SANDBOX}"`);
    expect(html).toContain(`allow="${PREVIEW_PERMISSIONS}"`);
    expect(html).toContain('allowFullScreen=""');
  });

  it('preserves the deployed app origin for app storage and authentication', () => {
    const html = renderToStaticMarkup(
      <EmbeddedPreviewFrame preserveOrigin src="https://example.workers.dev" title="App" />,
    );

    expect(APP_PREVIEW_SANDBOX).toContain('allow-downloads');
    expect(APP_PREVIEW_SANDBOX).toContain('allow-same-origin');
    expect(html).toContain(`sandbox="${APP_PREVIEW_SANDBOX}"`);
  });
});
