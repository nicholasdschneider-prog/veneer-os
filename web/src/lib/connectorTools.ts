import type { ConnectorToolSource } from './types';

const CONNECTOR_NAMES: Record<string, string> = {
  gmail: 'Gmail',
  google_analytics: 'Google Analytics',
  googleads: 'Google Ads',
  googledocs: 'Google Docs',
  googledrive: 'Google Drive',
  googlesheets: 'Google Sheets',
  hubspot: 'HubSpot',
  netsuite: 'NetSuite',
  omnisend: 'Omnisend',
  outlook: 'Outlook',
  quickbooks: 'QuickBooks',
  ringcentral: 'RingCentral',
  shopify: 'Shopify',
};

function titleFromSlug(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

/** Catalog slug for a connector mention token — `gmail`, `gmail-work`, and
 *  `gmail-team-2` all resolve to `gmail`; unknown tokens resolve to nothing. */
export function connectorSlugForMention(mention: string): string | undefined {
  return Object.keys(CONNECTOR_NAMES)
    .sort((a, b) => b.length - a.length)
    .find((candidate) => mention === candidate || mention.startsWith(`${candidate}-`));
}

function fallbackSource(toolName: string): ConnectorToolSource | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  const parts = toolName.split('__');
  const mention = parts[1];
  const tool = parts.slice(2).join('__');
  if (!mention || !tool || mention === 'agents') return undefined;
  const slug = connectorSlugForMention(mention);
  if (!slug) return undefined;

  const shared = mention.match(/-(?:everyone|team)-(\d+)$/);
  const withoutSharedId = shared ? mention.slice(0, shared.index) : mention;
  const labelSlug = withoutSharedId.startsWith(`${slug}-`) ? withoutSharedId.slice(slug.length + 1) : '';
  const normalized = tool.toLowerCase();
  const action =
    slug === 'netsuite' && normalized === 'suiteql'
      ? 'SuiteQL query'
      : slug === 'netsuite' && normalized === 'get'
        ? 'NetSuite record lookup'
        : titleFromSlug(normalized.startsWith(`${slug}_`) ? tool.slice(slug.length + 1) : tool) || 'Connector action';
  return {
    kind: 'connector',
    slug,
    name: CONNECTOR_NAMES[slug]!,
    mention,
    action,
    ...(shared
      ? { installId: Number(shared[1]), sharing: 'shared' as const }
      : { sharing: 'personal' as const }),
    ...(labelSlug ? { label: titleFromSlug(labelSlug) } : {}),
  };
}

function connectorSummary(source: ConnectorToolSource, toolName: string): string {
  const connector = source.label ? `${source.name} · ${source.label}` : source.name;
  const tool = toolName.split('__').slice(2).join('__').toLowerCase();
  if (source.slug === 'netsuite' && tool === 'suiteql') return `Querying ${connector}`;
  if (source.slug === 'netsuite' && tool === 'get') return `Reading from ${connector}`;
  return `Using ${connector}`;
}

export function connectorToolPresentation(
  toolName: string,
  displayName: string,
  persisted?: ConnectorToolSource,
): { label: string; action: string; source?: ConnectorToolSource } {
  const source = persisted ?? fallbackSource(toolName);
  return source
    ? { label: connectorSummary(source, toolName), action: source.action, source }
    : { label: displayName, action: displayName };
}
