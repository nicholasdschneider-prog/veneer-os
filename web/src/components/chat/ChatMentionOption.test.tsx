import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Conversation } from '../../lib/types';
import { ChatMentionOption, sortChatsByRecentUse } from './ChatMentionOption';

function conversation(id: string, lastActiveAt: string, title = id): Conversation {
  return {
    id,
    title,
    visibility: 'team',
    canSend: true,
    canManage: true,
    canChangeVisibility: true,
    creator: { id: 1, displayName: 'Sam' },
    provider: 'codex',
    model: null,
    effort: null,
    approvalMode: null,
    effectiveApprovalMode: 'ask',
    fullAccess: false,
    channel: 'web',
    assistantSlug: 'platform-dev',
    assistantName: 'Platform Dev',
    projectId: 'crew-seating',
    originConversationId: null,
    archived: false,
    pinOrder: null,
    createdAt: '2026-08-01 12:00:00',
    lastActiveAt,
    contextTokens: null,
    status: 'idle',
    activity: null,
    unread: false,
    hasPendingWakeup: false,
    automation: null,
  };
}

describe('chat mention options', () => {
  it('sorts chats by most recent use without mutating the API result', () => {
    const pinnedOlder = conversation('older', '2026-08-08 12:00:00');
    pinnedOlder.pinOrder = 0;
    const chats = [
      pinnedOlder,
      conversation('newest', '2026-08-10 12:00:00'),
      conversation('middle', '2026-08-09 12:00:00'),
    ];

    expect(sortChatsByRecentUse(chats).map((chat) => chat.id)).toEqual(['newest', 'middle', 'older']);
    expect(chats.map((chat) => chat.id)).toEqual(['older', 'newest', 'middle']);
  });

  it('shows the project after the chat name and omits the agent type', () => {
    const html = renderToStaticMarkup(
      <ChatMentionOption
        conversation={conversation('chat-one', '2026-08-10 12:00:00', 'Seating plan')}
        projectName="Crew Seating"
      />,
    );

    expect(html.indexOf('Seating plan')).toBeLessThan(html.indexOf('Crew Seating'));
    expect(html).toContain('text-xs');
    expect(html).toContain('text-muted-foreground');
    expect(html).not.toContain('Platform Dev');
  });

  it('does not add a placeholder project label to unfiled chats', () => {
    const html = renderToStaticMarkup(
      <ChatMentionOption conversation={conversation('chat-one', '2026-08-10 12:00:00')} projectName={null} />,
    );

    expect(html).not.toContain('Unfiled');
  });
});
