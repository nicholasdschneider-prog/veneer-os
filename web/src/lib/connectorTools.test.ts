import { describe, expect, it } from 'vitest';
import { connectorToolPresentation } from './connectorTools';

describe('connector tool presentation', () => {
  it('presents a Google Drive session tool as a Google Drive connector action', () => {
    expect(connectorToolPresentation(
      'mcp__googledrive__GOOGLEDRIVE_FIND_FILE',
      'GOOGLEDRIVE_FIND_FILE',
    )).toMatchObject({
      label: 'Using Google Drive',
      action: 'Find File',
      source: { slug: 'googledrive', mention: 'googledrive', name: 'Google Drive' },
    });
  });

  it.each([
    ['mcp__googledocs__GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', 'googledocs', 'Google Docs', 'Get Document Plaintext'],
    ['mcp__googlesheets__GOOGLESHEETS_VALUES_GET', 'GOOGLESHEETS_VALUES_GET', 'googlesheets', 'Google Sheets', 'Values Get'],
    ['mcp__googleads__GOOGLEADS_SEARCH_STREAM_GAQL', 'GOOGLEADS_SEARCH_STREAM_GAQL', 'googleads', 'Google Ads', 'Search Stream Gaql'],
    ['mcp__google_analytics__GOOGLE_ANALYTICS_RUN_REPORT', 'GOOGLE_ANALYTICS_RUN_REPORT', 'google_analytics', 'Google Analytics', 'Run Report'],
    ['mcp__quickbooks__QUICKBOOKS_GET_PROFIT_AND_LOSS_REPORT', 'QUICKBOOKS_GET_PROFIT_AND_LOSS_REPORT', 'quickbooks', 'QuickBooks', 'Get Profit And Loss Report'],
    ['mcp__hubspot__HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', 'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', 'hubspot', 'HubSpot', 'Search Contacts By Criteria'],
    ['mcp__ringcentral__list_calls', 'list_calls', 'ringcentral', 'RingCentral', 'List Calls'],
  ])('presents %s as its connector action', (toolName, displayName, slug, name, action) => {
    expect(connectorToolPresentation(toolName, displayName)).toMatchObject({
      label: `Using ${name}`,
      action,
      source: { slug, mention: slug, name },
    });
  });
});
