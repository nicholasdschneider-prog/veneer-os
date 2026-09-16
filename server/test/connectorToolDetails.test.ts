import { describe, expect, it } from 'vitest';
import {
  connectorInputDetails,
  connectorResultDetails,
  sanitizeConnectorDetails,
} from '../src/runtime/connectorToolDetails.js';

const FORWARD_TOOL = 'mcp__gmail-owner-example-com__GMAIL_FORWARD_MESSAGE';
const SEND_TOOL = 'mcp__gmail_owner_example_com__GMAIL_SEND_EMAIL';
const FETCH_TOOL = 'mcp__gmail-owner-example-com__GMAIL_FETCH_EMAILS';
const THREAD_TOOL = 'mcp__gmail-owner-example-com__GMAIL_FETCH_MESSAGE_BY_THREAD_ID';
const MESSAGE_TOOL = 'mcp__gmail-owner-example-com__GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID';
const REPLY_TOOL = 'mcp__gmail-owner-example-com__GMAIL_REPLY_TO_THREAD';
const DRIVE_FIND_TOOL = 'mcp__googledrive-everyone-16__GOOGLEDRIVE_FIND_FILE';
const SHEETS_INFO_TOOL = 'mcp__googlesheets__GOOGLESHEETS_GET_SPREADSHEET_INFO';
const SHEETS_READ_TOOL = 'mcp__googlesheets-everyone-21__GOOGLESHEETS_VALUES_GET';
const SHEETS_APPEND_TOOL = 'mcp__googlesheets__GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND';
const SHEETS_UPDATE_TOOL = 'mcp__googlesheets__GOOGLESHEETS_VALUES_UPDATE';
const SHEETS_SEARCH_TOOL = 'mcp__googlesheets__GOOGLESHEETS_SEARCH_SPREADSHEETS';
const SHEETS_ADD_SHEET_TOOL = 'mcp__googlesheets__GOOGLESHEETS_ADD_SHEET';

