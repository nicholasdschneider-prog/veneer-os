import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendShadowTranscript,
  readCodexTranscript,
} from '../src/providers/codex/transcript.js';

let root: string;
let transcriptsDir: string;
let savedCodexHome: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-connector-transcript-'));
  transcriptsDir = path.join(root, 'transcripts');
  fs.mkdirSync(transcriptsDir);
  savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
});

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Codex historical connector transcript details', () => {
  it('backfills only allowlisted Gmail send fields from its native MCP completion', async () => {
    const threadId = 'thread-with-old-send';
    const toolId = 'call-old-send';
    appendShadowTranscript(transcriptsDir, threadId, [
      {
        type: 'tool_started',
        turnId: 'turn-1',
        toolId,
        toolName: 'mcp__gmail-owner-example-com__GMAIL_SEND_EMAIL',
        displayName: 'Gmail · Send Email',
        inputPreview: '{historical bounded preview}',
        source: {
          kind: 'connector',
          slug: 'gmail',
          name: 'Gmail',
          mention: 'gmail-owner-example-com',
          action: 'Send Email',
        },
      },
      {
        type: 'tool_finished',
        turnId: 'turn-1',
        toolId,
        ok: true,
        resultPreview: '{historical bounded preview}',
      },
    ]);

    const sessionsDir = path.join(root, 'sessions', '2026', '08', '10');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `rollout-test-${threadId}.jsonl`), `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'mcp_tool_call_end',
        call_id: toolId,
        invocation: {
          server: 'gmail-owner-example-com',
          tool: 'GMAIL_SEND_EMAIL',
          arguments: {
            recipient_email: 'owner@example.com',
            subject: 'Veneer connection event test',
            body: 'This is the real safe body.',
            access_token: 'private-token',
          },
        },
        result: {
          Ok: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                data: {
                  display_url: 'https://mail.google.com/mail/u/0/#all/sent-message',
                  id: 'sent-message',
                  threadId: 'sent-thread',
                  labelIds: ['SENT'],
                },
                successful: true,
                log_id: 'private-log-id',
              }),
            }],
          },
        },
      },
    })}\n`);

    const events = await readCodexTranscript(transcriptsDir, threadId);
    expect(events[0]).toMatchObject({
      connectorDetails: {
        kind: 'gmail-send',
        recipients: ['owner@example.com'],
        subject: 'Veneer connection event test',
        body: 'This is the real safe body.',
      },
    });
    expect(events[1]).toMatchObject({
      connectorDetails: {
        kind: 'gmail-send',
        successful: true,
        gmailUrl: 'https://mail.google.com/mail/u/0/#all/sent-message',
      },
    });
    const safeDetails = JSON.stringify(events.map((event) =>
      'connectorDetails' in event ? event.connectorDetails : undefined));
    expect(safeDetails).not.toContain('private-token');
    expect(safeDetails).not.toContain('private-log-id');
  });

  it('rehydrates safe Gmail fetch and reply variants from historical native completions', async () => {
    const threadId = 'thread-with-old-fetch-reply';
    const fetchId = 'call-old-fetch';
    const replyId = 'call-old-reply';
    const source = {
      kind: 'connector' as const,
      slug: 'gmail',
      name: 'Gmail',
      mention: 'gmail-owner-example-com',
      action: 'Fetch Emails',
    };
    appendShadowTranscript(transcriptsDir, threadId, [
      {
        type: 'tool_started', turnId: 'turn-2', toolId: fetchId,
        toolName: 'mcp__gmail-owner-example-com__GMAIL_FETCH_EMAILS', displayName: 'Gmail',
        inputPreview: '{historical preview}', source,
      },
      { type: 'tool_finished', turnId: 'turn-2', toolId: fetchId, ok: true, resultPreview: '{historical preview}' },
      {
        type: 'tool_started', turnId: 'turn-2', toolId: replyId,
        toolName: 'mcp__gmail-owner-example-com__GMAIL_REPLY_TO_THREAD', displayName: 'Gmail',
        inputPreview: '{historical preview}', source: { ...source, action: 'Reply To Thread' },
      },
      { type: 'tool_finished', turnId: 'turn-2', toolId: replyId, ok: true, resultPreview: '{historical preview}' },
    ]);

    const sessionsDir = path.join(root, 'sessions', '2026', '08', '10');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const rows = [
      {
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end', call_id: fetchId,
          invocation: {
            server: 'gmail-owner-example-com', tool: 'GMAIL_FETCH_EMAILS',
            arguments: { query: 'in:inbox from:me', access_token: 'private-token' },
          },
          result: { Ok: { content: [{ type: 'text', text: JSON.stringify({
            successful: true,
            log_id: 'private-log-id',
            data: { messages: [{
              messageId: 'private-message-id', threadId: 'private-thread-id',
              subject: 'Your ad was approved', sender: 'Sam <owner@example.com>',
              messageTimestamp: '2026-08-10T14:00:00.000Z', payload: 'private MIME',
            }] },
          }) }] } },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end', call_id: replyId,
          invocation: {
            server: 'gmail-owner-example-com', tool: 'GMAIL_REPLY_TO_THREAD',
            arguments: {
              thread_id: 'private-thread-id', recipient_email: 'owner@example.com',
              message_body: 'Received, thank you.', access_token: 'private-token',
            },
          },
          result: { Ok: { content: [{ type: 'text', text: JSON.stringify({
            successful: true,
            data: { display_url: 'https://mail.google.com/mail/u/0/#inbox/reply' },
            log_id: 'private-log-id',
          }) }] } },
        },
      },
    ];
    fs.writeFileSync(
      path.join(sessionsDir, `rollout-test-${threadId}.jsonl`),
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );

    const events = await readCodexTranscript(transcriptsDir, threadId);
    expect(events[0]).toMatchObject({ connectorDetails: { kind: 'gmail-fetch-list', searchSummary: 'Inbox · From me' } });
    expect(events[1]).toMatchObject({
      connectorDetails: {
        kind: 'gmail-fetch-list', successful: true, resultCount: 1,
        messages: [{ subject: 'Your ad was approved', sender: 'Sam <owner@example.com>' }],
      },
    });
    expect(events[2]).toMatchObject({
      connectorDetails: {
        kind: 'gmail-reply', recipients: ['owner@example.com'], body: 'Received, thank you.',
      },
    });
    expect(events[3]).toMatchObject({
      connectorDetails: {
        kind: 'gmail-reply', successful: true, gmailUrl: 'https://mail.google.com/mail/u/0/#inbox/reply',
      },
    });
    const safe = JSON.stringify(events.map((event) => 'connectorDetails' in event ? event.connectorDetails : undefined));
    expect(safe).not.toContain('private-token');
    expect(safe).not.toContain('private-log-id');
    expect(safe).not.toContain('private-message-id');
    expect(safe).not.toContain('private-thread-id');
    expect(safe).not.toContain('private MIME');
  });

  it('rehydrates only allowlisted Google Drive find-file details', async () => {
    const threadId = 'thread-with-old-drive-find';
    const toolId = 'call-old-drive-find';
    appendShadowTranscript(transcriptsDir, threadId, [
      {
        type: 'tool_started', turnId: 'turn-drive', toolId,
        toolName: 'mcp__googledrive-everyone-16__GOOGLEDRIVE_FIND_FILE', displayName: 'Google Drive',
        inputPreview: '{historical preview}',
        source: {
          kind: 'connector', slug: 'googledrive', name: 'Google Drive',
          mention: 'googledrive-everyone-16', action: 'Find File', sharing: 'shared',
        },
      },
      {
        type: 'tool_finished', turnId: 'turn-drive', toolId, ok: true,
        resultPreview: '{historical preview}',
      },
    ]);

    const sessionsDir = path.join(root, 'sessions', '2026', '08', '10');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `rollout-test-${threadId}.jsonl`), `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'mcp_tool_call_end', call_id: toolId,
        invocation: {
          server: 'googledrive-everyone-16', tool: 'GOOGLEDRIVE_FIND_FILE',
          arguments: {
            q: "name contains 'Roadmap' and trashed = false",
            folder_id: 'private-folder-id', access_token: 'private-token',
          },
        },
        result: { Ok: { content: [{ type: 'text', text: JSON.stringify({
          successful: true,
          log_id: 'private-log-id',
          data: { files: [{
            id: 'private-file-id', name: 'Roadmap',
            mimeType: 'application/vnd.google-apps.document',
            modifiedTime: '2026-08-10T12:00:00.000Z',
            webViewLink: 'https://docs.google.com/document/d/safe-link/edit',
            parents: ['private-folder-id'], md5Checksum: 'private-checksum',
          }] },
        }) }] } },
      },
    })}\n`);

    const events = await readCodexTranscript(transcriptsDir, threadId);
    expect(events[0]).toMatchObject({
      connectorDetails: {
        kind: 'google-drive-find-file',
        searchSummary: 'Inside selected folder · Name contains “Roadmap” · Not in trash',
      },
    });
    expect(events[1]).toMatchObject({
      connectorDetails: {
        kind: 'google-drive-find-file', successful: true, resultCount: 1,
        files: [{
          name: 'Roadmap', fileType: 'Google Doc', modifiedAt: '2026-08-10T12:00:00.000Z',
          driveUrl: 'https://docs.google.com/document/d/safe-link/edit',
        }],
      },
    });
    const safe = JSON.stringify(events.map((event) => 'connectorDetails' in event ? event.connectorDetails : undefined));
    for (const value of ['private-token', 'private-log-id', 'private-file-id', 'private-folder-id', 'private-checksum']) {
      expect(safe).not.toContain(value);
    }
  });

  it('rehydrates only allowlisted Google Sheets details', async () => {
    const threadId = 'thread-with-old-sheets-read';
    const toolId = 'call-old-sheets-read';
    appendShadowTranscript(transcriptsDir, threadId, [
      {
        type: 'tool_started', turnId: 'turn-sheets', toolId,
        toolName: 'mcp__googlesheets__GOOGLESHEETS_VALUES_GET', displayName: 'Google Sheets',
        inputPreview: '{historical preview}',
        source: {
          kind: 'connector', slug: 'googlesheets', name: 'Google Sheets',
          mention: 'googlesheets', action: 'Values Get', sharing: 'personal',
        },
      },
      {
        type: 'tool_finished', turnId: 'turn-sheets', toolId, ok: true,
        resultPreview: '{historical preview}',
      },
    ]);

    const sessionsDir = path.join(root, 'sessions', '2026', '08', '10');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `rollout-test-${threadId}.jsonl`), `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'mcp_tool_call_end', call_id: toolId,
        invocation: {
          server: 'googlesheets', tool: 'GOOGLESHEETS_VALUES_GET',
          arguments: {
            spreadsheet_id: 'private-spreadsheet-id',
            range: 'Budget!A1:D3',
            access_token: 'private-token',
          },
        },
        result: { Ok: { content: [{ type: 'text', text: JSON.stringify({
          successful: true,
          log_id: 'private-log-id',
          data: {
            range: 'Budget!A1:D3',
            values: [['Item', 'Cost'], ['private cell value', '12']],
          },
        }) }] } },
      },
    })}\n`);

    const events = await readCodexTranscript(transcriptsDir, threadId);
    expect(events[0]).toMatchObject({
      connectorDetails: {
        kind: 'google-sheets', operation: 'read', range: 'Budget!A1:D3',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/private-spreadsheet-id/edit',
      },
    });
    expect(events[1]).toMatchObject({
      connectorDetails: {
        kind: 'google-sheets', operation: 'read', successful: true,
        range: 'Budget!A1:D3', rowCount: 2, columnCount: 2,
      },
    });
    const safe = JSON.stringify(events.map((event) => 'connectorDetails' in event ? event.connectorDetails : undefined));
    for (const value of ['private-token', 'private-log-id', 'private cell value']) {
      expect(safe).not.toContain(value);
    }
  });

  it('re-allowlists legacy persisted details when native history is unavailable', async () => {
    const threadId = 'thread-with-legacy-details';
    const toolId = 'call-legacy-forward';
    appendShadowTranscript(transcriptsDir, threadId, [
      {
        type: 'tool_started', turnId: 'turn-3', toolId,
        toolName: 'mcp__gmail-owner-example-com__GMAIL_FORWARD_MESSAGE', displayName: 'Gmail',
        inputPreview: '{historical preview}',
        source: {
          kind: 'connector', slug: 'gmail', name: 'Gmail', mention: 'gmail-owner-example-com', action: 'Forward Message',
        },
        connectorDetails: {
          kind: 'gmail-forward', messageId: 'private-message-id', recipients: ['owner@example.com'],
          log_id: 'private-log-id', access_token: 'private-token',
        } as never,
      },
      {
        type: 'tool_finished', turnId: 'turn-3', toolId, ok: true, resultPreview: '{historical preview}',
        connectorDetails: {
          kind: 'gmail-forward', successful: true,
          gmailUrl: 'https://mail.google.com/mail/u/0/#all/sent',
          resultMessageId: 'private-result-id', labels: ['SENT'], log_id: 'private-log-id',
        } as never,
      },
    ]);

    const events = await readCodexTranscript(transcriptsDir, threadId);
    expect(events[0]).toMatchObject({
      connectorDetails: {
        kind: 'gmail-forward', recipients: ['owner@example.com'], messageRef: expect.stringMatching(/^gmail-/),
      },
    });
    expect(events[1]).toMatchObject({
      connectorDetails: {
        kind: 'gmail-forward', successful: true,
        gmailUrl: 'https://mail.google.com/mail/u/0/#all/sent',
      },
    });
    const safe = JSON.stringify(events.map((event) => 'connectorDetails' in event ? event.connectorDetails : undefined));
    expect(safe).not.toContain('private-message-id');
    expect(safe).not.toContain('private-result-id');
    expect(safe).not.toContain('private-log-id');
    expect(safe).not.toContain('private-token');
    expect(safe).not.toContain('labels');
  });
});
