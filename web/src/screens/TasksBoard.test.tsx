import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CustomerThreadSection, groupRows, TaskAnswer, TaskPane, TasksBoard, ThreadBody } from './TasksBoard';
import { activityLine, cleanTaskTitle, taskAnswers, CUSTOMER_THREAD_KEY, customerThreadPreferred, interleaveDiscussion, rememberCustomerThread, taskPaneHash, type BoardRow, type TaskEvent } from '@/lib/tasks';

vi.mock('@/lib/tasks', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/tasks')>()), tasksApi: { board: () => new Promise(() => {}), task: () => new Promise(() => {}), mark: vi.fn(), discuss: vi.fn(), customerThread: () => new Promise(() => {}) } }));
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
  it('keeps the customer thread collapsed until the human opens it, then remembers that for the session', () => {
    const store = new Map<string, string>();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    expect(customerThreadPreferred()).toBe(false);
    const closed = renderToStaticMarkup(<CustomerThreadSection conversationId="bot" taskId="t1" caseKey="VKNA4G" bot="Tess" />);
    expect(closed).toContain('Customer thread · VKNA4G · Show');
    expect(closed).not.toContain('Reading the ticket');
    rememberCustomerThread(true);
    expect(store.get(CUSTOMER_THREAD_KEY)).toBe('open');
    const opened = renderToStaticMarkup(<CustomerThreadSection conversationId="bot" taskId="t2" caseKey={null} bot="Tess" />);
    expect(opened).toContain('Customer thread · Hide');
    expect(opened).toContain('Reading the ticket from OrderOps');
    rememberCustomerThread(false);
    expect(customerThreadPreferred()).toBe(false);
  });
  it('shows customer photos inline, PDFs as chips, and folds quoted history', () => {
    const html = renderToStaticMarkup(<ThreadBody message={{ id: 'm1', direction: 'in', channel: 'email', author: 'customer', author_label: 'Judah', body: 'raw', text: 'Here is the board.', earlier: 'On Wed wrote: > hi', attachments: [], at: '2026-10-28T15:00:00Z', files: [
      { name: 'IMG_4417.jpg', kind: 'image', url: '/api/x/files/m1/0' }, { name: 'label.pdf', kind: 'pdf', url: '/api/x/files/m1/1' }, { name: 'notes.docx', kind: 'file', url: null },
    ] }} />);
    expect(html).toContain('<img src="/api/x/files/m1/0" alt="IMG_4417.jpg"');
    expect(html).toContain('PDF · label.pdf');
    expect(html).toContain('notes.docx');
    expect(html).toContain('Here is the board.');
    expect(html).not.toContain('raw');
    expect(html).toContain('Show earlier message');
    expect(html).not.toContain('On Wed wrote');
  });
  it('shows only the bot answer for each round; the wake prompt, skill text and tool steps fold under Show steps', () => {
    const turn = { name: 'Assistant', at: '2026-10-28T18:52:00Z', key: 'l:t1', items: [
      { kind: 'user', key: 'u', text: 'Hey, can you pick this back up for me? Nicholas wrote on task…' },
      { kind: 'user', key: 's', text: 'Base directory for this skill: /Users/x/.claude/skills/ervp-cs' },
      { kind: 'tool', key: 'b', label: 'Using Bash', ok: true, running: false, inputPreview: '', resultPreview: '' },
      { kind: 'assistant', key: 'a1', markdown: 'Checking Jim’s two tickets.' },
      { kind: 'assistant', key: 'a2', markdown: 'Both things are closed in OrderOps.' },
    ] };
    const answers = taskAnswers([turn, { ...turn, key: 'l:t2', items: [turn.items[0]!] }]);
    expect(answers.map((a) => a.markdown)).toEqual(['Both things are closed in OrderOps.']);
    const html = renderToStaticMarkup(<TaskAnswer bot="Tess" answer={answers[0] as never} />);
    expect(html).toContain('Both things are closed in OrderOps.');
    expect(html).toContain('Show steps');
    expect(html).not.toContain('Base directory for this skill');
    expect(html).not.toContain('pick this back up');
    expect(html).not.toContain('Checking Jim');
  });
  it('says in one plain line what the bot is doing on the task', () => {
    expect(activityLine(undefined, 'Tess')).toBe('');
    expect(activityLine({ state: 'idle' }, 'Tess')).toBe('');
    expect(activityLine({ state: 'working' }, 'Tess')).toBe('Tess is replying…');
    expect(activityLine({ state: 'waiting' }, 'Tess')).toBe('Tess is reading your note…');
    expect(activityLine({ state: 'waiting', reason: 'tasks', others: 2 }, 'Tess')).toBe('Waiting: Tess is busy on 2 other tasks');
    expect(activityLine({ state: 'waiting', reason: 'main_chat' }, 'Tess')).toBe("Waiting: Tess's main chat is busy");
  });
});
