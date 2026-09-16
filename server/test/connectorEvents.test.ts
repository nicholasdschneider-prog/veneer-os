import { describe, expect, it } from 'vitest';
import type { ConversationEvent, ConnectorToolSource } from '../src/runtime/events.js';
import {
  connectorToolSourceForName,
  enrichConnectorToolEvent,
} from '../src/runtime/connectorEvents.js';
import { displayNameForTool } from '../src/runtime/events.js';
import { connectorInstallMcpName } from '../src/connectors/catalog.js';

type ConnectorIdentity = Omit<ConnectorToolSource, 'action'>;

function current(...sources: ConnectorIdentity[]): Map<string, ConnectorIdentity> {
  return new Map(sources.map((source) => [source.mention, source]));
}

function oldToolEvent(toolName: string): Extract<ConversationEvent, { type: 'tool_started' }> {
  return {
    type: 'tool_started',
    turnId: 'turn-1',
    toolId: 'tool-1',
    toolName,
    displayName: displayNameForTool(toolName),
    inputPreview: '{}',
  };
}

describe('connector transcript presentation', () => {
  it('uses everybody in new shared connector names', () => {
    expect(connectorInstallMcpName('gmail', 'Client Success', 'shared', 27)).toBe(
      'gmail-client-success-everyone-27',
    );
  });

  it('turns an old shared NetSuite SuiteQL event into a human action with durable source metadata', () => {
    const event = enrichConnectorToolEvent(oldToolEvent('mcp__netsuite-team-4__suiteql'));
    expect(event).toMatchObject({
      type: 'tool_started',
      displayName: 'Querying NetSuite',
      source: {
        kind: 'connector',
        slug: 'netsuite',
        name: 'NetSuite',
        mention: 'netsuite-team-4',
        installId: 4,
        sharing: 'shared',
        action: 'SuiteQL query',
      },
    });
  });

  it('uses the original label for a current labeled personal install', () => {
    const resolved = connectorToolSourceForName(
      'mcp__gmail-work__GMAIL_FETCH_EMAILS',
      current({
        kind: 'connector',
        slug: 'gmail',
        name: 'Gmail',
        mention: 'gmail-work',
        installId: 8,
        label: 'Client Work',
        sharing: 'personal',
      }),
    );
    expect(resolved).toMatchObject({
      displayName: 'Using Gmail · Client Work',
      source: { label: 'Client Work', sharing: 'personal', action: 'Fetch Emails' },
    });
  });

  it('keeps a labeled shared install human-readable while retaining its technical identity', () => {
    const resolved = connectorToolSourceForName(
      'mcp__netsuite-finance-everyone-12__get',
      current({
        kind: 'connector',
        slug: 'netsuite',
        name: 'NetSuite',
        mention: 'netsuite-finance-everyone-12',
        installId: 12,
        label: 'Finance & Ops',
        sharing: 'shared',
      }),
    );
    expect(resolved).toEqual({
      displayName: 'Reading from NetSuite · Finance & Ops',
      source: {
        kind: 'connector',
        slug: 'netsuite',
        name: 'NetSuite',
        mention: 'netsuite-finance-everyone-12',
        installId: 12,
        label: 'Finance & Ops',
        sharing: 'shared',
        action: 'NetSuite record lookup',
      },
    });
  });

  it('does not reinterpret built-in agent tools or unknown MCP servers as connectors', () => {
    const agents = oldToolEvent('mcp__agents__ask_user');
    const unknown = oldToolEvent('mcp__warehouse-prod__lookup');
    expect(enrichConnectorToolEvent(agents)).toBe(agents);
    expect(agents.displayName).toBe('Asking you a question');
    expect(enrichConnectorToolEvent(unknown)).toBe(unknown);
    expect(unknown.displayName).toBe('Using warehouse-prod');
  });

  it('recovers label and install context from a removed historical connector name', () => {
    expect(connectorToolSourceForName('mcp__gmail-client-success-everyone-27__GMAIL_SEARCH')).toMatchObject({
      displayName: 'Using Gmail · Client Success',
      source: {
        mention: 'gmail-client-success-everyone-27',
        installId: 27,
        label: 'Client Success',
        sharing: 'shared',
        action: 'Search',
      },
    });
  });
});
