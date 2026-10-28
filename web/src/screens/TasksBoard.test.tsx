import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { groupRows, TaskPane, TasksBoard } from './TasksBoard';
import { cleanTaskTitle, interleaveDiscussion, taskPaneHash, type BoardRow, type TaskEvent } from '@/lib/tasks';

vi.mock('@/lib/tasks', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/tasks')>()), tasksApi: { board: () => new Promise(() => {}), task: () => new Promise(() => {}), mark: vi.fn(), discuss: vi.fn() } }));
vi.mock('@/components/BotComposer', () => ({ BotComposer: ({ botName }: { botName: string }) => <div data-testid="composer">composer for {botName}</div> }));

const row = (over: Partial<BoardRow>): BoardRow => ({ kind: 'task', id: 'a', group: 'working', title: 'T', status_line: 'Working', tag: 'case 1', href: '#/chat/x', updated_at: '2026-10-28T13:00:00Z', can_mark: true, ...over });

describe('tasks board', () => {
  it('groups active rows in board order and keeps Completed as its own filter', () => {
    const rows = [row({ id: '1', group: 'working' }), row({ id: '2', group: 'needs_input' }), row({ id: '3', group: 'completed' }), row({ id: '4', group: 'ready_for_review' })];
    expect(groupRows(rows, false).map((g) => [g.id, g.rows.map((r) => r.id)])).toEqual([['ready_for_review', ['4']], ['needs_input', ['2']], ['working', ['1']]]);
    expect(groupRows(rows, true).map((g) => [g.id, g.rows.map((r) => r.id)])).toEqual([['completed', ['3']]]);
  });
  it('shows a bot-written case key once, as the tag, not twice in the title', () => {
    expect(cleanTaskTitle('FWDR22 · FWDR22 · Refrigerator display board still unresolved', 'FWDR22')).toBe('Refrigerator display board still unresolved');
    expect(cleanTaskTitle('Chargeback 4521 for Dean Marsh', 'cb-4521')).toBe('Chargeback 4521 for Dean Marsh');
    expect(cleanTaskTitle('X · ', 'X')).toBe('X · ');
  });
  it('keeps a task open inside the board, never on the bare lane page', () => {
    (globalThis as { window?: unknown }).window ??= { location: { hash: '#/chat/bot?view=tasks' } };
    expect(taskPaneHash('bot', 't1')).toBe('#/chat/bot?view=tasks&task=t1');
    expect(taskPaneHash('bot', null)).toBe('#/chat/bot?view=tasks');
  });
  it('weaves the human notes into the bot transcript in time order', () => {
    const turns = [{ key: 'a', at: '2026-10-28T15:00:00.000Z' }, { key: 'b', at: '2026-10-28T15:10:00.000Z' }];
    const events: TaskEvent[] = [{ id: 'n1', kind: 'discussion', at: '2026-10-28 15:05:00', payload: { text: 'Go ahead', by: 'Nick' } }, { id: 's1', kind: 'status', at: '2026-10-28 15:06:00', payload: {} }];
    expect(interleaveDiscussion(turns, events).map((i) => i.kind === 'turn' ? i.turn.key : i.event.id)).toEqual(['a', 'n1', 'b']);
  });
  it('renders the Chat | Tasks toggle, the filter, and a pane with the composer and a plain empty state', () => {
    const html = renderToStaticMarkup(<TasksBoard conversationId="bot" onNavigate={() => {}} />);
    expect(html).toContain('aria-label="Chat or tasks"');
    expect(html).toContain('>Active<');
    expect(html).toContain('Open a task to read the bot');
    const pane = renderToStaticMarkup(<TaskPane conversationId="bot" taskId="t1" onNavigate={() => {}} onChanged={async () => {}} />);
    expect(pane).toContain('composer for The bot');
    expect(pane).toContain('Conversation with The bot on this task');
    expect(pane).not.toContain('hasn&#x27;t started'); // not until the task has loaded
  });
});
