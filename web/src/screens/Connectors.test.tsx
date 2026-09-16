import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConnectorAccessModeProfile } from '../lib/api';
import { AccessModeChoices } from './Connectors';

const profiles: ConnectorAccessModeProfile[] = [
  {
    mode: 'read_only',
    version: 1,
    label: 'Limited',
    description: 'Read Gmail without changing data.',
    capabilities: ['Read messages', 'No write tools'],
    providerPermissionNote: 'Limited restricts this connector\'s agent tools. Composio still receives broad Google permission.',
    recommended: true,
  },
  {
    mode: 'full',
    version: 1,
    label: 'Full',
    description: 'Use all reviewed Gmail actions.',
    capabilities: ['Send messages', 'Manage settings'],
    recommended: false,
  },
];

describe('connector access-mode choices', () => {
  it('shows both Gmail modes, details, and the recommended selection', () => {
    const html = renderToStaticMarkup(
      <AccessModeChoices profiles={profiles} value="read_only" onChange={() => undefined} />,
    );
    expect(html).toContain('Limited');
    expect(html).toContain('Full');
    expect(html).toContain('Recommended');
    expect(html).toContain('No write tools');
    expect(html).toContain('Manage settings');
    expect(html).toContain('Composio still receives broad Google permission');
    expect(html).toContain('aria-pressed="true"');
  });
});
