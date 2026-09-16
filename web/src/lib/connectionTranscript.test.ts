import { describe, expect, it } from 'vitest';
import { reduceEvents } from './transcript';
import type { ConversationEvent } from './types';

describe('connection transcript details', () => {
  it('merges safe connector input and result details into one tool item', () => {
    const source = {
      kind: 'connector' as const,
      slug: 'gmail',
      name: 'Gmail',
      mention: 'gmail',
      action: 'Forward message',
    };
    const events: ConversationEvent[] = [
      {
        type: 'tool_started',
        turnId: 'turn-1',
        toolId: 'tool-1',
        toolName: 'mcp__gmail__GMAIL_FORWARD_MESSAGE',
        displayName: 'Gmail',
        inputPreview: '',
        source,
        connectorDetails: {
          kind: 'gmail-forward',
          recipients: ['alex@example.com'],
          note: 'Would this daily digest be useful?',
        },
      },
      {
        type: 'tool_finished',
        turnId: 'turn-1',
        toolId: 'tool-1',
        ok: true,
        connectorDetails: {
          kind: 'gmail-forward',
          successful: true,
          gmailUrl: 'https://mail.google.com/mail/u/0/#all/sent-message',
        },
      },
    ];

    const [item] = reduceEvents({ items: [], streamingText: '' }, events).items;

    expect(item).toMatchObject({
      kind: 'tool',
      key: 'tool-tool-1',
      source,
      running: false,
      connectorDetails: {
        kind: 'gmail-forward',
        recipients: ['alex@example.com'],
        note: 'Would this daily digest be useful?',
        successful: true,
        gmailUrl: 'https://mail.google.com/mail/u/0/#all/sent-message',
      },
    });
  });

  it('merges Gmail send input and result details without raw previews', () => {
    const source = {
      kind: 'connector' as const,
      slug: 'gmail',
      name: 'Gmail',
      mention: 'gmail-owner-example-com',
      action: 'Send Email',
    };
    const events: ConversationEvent[] = [
      {
        type: 'tool_started',
        turnId: 'turn-2',
        toolId: 'tool-2',
        toolName: 'mcp__gmail_owner_example_com__GMAIL_SEND_EMAIL',
        displayName: 'Gmail',
        inputPreview: '{"raw":"input"}',
        source,
        connectorDetails: {
          kind: 'gmail-send',
          recipients: ['owner@example.com'],
          subject: 'Veneer connection event test',
          body: 'This is a safe message preview.',
        },
      },
      {
        type: 'tool_finished',
        turnId: 'turn-2',
        toolId: 'tool-2',
        ok: true,
        resultPreview: '{"log_id":"private-log-id"}',
        connectorDetails: {
          kind: 'gmail-send',
          successful: true,
          gmailUrl: 'https://mail.google.com/mail/u/0/#inbox/sent-message',
        },
      },
    ];

    const [item] = reduceEvents({ items: [], streamingText: '' }, events).items;

    expect(item).toMatchObject({
      kind: 'tool',
      running: false,
      connectorDetails: {
        kind: 'gmail-send',
        recipients: ['owner@example.com'],
        subject: 'Veneer connection event test',
        body: 'This is a safe message preview.',
        successful: true,
        gmailUrl: 'https://mail.google.com/mail/u/0/#inbox/sent-message',
      },
    });
  });

  it('merges safe Google Drive search input and result details', () => {
    const source = {
      kind: 'connector' as const,
      slug: 'googledrive',
      name: 'Google Drive',
      mention: 'googledrive-everyone-16',
      action: 'Find File',
    };
    const events: ConversationEvent[] = [
      {
        type: 'tool_started',
        turnId: 'turn-drive',
        toolId: 'tool-drive',
        toolName: 'mcp__googledrive-everyone-16__GOOGLEDRIVE_FIND_FILE',
        displayName: 'Google Drive',
        inputPreview: '{"folder_id":"private-folder-id"}',
        source,
        connectorDetails: {
          kind: 'google-drive-find-file',
          searchSummary: 'Name contains “Roadmap” · Not in trash',
        },
      },
      {
        type: 'tool_finished',
        turnId: 'turn-drive',
        toolId: 'tool-drive',
        ok: true,
        resultPreview: '{"id":"private-file-id","log_id":"private-log-id"}',
        connectorDetails: {
          kind: 'google-drive-find-file',
          successful: true,
          resultCount: 1,
          files: [{ name: 'Roadmap', fileType: 'Google Doc' }],
        },
      },
    ];

    const [item] = reduceEvents({ items: [], streamingText: '' }, events).items;
    expect(item).toMatchObject({
      kind: 'tool',
      source,
      running: false,
      connectorDetails: {
        kind: 'google-drive-find-file',
        searchSummary: 'Name contains “Roadmap” · Not in trash',
        successful: true,
        resultCount: 1,
        files: [{ name: 'Roadmap', fileType: 'Google Doc' }],
      },
    });
  });

  it('correlates a forward with safe source context from a preceding fetch', () => {
    const source = {
      kind: 'connector' as const,
      slug: 'gmail',
      name: 'Gmail',
      mention: 'gmail',
      action: 'Fetch emails',
    };
    const events: ConversationEvent[] = [
      {
        type: 'tool_started',
        turnId: 'turn-3',
        toolId: 'fetch-1',
        toolName: 'mcp__gmail__GMAIL_FETCH_EMAILS',
        displayName: 'Gmail',
        inputPreview: '',
        source,
        connectorDetails: { kind: 'gmail-fetch-list', searchSummary: 'Inbox' },
      },
      {
        type: 'tool_finished',
        turnId: 'turn-3',
        toolId: 'fetch-1',
        ok: true,
        connectorDetails: {
          kind: 'gmail-fetch-list',
          successful: true,
          resultCount: 1,
          messages: [{
            messageRef: 'gmail-opaque-message',
            threadRef: 'gmail-opaque-thread',
            subject: 'Your ad was approved',
            sender: 'Google Ads <ads@example.com>',
          }],
        },
      },
      {
        type: 'tool_started',
        turnId: 'turn-3',
        toolId: 'forward-1',
        toolName: 'mcp__gmail__GMAIL_FORWARD_MESSAGE',
        displayName: 'Gmail',
        inputPreview: '{"message_id":"raw-id-never-rendered"}',
        source: { ...source, action: 'Forward message' },
        connectorDetails: {
          kind: 'gmail-forward',
          messageRef: 'gmail-opaque-message',
          recipients: ['owner@example.com'],
        },
      },
      {
        type: 'tool_finished',
        turnId: 'turn-3',
        toolId: 'forward-1',
        ok: true,
        connectorDetails: { kind: 'gmail-forward', successful: true },
      },
    ];

    const state = reduceEvents({ items: [], streamingText: '' }, events);
    expect(state.items[1]).toMatchObject({
      kind: 'tool',
      connectorDetails: {
        kind: 'gmail-forward',
        sourceSubject: 'Your ad was approved',
        sourceSender: 'Google Ads <ads@example.com>',
      },
    });
  });

  it('correlates a forward with a directly fetched message', () => {
    const source = {
      kind: 'connector' as const,
      slug: 'gmail', name: 'Gmail', mention: 'gmail', action: 'Fetch message',
    };
    const state = reduceEvents({ items: [], streamingText: '' }, [
      {
        type: 'tool_started', turnId: 'turn-message', toolId: 'message-1',
        toolName: 'mcp__gmail__GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', displayName: 'Gmail',
        inputPreview: '', source,
        connectorDetails: { kind: 'gmail-fetch-message', messageRef: 'gmail-direct-message' },
      },
      {
        type: 'tool_finished', turnId: 'turn-message', toolId: 'message-1', ok: true,
        connectorDetails: {
          kind: 'gmail-fetch-message', successful: true, messageRef: 'gmail-direct-message',
          subject: 'Daily digest — 3 awaiting, 1 hot', sender: 'Next Modular <daily@example.com>',
        },
      },
      {
        type: 'tool_started', turnId: 'turn-message', toolId: 'forward-direct',
        toolName: 'mcp__gmail__GMAIL_FORWARD_MESSAGE', displayName: 'Gmail', inputPreview: '',
        source: { ...source, action: 'Forward message' },
        connectorDetails: {
          kind: 'gmail-forward', messageRef: 'gmail-direct-message', recipients: ['alex@example.com'],
        },
      },
      {
        type: 'tool_finished', turnId: 'turn-message', toolId: 'forward-direct', ok: true,
        connectorDetails: { kind: 'gmail-forward', successful: true },
      },
    ]);
    expect(state.items[1]).toMatchObject({
      kind: 'tool',
      connectorDetails: {
        kind: 'gmail-forward',
        sourceSubject: 'Daily digest — 3 awaiting, 1 hot',
        sourceSender: 'Next Modular <daily@example.com>',
      },
    });
  });

  it('correlates a reply across live reducer batches using safe thread context', () => {
    const source = {
      kind: 'connector' as const,
      slug: 'gmail',
      name: 'Gmail',
      mention: 'gmail',
      action: 'Fetch thread',
    };
    const initial = reduceEvents({ items: [], streamingText: '' }, [
      {
        type: 'tool_started',
        turnId: 'turn-4',
        toolId: 'thread-1',
        toolName: 'mcp__gmail__GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
        displayName: 'Gmail',
        inputPreview: '',
        source,
        connectorDetails: { kind: 'gmail-fetch-thread', threadRef: 'gmail-opaque-thread' },
      },
      {
        type: 'tool_finished',
        turnId: 'turn-4',
        toolId: 'thread-1',
        ok: true,
        connectorDetails: {
          kind: 'gmail-fetch-thread',
          successful: true,
          threadRef: 'gmail-opaque-thread',
          subject: 'Your ad was approved',
          latestSender: 'Sam <owner@example.com>',
          messageCount: 2,
        },
      },
    ]);
    const next = reduceEvents(initial, [
      {
        type: 'tool_started',
        turnId: 'turn-4',
        toolId: 'reply-1',
        toolName: 'mcp__gmail__GMAIL_REPLY_TO_THREAD',
        displayName: 'Gmail',
        inputPreview: '',
        source: { ...source, action: 'Reply to thread' },
        connectorDetails: {
          kind: 'gmail-reply',
          threadRef: 'gmail-opaque-thread',
          recipients: ['owner@example.com'],
          body: 'Received, thank you.',
        },
      },
      {
        type: 'tool_finished',
        turnId: 'turn-4',
        toolId: 'reply-1',
        ok: true,
        connectorDetails: { kind: 'gmail-reply', successful: true },
      },
    ]);

    expect(next.items[1]).toMatchObject({
      kind: 'tool',
      connectorDetails: {
        kind: 'gmail-reply',
        subject: 'Your ad was approved',
        recipients: ['owner@example.com'],
        body: 'Received, thank you.',
        successful: true,
      },
    });
  });

  it('refreshes context usage without adding a visible transcript item', () => {
    const initial = reduceEvents({ items: [], streamingText: '' }, [
      {
        type: 'turn_started',
        turnId: 'visible-turn',
        role: 'user',
        text: 'Keep this visible',
        at: '2026-08-19T12:00:00Z',
        via: 'web',
      },
    ]);

    expect(reduceEvents(initial, [{ type: 'context_compacted', contextTokens: null }])).toEqual(initial);
  });

  it('renders one muted notice for a live Claude compaction and deduplicates snapshot replay', () => {
    const initial = reduceEvents({ items: [], streamingText: '' }, [
      {
        type: 'turn_started',
        turnId: 'visible-turn',
        role: 'user',
        text: 'Keep this visible',
        at: '2026-08-19T12:00:00Z',
        via: 'web',
      },
    ]);
    const event = { type: 'context_compacted', contextTokens: null, notice: 'Context compacted.' } as const;
    const once = reduceEvents(initial, [event]);

    expect(once.items.at(-1)).toMatchObject({ kind: 'notice', message: 'Context compacted.' });
    expect(reduceEvents(once, [event])).toEqual(once);
  });
});
