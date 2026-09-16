import { describe, expect, it } from 'vitest';
import {
  GMAIL_ACCESS_MODES,
  GMAIL_FULL_V1_SCOPES,
  GMAIL_FULL_V1_TOOLS,
  GMAIL_FULL_V2_TOOLS,
  GMAIL_MANAGED_DEFAULT_V2_SCOPES,
  GMAIL_READ_ONLY_V1_SCOPES,
  GMAIL_READ_ONLY_V1_TOOLS,
  HUBSPOT_ACCESS_MODES,
  HUBSPOT_FULL_V1_TOOLS,
  HUBSPOT_MANAGED_DEFAULT_V1_SCOPES,
  HUBSPOT_READ_ONLY_V1_TOOLS,
  GOOGLE_ADS_ACCESS_MODES,
  GOOGLE_ADS_FULL_V1_TOOLS,
  GOOGLE_ADS_MANAGED_DEFAULT_V1_SCOPES,
  GOOGLE_ADS_READ_ONLY_V1_TOOLS,
  GOOGLE_ANALYTICS_ACCESS_MODES,
  GOOGLE_ANALYTICS_FULL_V1_TOOLS,
  GOOGLE_ANALYTICS_MANAGED_DEFAULT_V1_SCOPES,
  GOOGLE_ANALYTICS_READ_ONLY_V1_TOOLS,
  GOOGLE_DOCS_ACCESS_MODES,
  GOOGLE_DOCS_FULL_V1_TOOLS,
  GOOGLE_DOCS_MANAGED_DEFAULT_V1_SCOPES,
  GOOGLE_DOCS_READ_ONLY_V1_TOOLS,
  GOOGLE_DRIVE_ACCESS_MODES,
  GOOGLE_DRIVE_FULL_V1_TOOLS,
  GOOGLE_DRIVE_MANAGED_DEFAULT_V1_SCOPES,
  GOOGLE_DRIVE_READ_ONLY_V1_TOOLS,
  GOOGLE_SHEETS_ACCESS_MODES,
  GOOGLE_SHEETS_FULL_V1_TOOLS,
  GOOGLE_SHEETS_MANAGED_DEFAULT_V1_SCOPES,
  GOOGLE_SHEETS_READ_ONLY_V1_TOOLS,
  QUICKBOOKS_ACCESS_MODES,
  QUICKBOOKS_FULL_V1_TOOLS,
  QUICKBOOKS_MANAGED_DEFAULT_V1_SCOPES,
  QUICKBOOKS_READ_ONLY_V1_TOOLS,
  connectorAccessModeProfile,
  latestConnectorAccessModeProfiles,
} from '../src/connectors/accessModes.js';
import {
  composioManagedAuthCreateOptions,
  composioManagedAuthToolUpdateOptions,
  managedAuthConfigHasExactScopes,
  managedAuthConfigMatchesPolicy,
} from '../src/connectors/composio.js';

