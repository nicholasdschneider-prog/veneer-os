import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FocusedAutomations, FocusedWorkspace } from './FocusedWorkspace';

vi.mock('./Bots', () => ({ Bots: () => <div /> }));
vi.mock('@/components/chat/ChatWorkspace', () => ({ ChatWorkspace: () => <div /> }));

it.each(['#/', '#/bots', '#/settings', '#/pages', '#/automations'])('offers only the two focused navigation choices at %s', hash => {
  const html = renderToStaticMarkup(<FocusedWorkspace hash={hash} email="accounting@example.test" onNavigate={vi.fn()} onToast={vi.fn()} />);
  expect(html.match(/<button/g)).toHaveLength(2);
  expect(html).toContain('VeneerBots');
  expect(html).toContain('Automations');
  expect(html).not.toContain('Settings');
  expect(html).not.toContain('Workspace');
});

describe('focused automation display', () => {
  it('shows schedules and status with a path back to the owning bot, without execution controls', () => {
    const html = renderToStaticMarkup(<FocusedAutomations onNavigate={vi.fn()} automations={[{ id: 'routine', name: 'Accounting inbox', botId: 'clara', botName: 'Clara', enabled: true, nextRunAt: '2026-09-25T13:00:00Z', timezone: 'America/Indiana/Indianapolis', schedule: 'Every weekday at 9:00 AM' }]} />);
    expect(html).toContain('Accounting inbox');
    expect(html).toContain('Active');
    expect(html).toContain('Open Clara');
    expect(html).not.toContain('Run now');
    expect(html).not.toContain('Delete');
  });
  it('explains the empty state', () => {
    expect(renderToStaticMarkup(<FocusedAutomations onNavigate={vi.fn()} automations={[]} />)).toContain('no routines yet');
  });
});
