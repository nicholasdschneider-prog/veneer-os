import type Database from 'better-sqlite3';
import { connectedConnectorRowsForConversation } from '../connectors/access.js';
import { CONNECTOR_DEFS, connectorDef, connectorInstallMcpName } from '../connectors/catalog.js';
import type { ConversationEvent, ConnectorToolSource } from './events.js';

interface McpToolParts {
  server: string;
  tool: string;
}

function mcpToolParts(toolName: string): McpToolParts | null {
  if (!toolName.startsWith('mcp__')) return null;
  const parts = toolName.split('__');
  const server = parts[1];
  if (!server || parts.length < 3) return null;
  return { server, tool: parts.slice(2).join('__') };
}

function titleFromSlug(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function actionFor(slug: string, tool: string): string {
  const normalized = tool.toLowerCase();
  if (slug === 'netsuite' && normalized === 'suiteql') return 'SuiteQL query';
  if (slug === 'netsuite' && normalized === 'get') return 'NetSuite record lookup';

  const withoutConnector = normalized.startsWith(`${slug.toLowerCase()}_`)
    ? tool.slice(slug.length + 1)
    : tool;
  return titleFromSlug(withoutConnector) || 'Connector action';
}

function summaryFor(source: ConnectorToolSource, tool: string): string {
  const connector = source.label ? `${source.name} · ${source.label}` : source.name;
  const normalized = tool.toLowerCase();
  if (source.slug === 'netsuite' && normalized === 'suiteql') return `Querying ${connector}`;
  if (source.slug === 'netsuite' && normalized === 'get') return `Reading from ${connector}`;
  return `Using ${connector}`;
}

/** Current connector identities keyed exactly as their MCP server names. */
export function connectorToolSourcesForConversation(
  db: Database.Database,
  conversationId: string,
  actorUserId: number | null,
): Map<string, Omit<ConnectorToolSource, 'action'>> {
  const sources = new Map<string, Omit<ConnectorToolSource, 'action'>>();
  for (const row of connectedConnectorRowsForConversation(db, conversationId, actorUserId)) {
    const def = connectorDef(row.connector_slug);
    if (!def) continue;
    const mention = connectorInstallMcpName(row.connector_slug, row.label, row.sharing, row.id);
    sources.set(mention, {
      kind: 'connector',
      slug: row.connector_slug,
      name: def.name,
      mention,
      installId: row.id,
      ...(row.label ? { label: row.label } : {}),
      sharing: row.sharing,
    });
  }
  return sources;
}

/** Catalog-only fallback for historical events whose install was removed. The
 * MCP name preserves slugified labels plus shared install ids, so the row can
 * stay useful even when the exact database record no longer exists. */
export function connectorToolSourceForName(
  toolName: string,
  current = new Map<string, Omit<ConnectorToolSource, 'action'>>(),
): { source: ConnectorToolSource; displayName: string } | null {
  const parts = mcpToolParts(toolName);
  if (!parts || parts.server === 'agents') return null;

  let base = current.get(parts.server);
  if (!base) {
    const def = [...CONNECTOR_DEFS]
      .sort((a, b) => b.slug.length - a.slug.length)
      .find((candidate) => parts.server === candidate.slug || parts.server.startsWith(`${candidate.slug}-`));
    if (!def) return null;

    const shared = parts.server.match(/-(?:everyone|team)-(\d+)$/);
    const withoutSharedId = shared ? parts.server.slice(0, shared.index) : parts.server;
    const labelSlug = withoutSharedId.startsWith(`${def.slug}-`)
      ? withoutSharedId.slice(def.slug.length + 1)
      : '';
    base = {
      kind: 'connector',
      slug: def.slug,
      name: def.name,
      mention: parts.server,
      ...(shared
        ? { installId: Number(shared[1]), sharing: 'shared' as const }
        : { sharing: 'personal' as const }),
      ...(labelSlug ? { label: titleFromSlug(labelSlug) } : {}),
    };
  }

  const source: ConnectorToolSource = { ...base, action: actionFor(base.slug, parts.tool) };
  return { source, displayName: summaryFor(source, parts.tool) };
}

/** Add connector presentation metadata to a structured tool event. Existing
 * metadata wins so history keeps the original label if an install is renamed. */
export function enrichConnectorToolEvent(
  event: ConversationEvent,
  current?: Map<string, Omit<ConnectorToolSource, 'action'>>,
): ConversationEvent {
  if (event.type !== 'tool_started') return event;
  const resolved = event.source
    ? { source: event.source, displayName: summaryFor(event.source, mcpToolParts(event.toolName)?.tool ?? '') }
    : connectorToolSourceForName(event.toolName, current);
  return resolved ? { ...event, ...resolved } : event;
}
