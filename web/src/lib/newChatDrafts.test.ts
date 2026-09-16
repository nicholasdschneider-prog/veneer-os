import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from './types';
import {
  clearPendingNewChat,
  completePendingNewChat,
  failPendingNewChat,
  listPendingNewChats,
  moveNewChatDraft,
  newChatDraftKey,
  readNewChatDraft,
  startPendingNewChat,
  writeNewChatDraft,
} from './newChatDrafts';

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  for (const item of listPendingNewChats()) clearPendingNewChat(item.id);
});

describe('new chat drafts', () => {
  it('keeps manual drafts separate by project and from to-do drafts', () => {
    writeNewChatDraft('project-a', null, 'Alpha prompt');
    writeNewChatDraft('project-b', null, 'Beta prompt');
    writeNewChatDraft('project-a', 'todo-1', 'To-do prompt');

    expect(readNewChatDraft('project-a', null)).toBe('Alpha prompt');
    expect(readNewChatDraft('project-b', null)).toBe('Beta prompt');
    expect(readNewChatDraft('project-a', 'todo-1')).toBe('To-do prompt');
    expect(newChatDraftKey(null, null)).not.toBe(newChatDraftKey('project-a', null));
  });

  it('moves a draft when its project changes', () => {
    writeNewChatDraft('project-a', null, 'Move me');
    moveNewChatDraft('project-a', 'project-b', null, 'Move me');

    expect(readNewChatDraft('project-a', null)).toBe('');
    expect(readNewChatDraft('project-b', null)).toBe('Move me');
  });
});

describe('pending new chats', () => {
  it('moves from starting to ready with the same optimistic id', () => {
    startPendingNewChat({ id: 'chat-1', projectId: 'project-a', todoId: null });
    expect(listPendingNewChats()).toMatchObject([{ id: 'chat-1', status: 'starting' }]);

    const conversation = { id: 'chat-1', projectId: 'project-a' } as Conversation;
    completePendingNewChat('chat-1', conversation);
    expect(listPendingNewChats()).toMatchObject([
      { id: 'chat-1', status: 'ready', conversation: { id: 'chat-1' } },
    ]);
  });

  it('keeps a failed placeholder until a retry replaces it', () => {
    startPendingNewChat({ id: 'chat-1', projectId: 'project-a', todoId: null });
    failPendingNewChat('chat-1');
    startPendingNewChat({ id: 'chat-2', projectId: 'project-a', todoId: null });

    expect(listPendingNewChats()).toMatchObject([{ id: 'chat-2', status: 'starting' }]);
  });
});
