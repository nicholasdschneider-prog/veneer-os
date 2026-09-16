import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ToolChatItem } from '@/lib/activityRuns';
import { ConnectionToolRow } from './ConnectionToolRow';

function gmail(overrides: Partial<ToolChatItem> = {}): ToolChatItem {
  return {
    kind: 'tool',
    key: 'gmail-forward',
    label: 'Using Gmail',
    actionLabel: 'Forward Message',
    toolName: 'mcp__gmail-owner-example-com__GMAIL_FORWARD_MESSAGE',
    source: {
      kind: 'connector',
      slug: 'gmail',
      name: 'Gmail',
      mention: 'gmail-owner-example-com',
      label: 'owner@example.com',
      action: 'Forward Message',
    },
    connectorDetails: {
      kind: 'gmail-forward',
      recipients: ['alex@example.com'],
      note: 'Is this valuable to you as a daily digest?',
      sourceSubject: 'New daily sales digest',
      sourceSender: 'Reports <reports@example.com>',
      successful: true,
      gmailUrl: 'https://mail.google.com/mail/u/0/#all/abc123',
    },
    inputPreview: '{"raw":"input"}',
    resultPreview: '{"raw":"result"}',
    images: [],
    running: false,
    ok: true,
    ...overrides,
  };
}

function gmailFetch(overrides: Partial<ToolChatItem> = {}): ToolChatItem {
  return gmail({
    key: 'gmail-fetch',
    actionLabel: 'Fetch Emails',
    toolName: 'mcp__gmail_owner_example_com__GMAIL_FETCH_EMAILS',
    connectorDetails: {
      kind: 'gmail-fetch-list',
      searchSummary: 'Inbox · From me',
      successful: true,
      resultCount: 2,
      resultEstimate: 12,
      hasMore: true,
      messages: [
        { subject: 'Your ad was approved', sender: 'Google Ads <ads@example.com>', preview: 'Your campaign is ready.' },
        { subject: 'Weekly report', sender: 'Reports <reports@example.com>' },
      ],
    },
    inputPreview: '{"access_token":"private"}',
    resultPreview: '{"payload":"private raw MIME","log_id":"private-log-id"}',
    ...overrides,
  });
}

function gmailThread(overrides: Partial<ToolChatItem> = {}): ToolChatItem {
  return gmail({
    key: 'gmail-thread',
    actionLabel: 'Fetch Message By Thread Id',
    toolName: 'mcp__gmail_owner_example_com__GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
    connectorDetails: {
      kind: 'gmail-fetch-thread',
      successful: true,
      subject: 'Your ad was approved',
      latestSender: 'Owner <owner@example.com>',
      latestAt: '2026-08-10T14:00:00.000Z',
      messageCount: 2,
      gmailUrl: 'https://mail.google.com/mail/u/0/#inbox/thread',
    },
    ...overrides,
  });
}

function gmailReply(overrides: Partial<ToolChatItem> = {}): ToolChatItem {
  return gmail({
    key: 'gmail-reply',
    actionLabel: 'Reply To Thread',
    toolName: 'mcp__gmail_owner_example_com__GMAIL_REPLY_TO_THREAD',
    connectorDetails: {
      kind: 'gmail-reply',
      recipients: ['owner@example.com'],
      subject: 'Your ad was approved',
      body: 'Received — this is a test reply.',
      successful: true,
      gmailUrl: 'https://mail.google.com/mail/u/0/#inbox/reply',
    },
    ...overrides,
  });
}

function gmailMessage(overrides: Partial<ToolChatItem> = {}): ToolChatItem {
  return gmail({
    key: 'gmail-message',
    actionLabel: 'Fetch Message By Message Id',
    toolName: 'mcp__gmail_owner_example_com__GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
    connectorDetails: {
      kind: 'gmail-fetch-message',
      successful: true,
      subject: 'Daily digest — 3 awaiting, 1 hot',
      sender: 'Next Modular <daily@example.com>',
      receivedAt: '2026-08-10T13:00:00.000Z',
      preview: 'Three jobs are awaiting a response.',
      gmailUrl: 'https://mail.google.com/mail/u/0/#inbox/message',
    },
    ...overrides,
  });
}

