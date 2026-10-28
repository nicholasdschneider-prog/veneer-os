import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { groupRows, TasksBoard } from './TasksBoard';
import type { BoardRow } from '@/lib/tasks';

vi.mock('@/lib/tasks', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/tasks')>()), tasksApi: { board: () => new Promise(() => {}), task: () => new Promise(() => {}), mark: vi.fn(), discuss: vi.fn() } }));

const row = (over: Partial<BoardRow>): BoardRow => ({ kind: 'task', id: 'a', group: 'working', title: 'T', status_line: 'Working', tag: 'case 1', href: '#/chat/x', updated_at: '2026-10-28T13:00:00Z', can_mark: true, ...over });

describe('tasks board', () => {
  it('groups active rows in board order and keeps Completed as its own filter', () => {
    const rows = [row({ id: '1', group: 'working' }), row({ id: '2', group: 'needs_input' }), row({ id: '3', group: 'completed' }), row({ id: '4', group: 'ready_for_review' })];
    expect(groupRows(rows, false).map((g) => [g.id, g.rows.map((r) => r.id)])).toEqual([['ready_for_review', ['4']], ['needs_input', ['2']], ['working', ['1']]]);
    expect(groupRows(rows, true).map((g) => [g.id, g.rows.map((r) => r.id)])).toEqual([['completed', ['3']]]);
  });
  it('renders the Chat | Tasks toggle and the Active / Completed filter', () => {
    const html = renderToStaticMarkup(<TasksBoard conversationId="bot" onNavigate={() => {}} />);
    expect(html).toContain('aria-label="Chat or tasks"');
    expect(html).toContain('>Active<');
    expect(html).toContain('Completed');
    expect(html).toContain('Loading…');
  });
});
