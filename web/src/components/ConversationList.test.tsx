import { renderToStaticMarkup } from 'react-dom/server';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import type { Conversation } from '../lib/types';
import {
  ConversationList,
  ConversationRowMenuItems,
  getConversationListPagination,
  updateConversationPin,
} from './ConversationList';

const baseConversation: Conversation = {
  id: 'conversation',
  title: 'Chat',
  visibility: 'team',
  canSend: true,
  canManage: true,
  canChangeVisibility: true,
  creator: { id: 1, displayName: 'Sam' },
  provider: 'codex',
  model: null,
  effort: null,
  approvalMode: null,
  effectiveApprovalMode: 'auto',
  fullAccess: false,
  channel: 'web',
  assistantSlug: 'assistant',
  assistantName: 'Assistant',
  projectId: null,
  originConversationId: null,
  archived: false,
  pinOrder: null,
  createdAt: '2026-08-05 12:00:00',
  lastActiveAt: '2026-08-05 12:00:00',
  contextTokens: null,
  status: 'idle',
  activity: null,
  unread: false,
  hasPendingWakeup: false,
  automation: null,
};

function renderList(
  conversations: Conversation[],
  iconMode?: 'provider' | 'creator',
  extras?: { selectedId?: string | null; focusedId?: string | null; archivedView?: boolean },
) {
  return renderToStaticMarkup(
    <ConversationList
      conversations={conversations}
      onOpen={vi.fn()}
      onRemoved={vi.fn()}
      onChanged={vi.fn()}
      iconMode={iconMode}
      selectedId={extras?.selectedId}
      focusedId={extras?.focusedId}
      archivedView={extras?.archivedView}
    />,
  );
}

function renderRowMenu(conversation: Conversation, compacting = false, onMove?: () => void) {
  return renderToStaticMarkup(
    <DropdownMenuPrimitive.Root open>
      <DropdownMenuPrimitive.Content forceMount>
        <ConversationRowMenuItems
          conversation={conversation}
          compacting={compacting}
          onTogglePin={vi.fn()}
          onMarkUnread={vi.fn()}
          onCompact={vi.fn()}
          onMove={onMove}
          onArchive={vi.fn()}
          onDelete={vi.fn()}
        />
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Root>,
  );
}