function gmailSend(overrides: Partial<ToolChatItem> = {}): ToolChatItem {
  return gmail({
    key: 'gmail-send',
    actionLabel: 'Send Email',
    toolName: 'mcp__gmail_owner_example_com__GMAIL_SEND_EMAIL',
    source: {
      kind: 'connector',
      slug: 'gmail',
      name: 'Gmail',
      mention: 'gmail-owner-example-com',
      label: 'owner@example.com',
      action: 'Send Email',
    },
    connectorDetails: {
      kind: 'gmail-send',
      recipients: ['owner@example.com'],
      subject: 'Veneer connection event test',
      body: 'This is a test email sent from Veneer.',
      successful: true,
      gmailUrl: 'https://mail.google.com/mail/u/0/#inbox/abc123',
    },
    inputPreview: '{"access_token":"private","raw":"input"}',
    resultPreview: '{"log_id":"private-log-id","raw":"result"}',
    ...overrides,
  });
}

function driveFind(overrides: Partial<ToolChatItem> = {}): ToolChatItem {
  return {
    kind: 'tool',
    key: 'drive-find',
    label: 'Using Google Drive',
    actionLabel: 'Find File',
    toolName: 'mcp__googledrive-everyone-16__GOOGLEDRIVE_FIND_FILE',
    source: {
      kind: 'connector',
      slug: 'googledrive',
      name: 'Google Drive',
      mention: 'googledrive-everyone-16',
      action: 'Find File',
      sharing: 'shared',
    },
    connectorDetails: {
      kind: 'google-drive-find-file',
      searchSummary: 'Name contains “P100159” · Not in trash',
      successful: true,
      resultCount: 2,
      hasMore: true,
      files: [
        {
          name: 'P100159.pdf',
          fileType: 'PDF',
          modifiedAt: '2026-08-10T14:00:00.000Z',
          driveUrl: 'https://drive.google.com/file/d/safe-link/view',
        },
        { name: 'P100159+Vinyl.dxf', fileType: 'DXF' },
      ],
    },
    inputPreview: '{"folder_id":"private-folder-id","access_token":"private-token"}',
    resultPreview: '{"id":"private-file-id","log_id":"private-log-id"}',
    images: [],
    running: false,
    ok: true,
    ...overrides,
  };
}

function sheets(overrides: Partial<ToolChatItem> = {}): ToolChatItem {
  return {
    kind: 'tool',
    key: 'sheets-read',
    label: 'Using Google Sheets',
    actionLabel: 'Values Get',
    toolName: 'mcp__googlesheets__GOOGLESHEETS_VALUES_GET',
    source: {
      kind: 'connector',
      slug: 'googlesheets',
      name: 'Google Sheets',
      mention: 'googlesheets',
      action: 'Values Get',
      sharing: 'personal',
    },
    connectorDetails: {
      kind: 'google-sheets',
      operation: 'read',
      successful: true,
      spreadsheetTitle: 'Budget',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/private-spreadsheet-id/edit',
      range: 'Budget!A1:D20',
      rowCount: 20,
      columnCount: 4,
    },
    inputPreview: '{"spreadsheet_id":"private-spreadsheet-id","access_token":"private-token"}',
    resultPreview: '{"values":[["private cell value"]],"log_id":"private-log-id"}',
    images: [],
    running: false,
    ok: true,
    ...overrides,
  };
}

