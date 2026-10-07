import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FocusedAutomationsList } from './FocusedWorkspace';
import { isFocusedRoute } from '../App';

vi.mock('./Bots', () => ({ Bots: () => <div /> }));
vi.mock('@/components/chat/ChatWorkspace', () => ({ ChatWorkspace: () => <div /> }));

describe('focused member routes', () => {
  const route = (hash: string) => { const [path, query = ''] = hash.split('?'); return isFocusedRoute(path!, new URLSearchParams(query)); };
  it.each(['#/bots', '#/bots?view=work', '#/bots/decision-1', '#/messages/room-1', '#/chat/clara', '#/chat/clara?from=bots&side=questions', '#/chat/clara?from=bots&browser=chat', '#/chat/clara?side=open', '#/automations', '#/settings', '#/settings/appearance'])('keeps %s', hash => {
    expect(route(hash)).toBe(true);
  });
  it.each(['#/', '#/?project=x', '#/chat/new', '#/chat/clara?files=p', '#/chat/clara?browser=p', '#/project/p', '#/todos', '#/pages', '#/apps', '#/files', '#/tools', '#/terminal', '#/bot-guide', '#/huddles', '#/voice', '#/bots/talk/clara', '#/bots?register=1'])('sends %s back to Chats', hash => {
    expect(route(hash)).toBe(false);
  });
});

describe('focused automation display', () => {
  it('shows schedules and status with a path back to the owning bot, without execution controls', () => {
    const html = renderToStaticMarkup(<FocusedAutomationsList onNavigate={vi.fn()} automations={[{ id: 'routine', name: 'Accounting inbox', botId: 'clara', botName: 'Clara', enabled: true, nextRunAt: '2026-09-25T13:00:00Z', timezone: 'America/Indiana/Indianapolis', schedule: 'Every weekday at 9:00 AM' }]} />);
    expect(html).toContain('Accounting inbox');
    expect(html).toContain('Active');
    expect(html).toContain('Open Clara');
    expect(html).not.toContain('Run now');
    expect(html).not.toContain('Delete');
  });
  it('explains the empty state', () => {
    expect(renderToStaticMarkup(<FocusedAutomationsList onNavigate={vi.fn()} automations={[]} />)).toContain('no routines yet');
  });
});
