import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConnectorGlyph } from './connectorIcons';

describe('ConnectorGlyph', () => {
  it.each([
    ['outlook', 'Outlook'],
    ['googleads', 'Google Ads'],
    ['google_analytics', 'Google Analytics'],
    ['googledocs', 'Google Docs'],
    ['googledrive', 'Google Drive'],
    ['googlesheets', 'Google Sheets'],
    ['hubspot', 'HubSpot'],
    ['omnisend', 'Omnisend'],
    ['paper', 'Paper'],
    ['quickbooks', 'QuickBooks'],
    ['ringcentral', 'RingCentral'],
  ])('uses the official %s logo asset', (slug, name) => {
    const html = renderToStaticMarkup(<ConnectorGlyph slug={slug} name={name} />);

    expect(html).toContain(`src="/icons/connectors/${slug}.svg"`);
    expect(html).toContain(`alt="${name}"`);
  });

  it('uses the generic plug for a connector without an official logo asset', () => {
    const html = renderToStaticMarkup(<ConnectorGlyph slug="unknown-connector" />);

    expect(html).toContain('<svg');
    expect(html).not.toContain('<img');
  });
});