describe('connection chat rows', () => {
  it('renders a polished Gmail forward receipt without raw payloads', () => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={gmail()} />);
    expect(html).toContain('Gmail');
    expect(html).toContain('Forward message');
    expect(html).toContain('Sent');
    expect(html).toContain('alex@example.com');
    expect(html).toContain('Is this valuable to you as a daily digest?');
    expect(html).toContain('New daily sales digest');
    expect(html).toContain('Reports &lt;reports@example.com&gt;');
    expect(html).toContain('Open in Gmail');
    expect(html).not.toContain('&quot;raw&quot;');
  });

  it.each([
    [{ running: true }, 'Working', 'Sending'],
    [{ ok: false, connectorDetails: { kind: 'gmail-forward', error: 'Permission denied' } }, 'Failed', 'Permission denied'],
  ] as const)('covers Gmail state %s', (overrides, summary, detail) => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={gmail(overrides)} />);
    expect(html).toContain(summary);
    expect(html).toContain(detail);
  });

  it('renders a polished Gmail send receipt without raw payloads', () => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={gmailSend()} />);
    expect(html).toContain('Send email');
    expect(html).toContain('Sent email');
    expect(html).toContain('Sent');
    expect(html).toContain('owner@example.com');
    expect(html).toContain('Veneer connection event test');
    expect(html).toContain('This is a test email sent from Veneer.');
    expect(html).toContain('Open in Gmail');
    expect(html).not.toContain('access_token');
    expect(html).not.toContain('private-log-id');
  });

  it.each([
    [{ running: true }, 'Working', 'Sending email', 'Gmail is sending this message.'],
    [{ ok: false, connectorDetails: { kind: 'gmail-send', error: 'Permission denied' } }, 'Failed', 'Email not sent', 'Permission denied'],
  ] as const)('covers Gmail send state %s', (overrides, summary, title, detail) => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={gmailSend(overrides)} />);
    expect(html).toContain(summary);
    expect(html).toContain(title);
    expect(html).toContain(detail);
  });

  it('renders a bounded Gmail fetch receipt without raw connector data', () => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={gmailFetch()} />);
    expect(html).toContain('Fetch emails');
    expect(html).toContain('Found 2 messages');
    expect(html).toContain('Inbox · From me');
    expect(html).toContain('Your ad was approved');
    expect(html).toContain('Google Ads &lt;ads@example.com&gt;');
    expect(html).toContain('Your campaign is ready.');
    expect(html).toContain('More matching messages are available.');
    expect(html).not.toContain('access_token');
    expect(html).not.toContain('private raw MIME');
    expect(html).not.toContain('private-log-id');
  });

  it.each([
    [{ running: true }, 'Working', 'Fetching email', 'Gmail is searching for matching messages.'],
    [{ ok: false, connectorDetails: { kind: 'gmail-fetch-list', error: 'Mailbox unavailable' } }, 'Failed', 'Email not fetched', 'Mailbox unavailable'],
  ] as const)('covers Gmail fetch state %s', (overrides, summary, title, detail) => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={gmailFetch(overrides)} />);
    expect(html).toContain(summary);
    expect(html).toContain(title);
    expect(html).toContain(detail);
  });

  it('renders loaded Gmail thread context without ids or raw body', () => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={gmailThread({
      inputPreview: '{"thread_id":"private-thread-id"}',
      resultPreview: '{"messageText":"private full body","payload":"private MIME"}',
    })} />);
    expect(html).toContain('Fetch thread');
    expect(html).toContain('Loaded conversation');
    expect(html).toContain('Your ad was approved');
    expect(html).toContain('Owner &lt;owner@example.com&gt;');
    expect(html).toContain('Messages');
    expect(html).toContain('Open in Gmail');
    expect(html).not.toContain('private-thread-id');
    expect(html).not.toContain('private full body');
    expect(html).not.toContain('private MIME');
  });

  it.each([
    [{ running: true }, 'Working', 'Loading conversation'],
    [{ ok: false, connectorDetails: { kind: 'gmail-fetch-thread', error: 'Thread unavailable' } }, 'Failed', 'Thread unavailable'],
  ] as const)('covers Gmail thread state %s', (overrides, summary, detail) => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={gmailThread(overrides)} />);
    expect(html).toContain(summary);
    expect(html).toContain(detail);
  });

  it('renders one safely fetched Gmail message without raw payloads', () => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={gmailMessage({
      resultPreview: '{"messageText":"private full body","payload":"private MIME"}',
    })} />);
    expect(html).toContain('Fetch message');
    expect(html).toContain('Loaded message');
    expect(html).toContain('Daily digest — 3 awaiting, 1 hot');
    expect(html).toContain('Next Modular &lt;daily@example.com&gt;');
    expect(html).toContain('Three jobs are awaiting a response.');
    expect(html).toContain('Open in Gmail');
    expect(html).not.toContain('private full body');
    expect(html).not.toContain('private MIME');
  });

  it('renders a Gmail reply receipt without raw thread or log metadata', () => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={gmailReply({
      inputPreview: '{"thread_id":"private-thread-id"}',
      resultPreview: '{"log_id":"private-log-id"}',
    })} />);
    expect(html).toContain('Reply to thread');
    expect(html).toContain('Sent reply');
    expect(html).toContain('owner@example.com');
    expect(html).toContain('Your ad was approved');
    expect(html).toContain('Received — this is a test reply.');
    expect(html).toContain('Open in Gmail');
    expect(html).not.toContain('private-thread-id');
    expect(html).not.toContain('private-log-id');
  });

  it.each([
    [{ running: true }, 'Working', 'Sending reply'],
    [{ ok: false, connectorDetails: { kind: 'gmail-reply', error: 'Permission denied' } }, 'Failed', 'Permission denied'],
  ] as const)('covers Gmail reply state %s', (overrides, summary, detail) => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={gmailReply(overrides)} />);
    expect(html).toContain(summary);
    expect(html).toContain(detail);
  });

  it('renders a polished Google Drive find-file receipt without raw payloads', () => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={driveFind()} />);
    expect(html).toContain('Google Drive');
    expect(html).toContain('Find files');
    expect(html).toContain('Found 2 files');
    expect(html).toContain('2 found');
    expect(html).toContain('Name contains “P100159” · Not in trash');
    expect(html).toContain('P100159.pdf');
    expect(html).toContain('P100159+Vinyl.dxf');
    expect(html).toContain('PDF');
    expect(html).toContain('DXF');
    expect(html).toContain('https://drive.google.com/file/d/safe-link/view');
    expect(html).toContain('More matching files are available.');
    expect(html).not.toContain('private-folder-id');
    expect(html).not.toContain('private-file-id');
    expect(html).not.toContain('private-token');
    expect(html).not.toContain('private-log-id');
    expect(html).not.toContain('Connector-specific details are not available');
  });

  it.each([
    [{ running: true }, 'Working', 'Finding files', 'Searching'],
    [{ ok: false, connectorDetails: { kind: 'google-drive-find-file', successful: false } }, 'Failed', 'Search failed', 'Google Drive could not complete this search.'],
  ] as const)('covers Google Drive find state %s', (overrides, summary, title, detail) => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={driveFind(overrides)} />);
    expect(html).toContain(summary);
    expect(html).toContain(title);
    expect(html).toContain(detail);
    expect(html).not.toContain('private-folder-id');
    expect(html).not.toContain('private-file-id');
    expect(html).not.toContain('private-log-id');
  });

  it('renders a polished Google Sheets read receipt without raw payloads', () => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={sheets()} />);
    expect(html).toContain('Google Sheets');
    expect(html).toContain('Read values');
    expect(html).toContain('Read Budget!A1:D20 from Budget');
    expect(html).toContain('20 rows');
    expect(html).toContain('4 columns');
    expect(html).toContain('Open in Google Sheets');
    const link = 'https://docs.google.com/spreadsheets/d/private-spreadsheet-id/edit';
    expect(html).toContain(link);
    expect(html.split('private-spreadsheet-id').length - 1).toBe(html.split(link).length - 1);
    expect(html).not.toContain('private cell value');
    expect(html).not.toContain('private-token');
    expect(html).not.toContain('private-log-id');
    expect(html).not.toContain('Input:');
    expect(html).not.toContain('Result:');
    expect(html).not.toContain('&quot;values&quot;');
    expect(html).not.toContain('Connector-specific details are not available');
  });

  it('renders spreadsheet info, append, search, and unmapped Sheets actions', () => {
    const info = renderToStaticMarkup(<ConnectionToolRow item={sheets({
      connectorDetails: {
        kind: 'google-sheets',
        operation: 'info',
        successful: true,
        spreadsheetTitle: 'Budget',
        sheetNames: ['Summary', 'Q3', 'Q4'],
        hasMoreSheets: true,
      },
    })} />);
    expect(info).toContain('Get spreadsheet info');
    expect(info).toContain('Loaded Budget · 3 sheets');
    expect(info).toContain('Loaded');
    expect(info).toContain('Summary');
    expect(info).toContain('Q4');
    expect(info).toContain('More sheets are in this spreadsheet.');

    const append = renderToStaticMarkup(<ConnectionToolRow item={sheets({
      connectorDetails: {
        kind: 'google-sheets',
        operation: 'append',
        successful: true,
        spreadsheetTitle: 'Budget',
        range: 'Budget!A4:D6',
        updatedRows: 3,
        updatedCells: 12,
      },
    })} />);
    expect(append).toContain('Append rows');
    expect(append).toContain('Appended 3 rows to Budget');
    expect(append).toContain('Appended');
    expect(append).toContain('12 cells · 3 rows');

    const search = renderToStaticMarkup(<ConnectionToolRow item={sheets({
      connectorDetails: {
        kind: 'google-sheets',
        operation: 'search',
        successful: true,
        resultCount: 2,
        hasMore: true,
        files: [
          { name: 'Budget 2026', url: 'https://docs.google.com/spreadsheets/d/safe-link/edit', modifiedAt: '2026-09-01T12:00:00.000Z' },
          { name: 'Budget archive' },
        ],
      },
    })} />);
    expect(search).toContain('Find spreadsheets');
    expect(search).toContain('Found 2 spreadsheets');
    expect(search).toContain('2 found');
    expect(search).toContain('Budget 2026');
    expect(search).toContain('Budget archive');
    expect(search).toContain('https://docs.google.com/spreadsheets/d/safe-link/edit');
    expect(search).toContain('More matching spreadsheets are available.');

    const other = renderToStaticMarkup(<ConnectionToolRow item={sheets({
      toolName: 'mcp__googlesheets__GOOGLESHEETS_ADD_SHEET',
      connectorDetails: { kind: 'google-sheets', operation: 'other', actionLabel: 'Add sheet', successful: true },
    })} />);
    expect(other).toContain('Add sheet');
    expect(other).toContain('Completed');
    expect(other).not.toContain('Connector-specific details are not available');
  });

  it.each([
    [{ running: true }, 'Working', 'Reading values', 'Reading…'],
    [
      { ok: false, connectorDetails: { kind: 'google-sheets', operation: 'write', error: 'Requested entity was not found.' } },
      'Failed',
      'Action failed',
      'Requested entity was not found.',
    ],
    [
      { ok: true, connectorDetails: { kind: 'google-sheets', operation: 'clear', successful: false } },
      'Failed',
      'Action failed',
      'Google Sheets could not complete this action.',
    ],
  ] as const)('covers Google Sheets state %s', (overrides, summary, title, detail) => {
    const html = renderToStaticMarkup(<ConnectionToolRow item={sheets(overrides)} />);
    expect(html).toContain(summary);
    expect(html).toContain(title);
    expect(html).toContain(detail);
    expect(html).not.toContain('private cell value');
    expect(html).not.toContain('private-token');
    expect(html).not.toContain('private-log-id');
  });

  it('falls back to safe generic connector metadata without raw payloads', () => {
    const item = gmail({
      source: {
        kind: 'connector',
        slug: 'shopify',
        name: 'Shopify',
        mention: 'shopify',
        action: 'Find Products',
      },
      connectorDetails: undefined,
      actionLabel: 'Find Products',
    });
    const html = renderToStaticMarkup(<ConnectionToolRow item={item} />);
    expect(html).toContain('Shopify');
    expect(html).toContain('Find Products');
    expect(html).toContain('Connector-specific details are not available for this action.');
    expect(html).not.toContain('Input:');
    expect(html).not.toContain('Result:');
    expect(html).not.toContain('&quot;raw&quot;');
  });
});