describe('connector tool detail allowlists', () => {
  it('extracts safe forward fields and replaces the raw message id with an opaque ref', () => {
    const details = connectorInputDetails(FORWARD_TOOL, {
      message_id: '19feb56fe9b345c3',
      recipients: ['alex@example.com'],
      additional_text: 'Is this daily digest valuable to you?',
      internal_secret: 'must-not-cross-the-event-seam',
    });
    expect(details).toMatchObject({
      kind: 'gmail-forward',
      recipients: ['alex@example.com'],
      note: 'Is this daily digest valuable to you?',
      messageRef: expect.stringMatching(/^gmail-[a-f0-9]{20}$/),
    });
    expect(JSON.stringify(details)).not.toContain('19feb56fe9b345c3');
    expect(JSON.stringify(details)).not.toContain('internal_secret');
  });

  it('unwraps send/forward results while omitting ids, labels, logs, and unsafe links', () => {
    const content = [{
      type: 'text',
      text: JSON.stringify({
        data: {
          display_url: 'https://mail.google.com/mail/u/0/#all/19febe5d4b669eb2',
          id: 'private-message-id',
          labelIds: ['SENT'],
          threadId: 'private-thread-id',
        },
        successful: true,
        log_id: 'private-log-id',
      }),
    }];
    expect(connectorResultDetails(FORWARD_TOOL, content)).toEqual({
      kind: 'gmail-forward',
      successful: true,
      gmailUrl: 'https://mail.google.com/mail/u/0/#all/19febe5d4b669eb2',
    });
    expect(connectorResultDetails(SEND_TOOL, content)).toEqual({
      kind: 'gmail-send',
      successful: true,
      gmailUrl: 'https://mail.google.com/mail/u/0/#all/19febe5d4b669eb2',
    });
    const safe = JSON.stringify(connectorResultDetails(SEND_TOOL, content));
    expect(safe).not.toContain('private-message-id');
    expect(safe).not.toContain('private-thread-id');
    expect(safe).not.toContain('private-log-id');
    expect(safe).not.toContain('labelIds');
    expect(connectorResultDetails(FORWARD_TOOL, {
      successful: true,
      data: { display_url: 'https://attacker.example/steal' },
    })).toEqual({ kind: 'gmail-forward', successful: true });
  });

  it('extracts safe Gmail send fields for Claude and Codex normalized names', () => {
    const input = {
      recipient_email: 'owner@example.com',
      extra_recipients: ['other@example.com'],
      subject: 'Veneer connection event test',
      body: 'This is a safe message preview.',
      access_token: 'must-not-cross-the-event-seam',
    };
    expect(connectorInputDetails(SEND_TOOL, input)).toEqual({
      kind: 'gmail-send',
      recipients: ['owner@example.com', 'other@example.com'],
      subject: 'Veneer connection event test',
      body: 'This is a safe message preview.',
    });
    expect(connectorInputDetails('mcp__codex_apps__gmail_send_email', { to: 'me, other@example.com', subject: 'App send' }))
      .toEqual({ kind: 'gmail-send', recipients: ['me', 'other@example.com'], subject: 'App send' });
    expect(connectorInputDetails('mcp__codex_apps__gmail.fetch_emails', { query: 'in:inbox from:me' }))
      .toEqual({ kind: 'gmail-fetch-list', searchSummary: 'Inbox · From me' });
  });

  it('extracts a human search summary and bounded safe fetch results', () => {
    expect(connectorInputDetails(FETCH_TOOL, {
      query: 'in:inbox -subject:"Veneer connection event test" newer_than:1d',
      access_token: 'private-token',
    })).toEqual({
      kind: 'gmail-fetch-list',
      searchSummary: 'Inbox · Excluding Subject “Veneer connection event test” · Newer than 1d',
    });

    const messages = Array.from({ length: 6 }, (_, index) => ({
      messageId: `raw-message-${index}`,
      threadId: `raw-thread-${index}`,
      subject: `Message ${index}`,
      sender: `Sender ${index} <sender${index}@example.com>`,
      messageTimestamp: `2026-08-0${index + 1}T12:00:00.000Z`,
      preview: { body: `Safe preview ${index}`, subject: `Ignored preview subject ${index}` },
      messageText: 'raw message body must not cross',
      payload: 'raw MIME must not cross',
    }));
    const details = connectorResultDetails(FETCH_TOOL, {
      successful: true,
      log_id: 'private-log-id',
      data: { messages, resultSizeEstimate: 201, nextPageToken: 'private-page-token' },
    });
    expect(details).toMatchObject({
      kind: 'gmail-fetch-list',
      successful: true,
      resultCount: 6,
      resultEstimate: 201,
      hasMore: true,
      messages: [
        { subject: 'Message 5', sender: 'Sender 5 <sender5@example.com>', preview: 'Safe preview 5' },
        { subject: 'Message 4' },
        { subject: 'Message 3' },
        { subject: 'Message 2' },
      ],
    });
    expect((details as { messages?: unknown[] }).messages).toHaveLength(4);
    const safe = JSON.stringify(details);
    expect(safe).not.toContain('raw-message-');
    expect(safe).not.toContain('raw-thread-');
    expect(safe).not.toContain('raw MIME');
    expect(safe).not.toContain('raw message body');
    expect(safe).not.toContain('private-log-id');
    expect(safe).not.toContain('private-page-token');
  });

  it('extracts bounded thread context without raw body, MIME, or ids', () => {
    const details = connectorResultDetails(THREAD_TOOL, {
      successful: true,
      data: {
        display_url: 'https://mail.google.com/mail/u/0/#inbox/thread',
        threadId: 'raw-thread-id',
        messages: [{
          messageId: 'raw-message-id',
          threadId: 'raw-thread-id',
          subject: 'Your ad was approved',
          sender: 'Sam <owner@example.com>',
          messageTimestamp: '2026-08-10T14:00:00.000Z',
          messageText: '<html>private full body</html>',
          payload: 'private raw MIME',
        }],
      },
    });
    expect(details).toMatchObject({
      kind: 'gmail-fetch-thread',
      successful: true,
      subject: 'Your ad was approved',
      latestSender: 'Sam <owner@example.com>',
      latestAt: '2026-08-10T14:00:00.000Z',
      messageCount: 1,
      gmailUrl: 'https://mail.google.com/mail/u/0/#inbox/thread',
      threadRef: expect.stringMatching(/^gmail-/),
    });
    const safe = JSON.stringify(details);
    expect(safe).not.toContain('raw-thread-id');
    expect(safe).not.toContain('raw-message-id');
    expect(safe).not.toContain('private full body');
    expect(safe).not.toContain('private raw MIME');
  });

  it('extracts one directly fetched message for safe forward correlation', () => {
    const input = connectorInputDetails(MESSAGE_TOOL, { message_id: 'raw-message-id' });
    expect(input).toMatchObject({ kind: 'gmail-fetch-message', messageRef: expect.stringMatching(/^gmail-/) });
    const details = connectorResultDetails(MESSAGE_TOOL, {
      successful: true,
      log_id: 'private-log-id',
      data: {
        display_url: 'https://mail.google.com/mail/u/0/#inbox/message',
        messageId: 'raw-message-id',
        threadId: 'raw-thread-id',
        subject: 'Daily digest — 3 awaiting, 1 hot',
        sender: 'Next Modular <daily@example.com>',
        messageTimestamp: '2026-08-10T13:00:00.000Z',
        preview: { body: 'Three jobs are awaiting a response.' },
        messageText: 'private full body',
        payload: 'private MIME',
      },
    });
    expect(details).toMatchObject({
      kind: 'gmail-fetch-message',
      successful: true,
      subject: 'Daily digest — 3 awaiting, 1 hot',
      sender: 'Next Modular <daily@example.com>',
      preview: 'Three jobs are awaiting a response.',
      messageRef: (input as { messageRef: string }).messageRef,
      gmailUrl: 'https://mail.google.com/mail/u/0/#inbox/message',
    });
    const safe = JSON.stringify(details);
    expect(safe).not.toContain('raw-message-id');
    expect(safe).not.toContain('raw-thread-id');
    expect(safe).not.toContain('private full body');
    expect(safe).not.toContain('private MIME');
    expect(safe).not.toContain('private-log-id');
  });

  it('extracts reply fields and covers failure with validated links only', () => {
    const input = connectorInputDetails(REPLY_TOOL, {
      thread_id: 'private-thread-id',
      recipient_email: 'owner@example.com',
      message_body: 'Received — this is a test reply.',
      is_html: false,
      log_id: 'private-log-id',
    });
    expect(input).toMatchObject({
      kind: 'gmail-reply',
      recipients: ['owner@example.com'],
      body: 'Received — this is a test reply.',
      threadRef: expect.stringMatching(/^gmail-/),
    });
    expect(JSON.stringify(input)).not.toContain('private-thread-id');
    expect(connectorResultDetails(REPLY_TOOL, {
      successful: false,
      error: { message: 'Permission denied', debug: 'private debug' },
      data: { display_url: 'javascript:alert(1)' },
    })).toEqual({ kind: 'gmail-reply', successful: false, error: 'Permission denied' });
  });

  it('extracts a safe Google Drive search summary for Claude and Codex normalized names', () => {
    const input = {
      q: "name contains 'P100159' and trashed = false",
      folder_id: 'private-folder-id',
      driveId: 'private-drive-id',
      access_token: 'private-token',
    };
    expect(connectorInputDetails(DRIVE_FIND_TOOL, input)).toEqual({
      kind: 'google-drive-find-file',
      searchSummary: 'Inside selected folder · Name contains “P100159” · Not in trash',
    });
    expect(connectorInputDetails('mcp__codex_apps__googledrive_find_file', {
      q: "fullText contains 'quarterly plan' and starred = true",
    })).toEqual({
      kind: 'google-drive-find-file',
      searchSummary: 'Content contains “quarterly plan” · Starred',
    });
    expect(connectorInputDetails(DRIVE_FIND_TOOL, {
      q: "'private-folder-id' in parents and (name contains 'P100159' or name contains 'P300125') and trashed = false",
    })).toEqual({
      kind: 'google-drive-find-file',
      searchSummary: 'Inside selected folder · 2 file names · Not in trash',
    });
    expect(connectorInputDetails(DRIVE_FIND_TOOL, {
      q: "mimeType != 'application/vnd.google-apps.folder' and trashed = false",
      orderBy: 'modifiedTime desc',
      pageSize: 5,
    })).toEqual({
      kind: 'google-drive-find-file',
      searchSummary: 'Recently modified · Files only · Not in trash',
    });
    const safe = JSON.stringify(connectorInputDetails(DRIVE_FIND_TOOL, input));
    expect(safe).not.toContain('private-folder-id');
    expect(safe).not.toContain('private-drive-id');
    expect(safe).not.toContain('private-token');
  });

  it('extracts bounded Drive file summaries and validates every link', () => {
    const files = Array.from({ length: 6 }, (_, index) => ({
      id: `private-file-id-${index}`,
      name: `File ${index}.pdf`,
      mimeType: index === 1 ? 'application/vnd.google-apps.document' : 'application/pdf',
      modifiedTime: `2026-08-0${index + 1}T12:00:00.000Z`,
      webViewLink: index === 2
        ? 'https://attacker.example/private-file-id-2'
        : `https://drive.google.com/file/d/safe-link-${index}/view`,
      parents: ['private-folder-id'],
      md5Checksum: 'private-checksum',
    }));
    const details = connectorResultDetails(DRIVE_FIND_TOOL, {
      successful: true,
      log_id: 'private-log-id',
      data: { files, nextPageToken: 'private-page-token' },
    });
    expect(details).toMatchObject({
      kind: 'google-drive-find-file',
      successful: true,
      resultCount: 6,
      hasMore: true,
      files: [
        { name: 'File 0.pdf', fileType: 'PDF', driveUrl: 'https://drive.google.com/file/d/safe-link-0/view' },
        { name: 'File 1.pdf', fileType: 'Google Doc' },
        { name: 'File 2.pdf', fileType: 'PDF' },
        { name: 'File 3.pdf', fileType: 'PDF' },
      ],
    });
    expect((details as { files?: unknown[] }).files).toHaveLength(4);
    expect((details as { files?: Array<{ driveUrl?: string }> }).files?.[2]?.driveUrl).toBeUndefined();
    const safe = JSON.stringify(details);
    for (const value of ['private-file-id-', 'private-folder-id', 'private-checksum', 'private-log-id', 'private-page-token', 'attacker.example']) {
      expect(safe).not.toContain(value);
    }
  });

  it('re-allowlists persisted Drive details without raw metadata', () => {
    const details = sanitizeConnectorDetails({
      kind: 'google-drive-find-file',
      successful: true,
      searchSummary: 'Name is “Roadmap”',
      resultCount: 1,
      files: [{
        id: 'private-file-id',
        name: 'Roadmap',
        fileType: 'Google Doc',
        modifiedAt: '2026-08-10T12:00:00.000Z',
        driveUrl: 'https://docs.google.com/document/d/safe-link/edit',
        parents: ['private-folder-id'],
        checksum: 'private-checksum',
      }],
      log_id: 'private-log-id',
    });
    expect(details).toEqual({
      kind: 'google-drive-find-file',
      successful: true,
      searchSummary: 'Name is “Roadmap”',
      resultCount: 1,
      files: [{
        name: 'Roadmap',
        fileType: 'Google Doc',
        modifiedAt: '2026-08-10T12:00:00.000Z',
        driveUrl: 'https://docs.google.com/document/d/safe-link/edit',
      }],
    });
    const safe = JSON.stringify(details);
    expect(safe).not.toContain('private-file-id');
    expect(safe).not.toContain('private-folder-id');
    expect(safe).not.toContain('private-checksum');
    expect(safe).not.toContain('private-log-id');
  });

  it('maps every supported Google Sheets action to an operation', () => {
    const operations = Object.fromEntries([
      'GET_SPREADSHEET_INFO', 'GET_SHEET_NAMES',
      'VALUES_GET', 'BATCH_GET', 'GET_SPREADSHEET_BY_DATA_FILTER',
      'SPREADSHEETS_VALUES_BATCH_GET_BY_DATA_FILTER',
      'VALUES_UPDATE', 'UPDATE_VALUES_BATCH', 'BATCH_UPDATE_VALUES_BY_DATA_FILTER',
      'UPSERT_ROWS', 'FIND_REPLACE',
      'SPREADSHEETS_VALUES_APPEND', 'CREATE_SPREADSHEET_ROW',
      'CLEAR_VALUES', 'SPREADSHEETS_VALUES_BATCH_CLEAR', 'BATCH_CLEAR_VALUES_BY_DATA_FILTER',
      'SEARCH_SPREADSHEETS', 'CREATE_GOOGLE_SHEET1',
      'LOOKUP_SPREADSHEET_ROW', 'AGGREGATE_COLUMN_DATA', 'ADD_SHEET',
    ].map((action) => [
      action,
      (connectorInputDetails(`mcp__googlesheets__GOOGLESHEETS_${action}`, {}) as { operation?: string }).operation,
    ]));
    expect(operations).toEqual({
      GET_SPREADSHEET_INFO: 'info', GET_SHEET_NAMES: 'info',
      VALUES_GET: 'read', BATCH_GET: 'read', GET_SPREADSHEET_BY_DATA_FILTER: 'read',
      SPREADSHEETS_VALUES_BATCH_GET_BY_DATA_FILTER: 'read',
      VALUES_UPDATE: 'write', UPDATE_VALUES_BATCH: 'write', BATCH_UPDATE_VALUES_BY_DATA_FILTER: 'write',
      UPSERT_ROWS: 'write', FIND_REPLACE: 'write',
      SPREADSHEETS_VALUES_APPEND: 'append', CREATE_SPREADSHEET_ROW: 'append',
      CLEAR_VALUES: 'clear', SPREADSHEETS_VALUES_BATCH_CLEAR: 'clear', BATCH_CLEAR_VALUES_BY_DATA_FILTER: 'clear',
      SEARCH_SPREADSHEETS: 'search', CREATE_GOOGLE_SHEET1: 'create',
      LOOKUP_SPREADSHEET_ROW: 'lookup', AGGREGATE_COLUMN_DATA: 'lookup', ADD_SHEET: 'other',
    });
    expect(connectorInputDetails(SHEETS_ADD_SHEET_TOOL, {})).toEqual({
      kind: 'google-sheets', operation: 'other', actionLabel: 'Add sheet',
    });
    expect(connectorInputDetails('mcp__codex_apps__googlesheets_values_get', {})).toMatchObject({
      kind: 'google-sheets', operation: 'read',
    });
    expect(connectorInputDetails('mcp__thirdparty__googlesheets_sync', { spreadsheet_id: 'private-spreadsheet-id' }))
      .toBeUndefined();
    expect(connectorResultDetails('mcp__thirdparty__googlesheets_sync', { successful: true })).toBeUndefined();
  });

  it('never reads row payloads as spreadsheet search results', () => {
    const details = connectorResultDetails('mcp__googlesheets__GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW', {
      successful: true,
      data: {
        results: [{ name: 'secret-cell' }],
        matching_rows: [{ row: 4 }, { row: 9 }],
        nextPageToken: 'private-page-token',
      },
    });
    expect(details).toEqual({
      kind: 'google-sheets',
      operation: 'lookup',
      successful: true,
      resultCount: 2,
    });
    const safe = JSON.stringify(details);
    expect(safe).not.toContain('secret-cell');
    expect(safe).not.toContain('private-page-token');
    expect(sanitizeConnectorDetails({
      kind: 'google-sheets',
      operation: 'lookup',
      resultCount: 2,
      hasMore: true,
      files: [{ name: 'secret-cell' }],
    })).toEqual({ kind: 'google-sheets', operation: 'lookup', resultCount: 2 });
  });

  it('keeps the spreadsheet id inside a validated link and drops every other input field', () => {
    const details = connectorInputDetails(SHEETS_READ_TOOL, {
      spreadsheet_id: 'private-spreadsheet-id',
      range: 'Budget!A1:D20',
      access_token: 'private-token',
      auth_config_id: 'private-auth-id',
    });
    expect(details).toEqual({
      kind: 'google-sheets',
      operation: 'read',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/private-spreadsheet-id/edit',
      range: 'Budget!A1:D20',
    });
    const safe = JSON.stringify(details);
    expect(safe).not.toContain('private-token');
    expect(safe).not.toContain('private-auth-id');
    expect(safe.split('private-spreadsheet-id').length - 1).toBe(1);
    expect(safe).toContain('docs.google.com/spreadsheets/d/private-spreadsheet-id/edit');

    expect(connectorInputDetails(SHEETS_APPEND_TOOL, {
      spreadsheet_id: 'private-spreadsheet-id',
      sheet_name: 'Budget',
      first_cell_location: 'A2',
      values: [['private cell value']],
    })).toMatchObject({ operation: 'append', range: 'Budget!A2' });
    expect(JSON.stringify(connectorInputDetails(SHEETS_APPEND_TOOL, {
      values: [['private cell value']],
    }))).not.toContain('private cell value');
    expect(connectorInputDetails(SHEETS_INFO_TOOL, { spreadsheet_id: '../../evil' })).toEqual({
      kind: 'google-sheets', operation: 'info',
    });
  });

  it('summarizes a spreadsheet info result with bounded sheet names', () => {
    const details = connectorResultDetails(SHEETS_INFO_TOOL, {
      successful: true,
      log_id: 'private-log-id',
      data: {
        spreadsheetId: 'private-spreadsheet-id',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/private-spreadsheet-id/edit',
        properties: { title: 'Budget', timeZone: 'America/New_York' },
        sheets: Array.from({ length: 7 }, (_, index) => ({
          properties: { title: `Sheet ${index}`, sheetId: index },
        })),
      },
    });
    expect(details).toEqual({
      kind: 'google-sheets',
      operation: 'info',
      successful: true,
      spreadsheetTitle: 'Budget',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/private-spreadsheet-id/edit',
      sheetNames: ['Sheet 0', 'Sheet 1', 'Sheet 2', 'Sheet 3', 'Sheet 4', 'Sheet 5'],
      hasMoreSheets: true,
    });
    expect(JSON.stringify(details)).not.toContain('private-log-id');
  });

  it('reports read dimensions without any cell values', () => {
    const details = connectorResultDetails(SHEETS_READ_TOOL, {
      successful: true,
      data: {
        range: 'Budget!A1:D3',
        majorDimension: 'ROWS',
        values: [
          ['Item', 'Cost', 'Owner', 'Notes'],
          ['private cell value', '12', 'Sam', 'private note'],
          ['Another', '3'],
        ],
      },
    });
    expect(details).toEqual({
      kind: 'google-sheets',
      operation: 'read',
      successful: true,
      range: 'Budget!A1:D3',
      rowCount: 3,
      columnCount: 4,
    });
    const safe = JSON.stringify(details);
    expect(safe).not.toContain('private cell value');
    expect(safe).not.toContain('private note');
  });

  it('reports write and append counts from Composio update envelopes', () => {
    expect(connectorResultDetails(SHEETS_UPDATE_TOOL, {
      successful: true,
      data: { spreadsheetId: 'private-spreadsheet-id', updatedRange: 'Budget!A1:D3', updatedCells: 12, updatedRows: 3 },
    })).toEqual({
      kind: 'google-sheets',
      operation: 'write',
      successful: true,
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/private-spreadsheet-id/edit',
      range: 'Budget!A1:D3',
      updatedCells: 12,
      updatedRows: 3,
    });
    expect(connectorResultDetails(SHEETS_APPEND_TOOL, {
      successful: true,
      data: { updates: { updatedRange: 'Budget!A4:D6', updatedCells: 9, updatedRows: 3 } },
    })).toEqual({
      kind: 'google-sheets',
      operation: 'append',
      successful: true,
      range: 'Budget!A4:D6',
      updatedCells: 9,
      updatedRows: 3,
    });
  });

  it('extracts bounded spreadsheet search results and validates every link', () => {
    const details = connectorResultDetails(SHEETS_SEARCH_TOOL, {
      successful: true,
      data: {
        spreadsheets: Array.from({ length: 5 }, (_, index) => ({
          id: `private-spreadsheet-id-${index}`,
          name: `Budget ${index}`,
          modifiedTime: `2026-09-0${index + 1}T12:00:00.000Z`,
          webViewLink: index === 1
            ? 'https://attacker.example/private-spreadsheet-id-1'
            : `https://docs.google.com/spreadsheets/d/safe-link-${index}/edit`,
        })),
        nextPageToken: 'private-page-token',
      },
    });
    expect(details).toMatchObject({
      kind: 'google-sheets',
      operation: 'search',
      successful: true,
      resultCount: 5,
      hasMore: true,
      files: [
        { name: 'Budget 0', url: 'https://docs.google.com/spreadsheets/d/safe-link-0/edit' },
        { name: 'Budget 1', url: 'https://docs.google.com/spreadsheets/d/private-spreadsheet-id-1/edit' },
        { name: 'Budget 2', url: 'https://docs.google.com/spreadsheets/d/safe-link-2/edit' },
        { name: 'Budget 3', url: 'https://docs.google.com/spreadsheets/d/safe-link-3/edit' },
      ],
    });
    expect((details as { files?: unknown[] }).files).toHaveLength(4);
    const safe = JSON.stringify(details);
    expect(safe).not.toContain('attacker.example');
    expect(safe).not.toContain('private-page-token');
  });

  it('keeps Google Sheets failures to a bounded message', () => {
    expect(connectorResultDetails(SHEETS_READ_TOOL, {
      successful: false,
      error: { message: 'Requested entity was not found.', debug: 'private debug' },
      data: { log_id: 'private-log-id' },
    })).toEqual({
      kind: 'google-sheets',
      operation: 'read',
      successful: false,
      error: 'Requested entity was not found.',
    });
  });

  it('re-allowlists persisted Google Sheets details without raw metadata', () => {
    const details = sanitizeConnectorDetails({
      kind: 'google-sheets',
      operation: 'read',
      successful: true,
      spreadsheetId: 'private-spreadsheet-id',
      spreadsheetTitle: 'Budget',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/safe-link/edit',
      range: 'Budget!A1:D3',
      rowCount: 3,
      columnCount: 4,
      values: [['private cell value']],
      access_token: 'private-token',
      log_id: 'private-log-id',
    });
    expect(details).toEqual({
      kind: 'google-sheets',
      operation: 'read',
      successful: true,
      spreadsheetTitle: 'Budget',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/safe-link/edit',
      range: 'Budget!A1:D3',
      rowCount: 3,
      columnCount: 4,
    });
    expect(sanitizeConnectorDetails({ kind: 'google-sheets', operation: 'nonsense' })).toEqual({
      kind: 'google-sheets', operation: 'other',
    });
    const safe = JSON.stringify(details);
    for (const value of ['private-spreadsheet-id', 'private cell value', 'private-token', 'private-log-id']) {
      expect(safe).not.toContain(value);
    }
  });

  it('ignores unsupported Gmail and other connector payloads', () => {
    expect(connectorInputDetails('mcp__gmail__GMAIL_CREATE_DRAFT', { body: 'draft' })).toBeUndefined();
    expect(connectorResultDetails('mcp__slack__SEND_MESSAGE', { successful: true })).toBeUndefined();
  });
});