describe('ConversationList pins', () => {
  it('marks the requested return target for scrolling and highlighting', () => {
    const html = renderList([baseConversation], undefined, { focusedId: baseConversation.id });

    expect(html).toContain('data-conversation-id="conversation"');
    expect(html).toContain('data-focus-target="true"');
    expect(html).toContain('ring-brand/40');
  });

  it('groups Compact context with Pin and Archive in each chat overflow menu', () => {
    const html = renderRowMenu(baseConversation);
    const pin = html.indexOf('Pin chat');
    const compact = html.indexOf('Compact context');
    const archive = html.indexOf('Archive chat');
    const separator = html.indexOf('data-slot="dropdown-menu-separator"');
    const deleteChat = html.indexOf('Delete chat…');

    expect(pin).toBeGreaterThan(-1);
    expect(pin).toBeLessThan(compact);
    expect(compact).toBeLessThan(archive);
    expect(archive).toBeLessThan(separator);
    expect(separator).toBeLessThan(deleteChat);
  });

  it('offers Move to project only when a handler is given and the chat is idle', () => {
    expect(renderRowMenu(baseConversation)).not.toContain('Move to project…');
    const idle = renderRowMenu(baseConversation, false, vi.fn());
    const working = renderRowMenu({ ...baseConversation, status: 'working' }, false, vi.fn());
    const move = idle.indexOf('Move to project…');
    expect(move).toBeGreaterThan(idle.indexOf('Compact context'));
    expect(move).toBeLessThan(idle.indexOf('Archive chat'));
    expect(working).toMatch(/data-disabled=""[^>]*>[^<]*<svg[^>]*lucide-folder-input/);
  });

  it('shows explicit disabled compaction states for unavailable and running chats', () => {
    const unavailable = renderRowMenu({ ...baseConversation, provider: 'grok' });
    const working = renderRowMenu({ ...baseConversation, status: 'working' });
    const compacting = renderRowMenu(baseConversation, true);

    expect(unavailable).toContain('Context compaction unavailable');
    expect(unavailable).toContain('data-disabled');
    expect(working).toContain('Compact context');
    expect(working).toContain('Wait for the current reply to finish.');
    expect(compacting).toContain('Compacting context…');
    expect(compacting).toContain('data-disabled');
  });

  it('shows the animated activity orb for a working chat', () => {
    const html = renderList([{ ...baseConversation, status: 'working' }]);

    expect(html).toContain('<canvas');
    expect(html).toContain('Working…');
    expect(html).not.toContain('vp-working-smiley');
  });

  it('labels server-authoritative Claude and Codex compaction instead of generic work', () => {
    const html = renderList([
      { ...baseConversation, id: 'claude-chat', provider: 'claude', status: 'working', activity: 'compacting' },
      { ...baseConversation, id: 'codex-chat', provider: 'codex', status: 'working', activity: 'compacting' },
    ]);

    expect(html.match(/>Compacting…</g)).toHaveLength(2);
    expect(html.match(/aria-label="Compacting…"/g)).toHaveLength(2);
    expect(html).not.toContain('Working…');
    expect(html.match(/<canvas/g)).toHaveLength(2);
  });

  it('shows an unread pip only when idle and the chat is not open', () => {
    const unread = renderList([{ ...baseConversation, unread: true }]);
    expect(unread).toContain('aria-label="Unread"');
    expect(unread).toContain('bg-brand');

    const open = renderList([{ ...baseConversation, unread: true }], undefined, {
      selectedId: baseConversation.id,
    });
    expect(open).not.toContain('aria-label="Unread"');

    const archived = renderList([{ ...baseConversation, unread: true, archived: true }], undefined, {
      archivedView: true,
    });
    expect(archived).not.toContain('aria-label="Unread"');
  });

  it('shows a wake-up clock immediately before the title only for that chat', () => {
    const html = renderList([
      { ...baseConversation, id: 'sleeping', title: 'Sleeping agent' },
      { ...baseConversation, id: 'scheduled', title: 'Scheduled agent', hasPendingWakeup: true },
    ]);

    expect(html.match(/Agent has a scheduled wake-up/g)).toHaveLength(2); // title + aria-label
    expect(html.indexOf('Agent has a scheduled wake-up')).toBeLessThan(html.indexOf('Scheduled agent'));
    expect(html.indexOf('Agent has a scheduled wake-up')).toBeGreaterThan(html.indexOf('Sleeping agent'));
  });

  it('offers Mark as unread in the row menu', () => {
    const html = renderRowMenu(baseConversation);
    expect(html).toContain('Mark as unread');
    expect(html.indexOf('Pin')).toBeLessThan(html.indexOf('Mark as unread'));
  });

  it('shows the colour provider glyph only while the row is unread', () => {
    const unread = renderList([{ ...baseConversation, unread: true }]);
    expect(unread).toContain('fill="url(#');

    const read = renderList([baseConversation]);
    expect(read).not.toContain('fill="url(#');
    expect(read).toContain('fill="currentColor"');

    const open = renderList([{ ...baseConversation, unread: true }], undefined, {
      selectedId: baseConversation.id,
    });
    expect(open).not.toContain('fill="url(#');
  });

  it('shows the colour provider glyph while the agent is working or waiting on you', () => {
    expect(renderList([{ ...baseConversation, status: 'working' }])).toContain('fill="url(#');
    expect(renderList([{ ...baseConversation, status: 'needs_you' }])).toContain('fill="url(#');
    expect(renderList([{ ...baseConversation, activity: 'compacting' }])).toContain('fill="url(#');
    expect(
      renderList([{ ...baseConversation, status: 'working' }], undefined, { selectedId: baseConversation.id }),
    ).toContain('fill="url(#');
    expect(renderList([baseConversation])).not.toContain('fill="url(#');
  });

  it('fades chats not touched today unless they are unread or open', () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const today = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(
      now.getUTCHours(),
    )}:${pad(now.getUTCMinutes())}:00`;

    const fresh = renderList([{ ...baseConversation, lastActiveAt: today }]);
    expect(fresh).not.toContain('opacity-75');
    expect(fresh).toContain('text-[13px] font-normal text-neutral-950 dark:text-white');
    const stale = renderList([baseConversation]);
    expect(stale).toContain('text-[13px] font-normal opacity-75');
    expect(stale).not.toContain('text-neutral-950');
    expect(renderList([{ ...baseConversation, unread: true }])).not.toContain('opacity-75');
    expect(renderList([baseConversation], undefined, { selectedId: baseConversation.id })).not.toContain(
      'opacity-75',
    );
  });

  it('keeps working, approval, and failed markers above the unread pip', () => {
    const working = renderList([{ ...baseConversation, status: 'working', unread: true }]);
    expect(working).toContain('<canvas');
    expect(working).not.toContain('aria-label="Unread"');

    const needsYou = renderList([{ ...baseConversation, status: 'needs_you', unread: true }]);
    expect(needsYou).toContain('bg-amber-500');
    expect(needsYou).not.toContain('aria-label="Unread"');

    const failed = renderList([{ ...baseConversation, status: 'failed', unread: true }]);
    expect(failed).toContain('aria-label="Failed"');
    expect(failed).toContain('text-destructive');
    expect(failed).toMatch(/>!</);
    expect(failed).not.toContain('bg-destructive');
    expect(failed).not.toContain('aria-label="Unread"');
  });

  it('shows a rightmost direct Unpin button and the overflow trigger for a manageable pinned chat', () => {
    const html = renderList([{ ...baseConversation, id: 'pinned', title: 'Important chat', pinOrder: 0 }]);

    expect(html).toContain('aria-label="More actions for Important chat"');
    expect(html).toContain('aria-label="Unpin Important chat"');
    expect(html).toContain('title="Unpin chat"');
    expect(html).toContain('pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)]');
    expect(html).toContain('fill-current');
    expect(html).not.toContain('aria-label="Pinned chat"');
    expect(html.indexOf('More actions for Important chat')).toBeLessThan(html.indexOf('Unpin Important chat'));
    expect(html).not.toContain('Reorder pinned chat');
    expect(html).not.toMatch(/<h2[^>]*>Pinned<\/h2>/);
  });

  it('keeps a passive right-edge pin marker for a pinned chat the viewer cannot manage', () => {
    const html = renderList([
      { ...baseConversation, id: 'shared', title: 'Shared chat', pinOrder: 0, canManage: false },
    ]);

    expect(html).toContain('aria-label="Pinned chat"');
    expect(html).toContain('title="Pinned"');
    expect(html).toContain('size-8 shrink-0 items-center justify-center text-brand');
    expect(html).not.toContain('aria-label="Unpin Shared chat"');
    expect(html).not.toContain('More actions for Shared chat');
  });

  it('keeps a single overflow trigger visible on touch and reveals it on desktop hover', () => {
    const html = renderList([{ ...baseConversation, id: 'regular', title: 'Regular chat' }]);

    expect(html).toContain('aria-label="More actions for Regular chat"');
    expect(html).toContain('opacity-100 md:opacity-0 md:group-hover:opacity-100');
    expect(html).not.toContain('aria-label="Pinned chat"');
    expect(html).not.toContain('aria-label="Pin conversation"');
    expect(html).not.toContain('fill-current');
  });

  it('does not expose management actions for a chat the viewer cannot manage', () => {
    const html = renderList([{ ...baseConversation, canManage: false }]);

    expect(html).not.toContain('More actions for');
  });

  it('sends an unpin update and returns the updated list in display order', async () => {
    const pinned = { ...baseConversation, id: 'pinned', title: 'Important chat', pinOrder: 0 };
    const regular = {
      ...baseConversation,
      id: 'regular',
      title: 'Regular chat',
      lastActiveAt: '2026-08-06 12:00:00',
    };
    const updated = { ...pinned, pinOrder: null };
    const update = vi.spyOn(api, 'updateConversation').mockResolvedValueOnce({ conversation: updated });

    await expect(updateConversationPin([pinned, regular], pinned, 'activity')).resolves.toEqual([
      regular,
      updated,
    ]);
    expect(update).toHaveBeenCalledWith('pinned', { pinned: false });

    update.mockRestore();
  });
});

describe('ConversationList icons', () => {
  it('keeps provider logos as the default', () => {
    const html = renderList([baseConversation]);

    expect(html).toContain('aria-label="Codex"');
    expect(html).not.toContain('aria-label="Created by Sam"');
  });

  it('shows the creator initial with an accessible creator label', () => {
    const html = renderList([baseConversation], 'creator');

    expect(html).toContain('aria-label="Created by Sam"');
    expect(html).toContain('>S</span>');
    expect(html).not.toContain('aria-label="Codex"');
  });

  it('uses the existing unknown-user fallback safely', () => {
    const html = renderList(
      [{ ...baseConversation, creator: { id: 99, displayName: 'Unknown user' } }],
      'creator',
    );

    expect(html).toContain('aria-label="Created by Unknown user"');
    expect(html).toContain('>U</span>');
  });
});

describe('ConversationList top-level pagination', () => {
  it('keeps handoff agents collapsed behind their existing disclosure', () => {
    const parent = { ...baseConversation, id: 'parent', title: 'Parent' };
    const handoff = {
      ...baseConversation,
      id: 'handoff',
      title: 'Nested handoff title',
      originConversationId: parent.id,
    };

    const html = renderList([parent, handoff]);

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('1 handoff agent');
    expect(html).not.toContain('Nested handoff title');
  });

  it('bubbles an unread grandchild onto the collapsed handoff row', () => {
    const parent = { ...baseConversation, id: 'parent', title: 'Parent' };
    const child = {
      ...baseConversation,
      id: 'child',
      title: 'Child handoff',
      originConversationId: parent.id,
    };
    const grandchild = {
      ...baseConversation,
      id: 'grandchild',
      title: 'Grandchild handoff',
      originConversationId: child.id,
      unread: true,
    };

    const html = renderList([parent, child, grandchild]);
    expect(html).toContain('1 handoff agent');
    expect(html).toContain('aria-label="Unread"');
    expect(html).not.toContain('Child handoff');
    expect(html).not.toContain('Grandchild handoff');
  });

  it('does not count a nested handoff agent toward the project row cap', () => {
    const parent = { ...baseConversation, id: 'parent', title: 'Parent' };
    const topLevel = Array.from({ length: 9 }, (_, index) => ({
      ...baseConversation,
      id: `top-level-${index}`,
      title: `Top level ${index}`,
      createdAt: `2026-08-0${index + 1} 12:00:00`,
    }));
    const handoff = {
      ...baseConversation,
      id: 'handoff',
      title: 'Handoff',
      originConversationId: parent.id,
      createdAt: '2026-08-10 12:00:00',
    };

    expect(getConversationListPagination([parent, ...topLevel, handoff], null, 'created').topLevelCount).toBe(10);
  });

  it('keeps pinned and orphaned handoff chats in the top-level count', () => {
    const parent = { ...baseConversation, id: 'parent', title: 'Parent' };
    const nested = { ...baseConversation, id: 'nested', originConversationId: parent.id };
    const pinned = { ...baseConversation, id: 'pinned', originConversationId: parent.id, pinOrder: 0 };
    const orphan = { ...baseConversation, id: 'orphan', originConversationId: 'missing' };

    expect(getConversationListPagination([parent, nested, pinned, orphan], null)).toMatchObject({
      topLevelCount: 3,
    });
  });

  it('uses the top-level parent position when the selected chat is a nested handoff', () => {
    const recent = Array.from({ length: 10 }, (_, index) => ({
      ...baseConversation,
      id: `recent-${index}`,
      createdAt: `2026-08-${String(20 - index).padStart(2, '0')} 12:00:00`,
    }));
    const olderParent = {
      ...baseConversation,
      id: 'older-parent',
      createdAt: '2026-08-01 12:00:00',
    };
    const selectedHandoff = {
      ...baseConversation,
      id: 'selected-handoff',
      originConversationId: olderParent.id,
      createdAt: '2026-08-02 12:00:00',
    };

    expect(
      getConversationListPagination([...recent, olderParent, selectedHandoff], selectedHandoff.id, 'created'),
    ).toEqual({ topLevelCount: 11, selectedTopLevelIndex: 10 });
  });
});
