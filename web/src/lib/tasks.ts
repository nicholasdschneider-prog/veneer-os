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
export interface CustomerThreadMessage { id: string; direction: 'in' | 'out' | 'note'; channel: string; author: string; author_label: string; body: string; attachments: { name: string; reference?: string }[]; at: string }
export interface CustomerThread {
  ticket: { id: string; orderops_ticket_id: string; code: string | null; subject: string; customer_name: string; customer_email: string; customer_phone: string; status: string } | null;
  messages: CustomerThreadMessage[];
  checked_at: string | null;
  added?: number;
  error: string | null;
}
/** Once the human opens the customer thread, keep it open for other tasks in this browser session. */
export const CUSTOMER_THREAD_KEY = 'veneer.tasks.customer-thread';
export function customerThreadPreferred(): boolean { try { return sessionStorage.getItem(CUSTOMER_THREAD_KEY) === 'open'; } catch { return false; } }
export function rememberCustomerThread(open: boolean): void { try { if (open) sessionStorage.setItem(CUSTOMER_THREAD_KEY, 'open'); else sessionStorage.removeItem(CUSTOMER_THREAD_KEY); } catch { /* ignore */ } }
export const tasksApi = {
  board: (conversationId: string, signal?: AbortSignal) => requestJson<Board>(`/api/conversations/${encodeURIComponent(conversationId)}/tasks`, { signal }),
  task: (conversationId: string, taskId: string) => requestJson<{ task: BotTask; events: TaskEvent[]; bot_name: string }>(`/api/conversations/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(taskId)}`),
  mark: (conversationId: string, body: { kind: 'task' | 'thread' | 'handoff'; id: string; mark: 'done' | 'reviewed' }) =>
    requestJson(`/api/conversations/${encodeURIComponent(conversationId)}/tasks/mark`, { method: 'POST', body: JSON.stringify(body) }),
  customerThread: (conversationId: string, taskId: string, refresh = false) =>
    requestJson<CustomerThread>(`/api/conversations/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(taskId)}/customer-thread${refresh ? '?refresh=1' : ''}`),
  discuss: (conversationId: string, taskId: string, body: { text: string; request_key: string; attachments?: { name: string; reference: string }[] }) =>
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
/** The board with one task open in its pane (or closed when taskId is null). */
export function taskPaneHash(conversationId: string, taskId: string | null): string {
  const base = tasksViewHash(conversationId, true);
  const [path, query = ''] = base.split('?');
  const params = new URLSearchParams(query);
  if (taskId) params.set('task', taskId); else params.delete('task');
  return `${path}?${params.toString()}`;
}
/** The task's own conversation plus the human's board notes, in time order, so the pane reads as one exchange. */
export function interleaveDiscussion<T extends { at: string }>(turns: T[], events: TaskEvent[]): Array<{ kind: 'turn'; at: string; turn: T } | { kind: 'note'; at: string; event: TaskEvent }> {
  const notes = events.filter((e) => e.kind === 'discussion').map((event) => ({ kind: 'note' as const, at: event.at.includes('T') ? event.at : `${event.at.replace(' ', 'T')}Z`, event }));
  const all = [...turns.map((turn) => ({ kind: 'turn' as const, at: turn.at, turn })), ...notes];
  return all.sort((a, b) => a.at.localeCompare(b.at));
}
