import type { Conversation } from './types';

const NEW_CHAT_DRAFT_PREFIX = 'veneer.draft.new.v1';
const READY_HOLD_MS = 12_000;

function scopePart(value: string | null): string {
  return encodeURIComponent(value ?? 'none');
}

export function newChatDraftKey(projectId: string | null, todoId: string | null): string {
  return `${NEW_CHAT_DRAFT_PREFIX}.${scopePart(projectId)}.${scopePart(todoId)}`;
}

export function readNewChatDraft(projectId: string | null, todoId: string | null): string {
  try {
    return localStorage.getItem(newChatDraftKey(projectId, todoId)) ?? '';
  } catch {
    return '';
  }
}

export function writeNewChatDraft(projectId: string | null, todoId: string | null, draft: string): void {
  try {
    const key = newChatDraftKey(projectId, todoId);
    if (draft) localStorage.setItem(key, draft);
    else localStorage.removeItem(key);
  } catch {
    // Private mode or a full storage quota must not block the composer.
  }
}

export function moveNewChatDraft(
  fromProjectId: string | null,
  toProjectId: string | null,
  todoId: string | null,
  draft: string,
): void {
  if (fromProjectId === toProjectId) return;
  try {
    localStorage.removeItem(newChatDraftKey(fromProjectId, todoId));
  } catch {
    // Best-effort cleanup only.
  }
  writeNewChatDraft(toProjectId, todoId, draft);
}

export interface PendingNewChat {
  id: string;
  projectId: string | null;
  todoId: string | null;
  status: 'starting' | 'failed' | 'ready';
  conversation: Conversation | null;
}

let pending: PendingNewChat[] = [];
let version = 0;
const listeners = new Set<() => void>();
const readyTimers = new Map<string, ReturnType<typeof setTimeout>>();

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribePendingNewChats(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pendingNewChatsVersion(): number {
  return version;
}

export function listPendingNewChats(): readonly PendingNewChat[] {
  return pending;
}

export function startPendingNewChat(input: {
  id: string;
  projectId: string | null;
  todoId: string | null;
}): void {
  pending = pending.filter(
    (item) =>
      item.id !== input.id &&
      !(
        item.status === 'failed' &&
        item.projectId === input.projectId &&
        item.todoId === input.todoId
      ),
  );
  pending = [...pending, { ...input, status: 'starting', conversation: null }];
  notify();
}

export function completePendingNewChat(id: string, conversation: Conversation): void {
  pending = pending.map((item) =>
    item.id === id ? { ...item, status: 'ready', conversation } : item,
  );
  notify();
  readyTimers.set(
    id,
    setTimeout(() => clearPendingNewChat(id), READY_HOLD_MS),
  );
}

export function failPendingNewChat(id: string): void {
  pending = pending.map((item) =>
    item.id === id ? { ...item, status: 'failed', conversation: null } : item,
  );
  notify();
}

export function clearPendingNewChat(id: string): void {
  const timer = readyTimers.get(id);
  if (timer) clearTimeout(timer);
  readyTimers.delete(id);
  const next = pending.filter((item) => item.id !== id);
  if (next.length === pending.length) return;
  pending = next;
  notify();
}
