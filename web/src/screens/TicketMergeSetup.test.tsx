import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TicketMergeStatus, type MergeSetupStatus } from './TicketMergeSetup';

const reg = { id: 'r1', enrolled: false, enrolledAt: null, expiresAt: '2027-09-30T00:00:00Z', reviewerName: 'Henry', executorName: 'Avery' };
const render = (status: MergeSetupStatus | null, extra: { busy?: boolean; error?: string; justTurnedOn?: boolean } = {}) =>
  renderToStaticMarkup(<TicketMergeStatus status={status} busy={extra.busy ?? false} error={extra.error ?? ''} justTurnedOn={extra.justTurnedOn ?? false} onTurnOn={() => {}} />);

describe('ticket merging owner setup', () => {
  it('offers one plain button while it is off', () => {
    const html = render({ configured: true, registrations: [reg] });
    expect(html).toContain('Off');
    expect(html).toContain('Turn on ticket merging');
    expect(html).toContain('Avery can combine duplicate tickets');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(render({ configured: true, registrations: [reg] }, { busy: true })).toContain('disabled');
  });
  it('says it is on and offers the one button that lets bots merge clear duplicates', () => {
    const on = { ...reg, enrolled: true, enrolledAt: '2026-10-01 12:00:00', standing: { enabled: false, since: null }, automaticMerges: 0 };
    const html = renderToStaticMarkup(<TicketMergeStatus status={{ configured: true, registrations: [on] }} busy={false} error="" justTurnedOn onTurnOn={() => {}} onStanding={() => {}} />);
    expect(html).toContain('On since');
    expect(html).toContain('Repeat messages now join the customer’s existing ticket.');
    expect(html).toContain('Let bots merge clear duplicates on their own');
    expect(html).toContain('You are not asked');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain('approves each merge');
  });
  it('shows the standing rule as on with a count and a quiet turn-off link', () => {
    const on = { ...reg, enrolled: true, enrolledAt: '2026-10-01 12:00:00', standing: { enabled: true, since: '2026-10-01 13:00:00' }, automaticMerges: 7 };
    const html = renderToStaticMarkup(<TicketMergeStatus status={{ configured: true, registrations: [on] }} busy={false} error="" justTurnedOn={false} onTurnOn={() => {}} onStanding={() => {}} />);
    expect(html).toContain('Bots merge clear duplicates on their own');
    expect(html).toContain('7 merged this way so far.');
    expect(html).toContain('Unclear matches still come to a person.');
    expect(html).toContain('Turn off');
    expect(html).not.toContain('Let bots merge clear duplicates on their own</button>');
  });
  it('says not set up yet with no button, and shows a server error plainly', () => {
    const html = render({ configured: false, registrations: [] });
    expect(html).toContain('Not set up yet');
    expect(html).not.toContain('<button');
    expect(render(null, { error: 'Only the business owner can view ticket merging setup' })).toContain('Only the business owner');
    expect(render({ configured: true, registrations: [reg] }, { error: 'Something failed' })).toContain('role="alert"');
  });
});
