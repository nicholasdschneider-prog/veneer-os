import { requestJson } from './api';

/** Shared Tasks board (build #908): one list per bot chat over its tasks, questions, threads, handoffs and tickets. */
export type BoardGroup = 'ready_for_review' | 'needs_input' | 'working' | 'up_next' | 'completed';
export const BOARD_GROUPS: { id: BoardGroup; label: string }[] = [
  { id: 'ready_for_review', label: 'Ready for review' },
  { id: 'needs_input', label: 'Needs input' },
  { id: 'working', label: 'Doing work' },
  { id: 'up_next', label: 'Up next' },
  { id: 'completed', label: 'Completed' },
];
export interface BotTask {
  id: string;
  owner_conversation_id: string;
  title: string;
  brief: string;
  status: 'up_next' | 'working' | 'needs_input' | 'ready_for_review' | 'done';
  source: string;
  task_conversation_id: string | null;
  status_line: string;
  case_key: string | null;
  resources: string[];
  closed_by: 'human' | 'auto' | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  open_decision: { id: string; version: number; question: string } | null;
  thread_id: string | null;
}
/** Bots often prefix a title with its case key; show the key once, as the tag. */
export function cleanTaskTitle(title: string, caseKey: string | null): string {
  let t = title.trim();
  if (caseKey) { const re = new RegExp(`^(${caseKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[·:\\-–]\\s*)+`, 'i'); t = t.replace(re, ''); }
  return t || title;
}
export interface BoardRow {
  kind: 'task' | 'decision' | 'question' | 'thread' | 'handoff' | 'ticket';
  id: string;
  group: BoardGroup;
  title: string;
  status_line: string;
  tag: string;
  href: string;
  updated_at: string;
  can_mark: boolean;
  task?: BotTask;
  decision_id?: string;
}
export interface Board {
  chat: { id: string; title: string | null; bot_name: string; registered: boolean };
  rows: BoardRow[];
  counts: Record<BoardGroup, number>;
  needs_you: number;
}
export interface TaskEvent { id: string; kind: string; at: string; payload: Record<string, unknown> }
export const tasksApi = {
  board: (conversationId: string, signal?: AbortSignal) => requestJson<Board>(`/api/conversations/${encodeURIComponent(conversationId)}/tasks`, { signal }),
  task: (conversationId: string, taskId: string) => requestJson<{ task: BotTask; events: TaskEvent[] }>(`/api/conversations/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(taskId)}`),
  mark: (conversationId: string, body: { kind: 'task' | 'thread' | 'handoff'; id: string; mark: 'done' | 'reviewed' }) =>
    requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/tasks/mark`, { method: 'POST', body: JSON.stringify(body) }),
  discuss: (conversationId: string, taskId: string, body: { text: string; request_key: string }) =>
    requestJson<{ event_id: string; duplicate: boolean }>(`/api/conversations/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(taskId)}/discuss`, { method: 'POST', body: JSON.stringify(body) }),
};
/** Where the TASKS view of a chat lives; the toggle flips `view` and keeps the rest of the hash. */
export function tasksViewHash(conversationId: string, on: boolean): string {
  const [path, query = ''] = window.location.hash.split('?');
  const base = path && path.startsWith(`#/chat/${conversationId}`) ? path : `#/chat/${conversationId}`;
  const params = new URLSearchParams(query);
  if (on) params.set('view', 'tasks'); else params.delete('view');
  params.delete('side');
  const q = params.toString();
  return `${base}${q ? `?${q}` : ''}`;
}
export const TASKS_VIEW_KEY = (id: string) => `veneer.tasks-view.${id}`;