describe('connector access-mode snapshots', () => {
  it('keeps Gmail v1 snapshots and offers the immutable managed-default v2 profiles', () => {
    expect(GMAIL_ACCESS_MODES.map((profile) => ({
      mode: profile.mode,
      version: profile.version,
      strategy: profile.composio.oauthScopeStrategy,
      toolkitVersion: profile.composio.toolkitVersion,
    }))).toEqual([
      { mode: 'read_only', version: 1, strategy: 'explicit', toolkitVersion: '20260721_00' },
      { mode: 'full', version: 1, strategy: 'explicit', toolkitVersion: '20260721_00' },
      { mode: 'read_only', version: 2, strategy: 'managed_default', toolkitVersion: '20260721_00' },
      { mode: 'full', version: 2, strategy: 'managed_default', toolkitVersion: '20260721_00' },
    ]);
    expect(GMAIL_READ_ONLY_V1_SCOPES).toHaveLength(5);
    expect(GMAIL_FULL_V1_SCOPES).toHaveLength(13);
    expect(GMAIL_READ_ONLY_V1_TOOLS).toHaveLength(28);
    expect(GMAIL_FULL_V1_TOOLS).toHaveLength(61);
    expect(GMAIL_MANAGED_DEFAULT_V2_SCOPES).toHaveLength(11);
    expect(GMAIL_FULL_V2_TOOLS).toHaveLength(55);
    expect(new Set(GMAIL_READ_ONLY_V1_TOOLS).size).toBe(28);
    expect(new Set(GMAIL_FULL_V1_TOOLS).size).toBe(61);
    expect(new Set(GMAIL_FULL_V2_TOOLS).size).toBe(55);
    expect(latestConnectorAccessModeProfiles(GMAIL_ACCESS_MODES).map((profile) => [profile.mode, profile.version])).toEqual([
      ['read_only', 2],
      ['full', 2],
    ]);
    expect(connectorAccessModeProfile(GMAIL_ACCESS_MODES, 'read_only', 1)?.composio.oauthScopes)
      .toBe(GMAIL_READ_ONLY_V1_SCOPES);
  });

  it('keeps Gmail Read Only inside Full and excludes unsupported or anomalous mutations', () => {
    for (const tool of GMAIL_READ_ONLY_V1_TOOLS) expect(GMAIL_FULL_V2_TOOLS).toContain(tool);
    for (const tool of [
      'GMAIL_CREATE_FILTER',
      'GMAIL_DELETE_FILTER',
      'GMAIL_PATCH_SEND_AS',
      'GMAIL_UPDATE_IMAP_SETTINGS',
      'GMAIL_UPDATE_SEND_AS',
      'GMAIL_UPDATE_VACATION_SETTINGS',
      'GMAIL_CREATE_PROMPT_POST',
      'GMAIL_UPDATE_USER_ATTRIBUTES_VALUES',
    ]) expect(GMAIL_FULL_V2_TOOLS).not.toContain(tool);
    expect(GMAIL_READ_ONLY_V1_TOOLS.every((tool) =>
      !/^GMAIL_(ADD|BATCH|CREATE|DELETE|FORWARD|IMPORT|INSERT|MODIFY|MOVE|PATCH|REMOVE|REPLY|SEND|STOP|UNTRASH|UPDATE)/.test(tool),
    )).toBe(true);
  });

  it('pins Google Drive managed scopes and its reviewed 29 and 77 tool sets', () => {
    expect(GOOGLE_DRIVE_ACCESS_MODES.map((profile) => ({
      mode: profile.mode,
      version: profile.version,
      strategy: profile.composio.oauthScopeStrategy,
    }))).toEqual([
      { mode: 'read_only', version: 1, strategy: 'managed_default' },
      { mode: 'full', version: 1, strategy: 'managed_default' },
    ]);
    expect(GOOGLE_DRIVE_MANAGED_DEFAULT_V1_SCOPES).toEqual([
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
    ]);
    expect(GOOGLE_DRIVE_READ_ONLY_V1_TOOLS).toHaveLength(29);
    expect(GOOGLE_DRIVE_FULL_V1_TOOLS).toHaveLength(77);
    expect(new Set(GOOGLE_DRIVE_READ_ONLY_V1_TOOLS).size).toBe(29);
    expect(new Set(GOOGLE_DRIVE_FULL_V1_TOOLS).size).toBe(77);
    for (const tool of GOOGLE_DRIVE_READ_ONLY_V1_TOOLS) expect(GOOGLE_DRIVE_FULL_V1_TOOLS).toContain(tool);
    expect(GOOGLE_DRIVE_READ_ONLY_V1_TOOLS.every((tool) =>
      !/(CREATE|EDIT|UPLOAD|MOVE|PERMISSION|TRASH|DELETE|WATCH|UPDATE|PATCH|INSERT|MODIFY)/.test(tool) ||
      ['GOOGLEDRIVE_GET_PERMISSION', 'GOOGLEDRIVE_GET_PERMISSION_ID_FOR_EMAIL', 'GOOGLEDRIVE_LIST_PERMISSIONS'].includes(tool),
    )).toBe(true);
  });

  it('pins Google Docs managed scopes and its reviewed 5 and 40 tool sets', () => {
    expect(GOOGLE_DOCS_ACCESS_MODES.map((profile) => ({
      mode: profile.mode,
      version: profile.version,
      strategy: profile.composio.oauthScopeStrategy,
      toolkitVersion: profile.composio.toolkitVersion,
    }))).toEqual([
      { mode: 'read_only', version: 1, strategy: 'managed_default', toolkitVersion: '20260721_00' },
      { mode: 'full', version: 1, strategy: 'managed_default', toolkitVersion: '20260721_00' },
    ]);
    expect(GOOGLE_DOCS_MANAGED_DEFAULT_V1_SCOPES).toEqual([
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
    ]);
    expect(GOOGLE_DOCS_READ_ONLY_V1_TOOLS).toHaveLength(5);
    expect(GOOGLE_DOCS_FULL_V1_TOOLS).toHaveLength(40);
    expect(new Set(GOOGLE_DOCS_READ_ONLY_V1_TOOLS).size).toBe(5);
    expect(new Set(GOOGLE_DOCS_FULL_V1_TOOLS).size).toBe(40);
    for (const tool of GOOGLE_DOCS_READ_ONLY_V1_TOOLS) expect(GOOGLE_DOCS_FULL_V1_TOOLS).toContain(tool);
    for (const excluded of [
      'GOOGLEDOCS_CREATE_DOCUMENT2',
      'GOOGLEDOCS_UPDATE_DOCUMENT_BATCH',
      'GOOGLEDOCS_LIST_SPREADSHEET_CHARTS',
    ]) expect(GOOGLE_DOCS_FULL_V1_TOOLS).not.toContain(excluded);
    expect(GOOGLE_DOCS_READ_ONLY_V1_TOOLS.every((tool) =>
      /^GOOGLEDOCS_(EXPORT|GET|SEARCH)_/.test(tool),
    )).toBe(true);
  });

  it('pins Google Sheets managed scopes and its reviewed 13 and 45 tool sets', () => {
    expect(GOOGLE_SHEETS_ACCESS_MODES.map((profile) => ({
      mode: profile.mode,
      version: profile.version,
      strategy: profile.composio.oauthScopeStrategy,
      toolkitVersion: profile.composio.toolkitVersion,
    }))).toEqual([
      { mode: 'read_only', version: 1, strategy: 'managed_default', toolkitVersion: '20260721_00' },
      { mode: 'full', version: 1, strategy: 'managed_default', toolkitVersion: '20260721_00' },
    ]);
    expect(GOOGLE_SHEETS_MANAGED_DEFAULT_V1_SCOPES).toEqual([
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
    ]);
    expect(GOOGLE_SHEETS_READ_ONLY_V1_TOOLS).toHaveLength(13);
    expect(GOOGLE_SHEETS_FULL_V1_TOOLS).toHaveLength(45);
    expect(new Set(GOOGLE_SHEETS_READ_ONLY_V1_TOOLS).size).toBe(13);
    expect(new Set(GOOGLE_SHEETS_FULL_V1_TOOLS).size).toBe(45);
    for (const tool of GOOGLE_SHEETS_READ_ONLY_V1_TOOLS) expect(GOOGLE_SHEETS_FULL_V1_TOOLS).toContain(tool);
    for (const deprecated of [
      'GOOGLESHEETS_BATCH_UPDATE',
      'GOOGLESHEETS_EXECUTE_SQL',
      'GOOGLESHEETS_FIND_WORKSHEET_BY_TITLE',
      'GOOGLESHEETS_GET_BATCH_VALUES',
      'GOOGLESHEETS_GET_TABLE_SCHEMA',
      'GOOGLESHEETS_LIST_TABLES',
      'GOOGLESHEETS_QUERY_TABLE',
      'GOOGLESHEETS_SHEET_FROM_JSON',
    ]) expect(GOOGLE_SHEETS_FULL_V1_TOOLS).not.toContain(deprecated);
    expect(GOOGLE_SHEETS_READ_ONLY_V1_TOOLS.every((tool) =>
      /^GOOGLESHEETS_(AGGREGATE|BATCH_GET|GET|LIST|LOOKUP|SEARCH|SPREADSHEETS_VALUES_BATCH_GET|VALUES_GET)/.test(tool),
    )).toBe(true);
  });

  it('pins Google Ads managed scope and its reviewed 6 and 22 tool sets', () => {
    expect(GOOGLE_ADS_ACCESS_MODES.map((profile) => ({
      mode: profile.mode,
      version: profile.version,
      strategy: profile.composio.oauthScopeStrategy,
      toolkitVersion: profile.composio.toolkitVersion,
    }))).toEqual([
      { mode: 'read_only', version: 1, strategy: 'managed_default', toolkitVersion: '20260721_00' },
      { mode: 'full', version: 1, strategy: 'managed_default', toolkitVersion: '20260721_00' },
    ]);
    expect(GOOGLE_ADS_MANAGED_DEFAULT_V1_SCOPES).toEqual([
      'https://www.googleapis.com/auth/adwords',
    ]);
    expect(GOOGLE_ADS_READ_ONLY_V1_TOOLS).toHaveLength(6);
    expect(GOOGLE_ADS_FULL_V1_TOOLS).toHaveLength(22);
    expect(new Set(GOOGLE_ADS_READ_ONLY_V1_TOOLS).size).toBe(6);
    expect(new Set(GOOGLE_ADS_FULL_V1_TOOLS).size).toBe(22);
    for (const tool of GOOGLE_ADS_READ_ONLY_V1_TOOLS) expect(GOOGLE_ADS_FULL_V1_TOOLS).toContain(tool);
    expect(GOOGLE_ADS_READ_ONLY_V1_TOOLS.every((tool) =>
      /^GOOGLEADS_(GET|LIST|SEARCH)_/.test(tool),
    )).toBe(true);
    expect(GOOGLE_ADS_READ_ONLY_V1_TOOLS.some((tool) => tool.includes('MUTATE'))).toBe(false);
  });

  it('pins Google Analytics managed scopes and its reviewed 55 and 60 tool sets', () => {
    expect(GOOGLE_ANALYTICS_ACCESS_MODES.map((profile) => ({
      mode: profile.mode,
      version: profile.version,
      strategy: profile.composio.oauthScopeStrategy,
      toolkitVersion: profile.composio.toolkitVersion,
    }))).toEqual([
      { mode: 'read_only', version: 1, strategy: 'managed_default', toolkitVersion: '20260721_00' },
      { mode: 'full', version: 1, strategy: 'managed_default', toolkitVersion: '20260721_00' },
    ]);
    expect(GOOGLE_ANALYTICS_MANAGED_DEFAULT_V1_SCOPES).toEqual([
      'https://www.googleapis.com/auth/analytics.readonly',
      'https://www.googleapis.com/auth/analytics',
      'https://www.googleapis.com/auth/userinfo.profile',
    ]);
    expect(GOOGLE_ANALYTICS_READ_ONLY_V1_TOOLS).toHaveLength(55);
    expect(GOOGLE_ANALYTICS_FULL_V1_TOOLS).toHaveLength(60);
    expect(new Set(GOOGLE_ANALYTICS_READ_ONLY_V1_TOOLS).size).toBe(55);
    expect(new Set(GOOGLE_ANALYTICS_FULL_V1_TOOLS).size).toBe(60);
    for (const tool of GOOGLE_ANALYTICS_READ_ONLY_V1_TOOLS) expect(GOOGLE_ANALYTICS_FULL_V1_TOOLS).toContain(tool);
    for (const excluded of [
      'GOOGLE_ANALYTICS_LIST_ACCOUNTS',
      'GOOGLE_ANALYTICS_LIST_PROPERTIES',
      'GOOGLE_ANALYTICS_ARCHIVE_CUSTOM_DIMENSION',
      'GOOGLE_ANALYTICS_CREATE_CUSTOM_DIMENSION',
      'GOOGLE_ANALYTICS_CREATE_CUSTOM_METRIC',
      'GOOGLE_ANALYTICS_CREATE_EXPANDED_DATA_SET',
      'GOOGLE_ANALYTICS_CREATE_ROLLUP_PROPERTY',
      'GOOGLE_ANALYTICS_PROVISION_ACCOUNT_TICKET',
      'GOOGLE_ANALYTICS_UPDATE_PROPERTY',
    ]) expect(GOOGLE_ANALYTICS_FULL_V1_TOOLS).not.toContain(excluded);
    expect(GOOGLE_ANALYTICS_READ_ONLY_V1_TOOLS.some((tool) =>
      /^GOOGLE_ANALYTICS_(CREATE|SEND|UPDATE|ARCHIVE|PROVISION)_/.test(tool),
    )).toBe(false);
  });

  it('pins QuickBooks managed scopes and its reviewed 74 and 108 tool sets', () => {
    expect(QUICKBOOKS_ACCESS_MODES.map((profile) => ({
      mode: profile.mode,
      version: profile.version,
      strategy: profile.composio.oauthScopeStrategy,
      toolkitVersion: profile.composio.toolkitVersion,
    }))).toEqual([
      { mode: 'read_only', version: 1, strategy: 'managed_default', toolkitVersion: '20260721_00' },
      { mode: 'full', version: 1, strategy: 'managed_default', toolkitVersion: '20260721_00' },
    ]);
    expect(QUICKBOOKS_MANAGED_DEFAULT_V1_SCOPES).toEqual([
      'com.intuit.quickbooks.accounting',
      'openid',
      'profile',
      'email',
      'phone',
      'address',
    ]);
    expect(QUICKBOOKS_READ_ONLY_V1_TOOLS).toHaveLength(74);
    expect(QUICKBOOKS_FULL_V1_TOOLS).toHaveLength(108);
    expect(new Set(QUICKBOOKS_READ_ONLY_V1_TOOLS).size).toBe(74);
    expect(new Set(QUICKBOOKS_FULL_V1_TOOLS).size).toBe(108);
    for (const tool of QUICKBOOKS_READ_ONLY_V1_TOOLS) expect(QUICKBOOKS_FULL_V1_TOOLS).toContain(tool);
    for (const paymentTool of [
      'QUICKBOOKS_CAPTURE_CHARGE',
      'QUICKBOOKS_CREATE_BANK_ACCOUNT',
      'QUICKBOOKS_CREATE_ECHECK_PAYMENT',
      'QUICKBOOKS_DELETE_BANK_ACCOUNT',
      'QUICKBOOKS_GET_BANK_ACCOUNT',
      'QUICKBOOKS_LIST_CARDS',
    ]) expect(QUICKBOOKS_FULL_V1_TOOLS).not.toContain(paymentTool);
    expect(QUICKBOOKS_READ_ONLY_V1_TOOLS.some((tool) =>
      /^QUICKBOOKS_(CREATE|DELETE|EXECUTE|SEND|UPDATE)_/.test(tool),
    )).toBe(false);
  });

  it('does not send scope overrides for managed-default profiles', () => {
    const policy = {
      oauthScopeStrategy: 'managed_default' as const,
      expectedScopes: GMAIL_MANAGED_DEFAULT_V2_SCOPES,
      toolSlugs: GMAIL_READ_ONLY_V1_TOOLS,
    };
    expect(composioManagedAuthCreateOptions('Gmail Read Only', policy)).toEqual({
      type: 'use_composio_managed_auth',
      name: 'Gmail Read Only',
    });
    expect(composioManagedAuthToolUpdateOptions(policy)).toEqual({
      type: 'default',
      toolAccessConfig: { toolsAvailableForExecution: [...GMAIL_READ_ONLY_V1_TOOLS] },
    });
    expect(JSON.stringify(composioManagedAuthToolUpdateOptions(policy))).not.toContain('ConnectedAccountCreation');

    expect(composioManagedAuthCreateOptions('Legacy', {
      ...policy,
      oauthScopeStrategy: 'explicit',
      expectedScopes: GMAIL_READ_ONLY_V1_SCOPES,
    })).toMatchObject({ credentials: { scopes: GMAIL_READ_ONLY_V1_SCOPES.join(',') } });
  });

  it('keeps HubSpot Limited inside its managed-auth-supported Full snapshot', () => {
    expect(HUBSPOT_ACCESS_MODES.map((profile) => [profile.mode, profile.version])).toEqual([
      ['read_only', 1],
      ['full', 1],
    ]);
    expect(HUBSPOT_MANAGED_DEFAULT_V1_SCOPES).toHaveLength(37);
    expect(HUBSPOT_READ_ONLY_V1_TOOLS).toHaveLength(63);
    expect(HUBSPOT_FULL_V1_TOOLS).toHaveLength(161);
    expect(new Set(HUBSPOT_READ_ONLY_V1_TOOLS).size).toBe(63);
    expect(new Set(HUBSPOT_FULL_V1_TOOLS).size).toBe(161);
    for (const tool of HUBSPOT_READ_ONLY_V1_TOOLS) expect(HUBSPOT_FULL_V1_TOOLS).toContain(tool);
    expect(HUBSPOT_READ_ONLY_V1_TOOLS.some((tool) =>
      /^HUBSPOT_(ADD|ARCHIVE|BATCH_UPDATE|CANCEL|CLONE|CONFIGURE|CREATE|DELETE|MERGE|PARTIALLY_UPDATE|PERMANENTLY_DELETE|PUBLISH|PURGE|REMOVE|REPLACE|RESET|RESTORE|SET|START|UPDATE)_/.test(tool),
    )).toBe(false);
    expect(HUBSPOT_FULL_V1_TOOLS).not.toContain('HUBSPOT_PURGE_SCHEMA');
  });

  it('accepts only the exact managed OAuth and execution-tool snapshots', () => {
    const snapshot = {
      isComposioManaged: true,
      status: 'ENABLED',
      toolkit: { slug: 'gmail' },
      credentials: { scopes: [...GMAIL_MANAGED_DEFAULT_V2_SCOPES].reverse().join(',') },
      toolAccessConfig: { toolsAvailableForExecution: [...GMAIL_READ_ONLY_V1_TOOLS].reverse() },
    };
    const policy = {
      oauthScopeStrategy: 'managed_default' as const,
      expectedScopes: GMAIL_MANAGED_DEFAULT_V2_SCOPES,
      toolSlugs: GMAIL_READ_ONLY_V1_TOOLS,
    };
    expect(managedAuthConfigHasExactScopes(snapshot, 'gmail', GMAIL_MANAGED_DEFAULT_V2_SCOPES)).toBe(true);
    expect(managedAuthConfigMatchesPolicy(snapshot, 'gmail', policy)).toBe(true);
    expect(managedAuthConfigMatchesPolicy({
      ...snapshot,
      credentials: { scopes: [...GMAIL_MANAGED_DEFAULT_V2_SCOPES, 'extra.scope'] },
    }, 'gmail', policy)).toBe(false);
    expect(managedAuthConfigMatchesPolicy({
      ...snapshot,
      tool_access_config: { tools_available_for_execution: [...GMAIL_READ_ONLY_V1_TOOLS, 'GMAIL_SEND_EMAIL'] },
      toolAccessConfig: undefined,
    }, 'gmail', policy)).toBe(false);
    expect(managedAuthConfigMatchesPolicy({ ...snapshot, status: 'DISABLED' }, 'gmail', policy)).toBe(false);
  });

  it('treats managed required and optional scopes as one exact OAuth snapshot', () => {
    const required = HUBSPOT_MANAGED_DEFAULT_V1_SCOPES.slice(0, 33);
    const optional = HUBSPOT_MANAGED_DEFAULT_V1_SCOPES.slice(33);
    const snapshot = {
      isComposioManaged: true,
      status: 'ENABLED',
      toolkit: { slug: 'hubspot' },
      credentials: {
        scopes: required,
        optional_scopes: optional.join(' '),
        user_scopes: [],
      },
    };
    expect(managedAuthConfigHasExactScopes(snapshot, 'hubspot', HUBSPOT_MANAGED_DEFAULT_V1_SCOPES)).toBe(true);
    expect(managedAuthConfigHasExactScopes({
      ...snapshot,
      credentials: { ...snapshot.credentials, optional_scopes: [...optional, 'extra.scope'] },
    }, 'hubspot', HUBSPOT_MANAGED_DEFAULT_V1_SCOPES)).toBe(false);
  });
});
