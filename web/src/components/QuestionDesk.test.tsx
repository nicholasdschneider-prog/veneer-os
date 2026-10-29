import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { deskRoute } from './QuestionDesk';
import { TasksBoard } from '@/screens/TasksBoard';

vi.mock('@/lib/tasks', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/tasks')>()), tasksApi: { board: () => new Promise(() => {}), task: () => new Promise(() => {}), mark: vi.fn(), discuss: vi.fn(), customerThread: () => new Promise(() => {}) } }));
vi.mock('@/components/BotComposer', () => ({ BotComposer: () => <div>composer</div> }));

describe('question desk Chat | Tasks', () => {
  it('keeps the chief chat’s switch, task panes and cards inside the desk; other links leave it', () => {
    expect(deskRoute('archer', '#/chat/archer?view=tasks')).toEqual({ view: 'tasks', taskId: null });
    expect(deskRoute('archer', '#/chat/archer?project=p&view=tasks&task=t1')).toEqual({ view: 'tasks', taskId: 't1' });
    expect(deskRoute('archer', '#/chat/archer')).toEqual({ view: 'chat' });
    expect(deskRoute('archer', '#/chat/archer?project=p')).toEqual({ view: 'chat' });
    expect(deskRoute('archer', '#/chat/archer?side=decision:d1')).toEqual({ decision: 'd1' });
    expect(deskRoute('archer', '#/chat/archer?side=coordination:th1')).toBeNull();
    expect(deskRoute('archer', '#/chat/tess?view=tasks')).toBeNull();
    expect(deskRoute('archer', '#/bots')).toBeNull();
  });
  it('shows the board in one column in the desk, with the switch, and the task alone once opened', () => {
    (globalThis as { window?: unknown }).window ??= { location: { hash: '#/' } };
    const board = renderToStaticMarkup(<TasksBoard compact conversationId="archer" onNavigate={() => {}} />);
    expect(board).toContain('aria-label="Chat or tasks"');
    expect(board).not.toContain('Open a task to read the bot');
    expect(board).not.toContain('md:max-w-sm');
    const open = renderToStaticMarkup(<TasksBoard compact conversationId="archer" taskId="t1" onNavigate={() => {}} />);
    expect(open).toContain('aria-label="Task"');
    expect(open).toMatch(/class="[^"]*hidden[^"]*"[^>]*>.*aria-label="Chat or tasks"/s);
  });
});
