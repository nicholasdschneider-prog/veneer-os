import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HuddleMessageRow } from './Huddles';
import { huddleStatusLabel, mentionTargets, type HuddleMessage } from '@/lib/huddles';

const names = new Map([
  ['bot-lead', 'Lead'],
  ['bot-robin', 'Robin'],
]);
const base: HuddleMessage = {
  id: 'm1',
  seq: 4,
  kind: 'message',
  author: { conversation_id: 'bot-robin', user_id: null, name: 'Robin' },
  body: 'Replacement shipped.',
  targets: [],
  recipients: ['bot-lead'],
  action_id: null,
  created_at: '2026-09-21T12:00:00.000Z',
};

describe('huddle messages', () => {
  it('shows who wrote each message and who a handoff goes to', () => {
    const html = renderToStaticMarkup(
      <ul>
        <HuddleMessageRow message={base} names={names} />
        <HuddleMessageRow message={{ ...base, id: 'm2', seq: 5, kind: 'handoff', targets: ['bot-lead'], author: { conversation_id: 'bot-lead', user_id: null, name: 'Lead' } }} names={names} />
        <HuddleMessageRow message={{ ...base, id: 'm3', seq: 6, kind: 'system', author: { conversation_id: null, user_id: null, name: 'Veneer' }, body: 'Lead opened this huddle.' }} names={names} />
        <HuddleMessageRow message={{ ...base, id: 'm4', seq: 7, author: { conversation_id: null, user_id: 1, name: 'Nick' }, targets: ['bot-robin'] }} names={names} />
      </ul>,
    );
    expect(html).toContain('Robin');
    expect(html).toContain('aria-label="Robin avatar"');
    expect(html).toContain('handoff to Lead');
    expect(html).toContain('data-kind="system"');
    expect(html).toContain('Lead opened this huddle.');
    expect(html).toContain('person');
    expect(html).toContain('to Robin');
    expect(html).toContain('#4');
  });

  it('derives a status line from owner and open actions', () => {
    expect(huddleStatusLabel({ status: 'open', owner: { conversation_id: 'x', name: 'Sage', title: null, archived: false }, open_action_count: 2 })).toBe('Sage has the ball · 2 open actions');
    expect(huddleStatusLabel({ status: 'open', owner: null, open_action_count: 0 })).toBe('No owner yet');
    expect(huddleStatusLabel({ status: 'closed', owner: null, open_action_count: 0 })).toBe('Closed · verified complete');
  });

  it('turns typed @mentions into member targets and ignores members who left', () => {
    const members = [
      { conversation_id: 'bot-lead', name: 'Lead', left_at: null },
      { conversation_id: 'bot-robin', name: 'Robin', left_at: null },
      { conversation_id: 'bot-sage', name: 'Sage', left_at: '2026-09-21T00:00:00Z' },
    ];
    expect(mentionTargets('@Robin please confirm, @sage too', members)).toEqual(['bot-robin']);
    expect(mentionTargets('no mentions here', members)).toEqual([]);
  });
});
