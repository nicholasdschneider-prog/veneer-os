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
    expect(html).toContain('Avery can ask you to approve merging two tickets');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(render({ configured: true, registrations: [reg] }, { busy: true })).toContain('disabled');
  });
  it('says it is on, since when, with no button', () => {
    const html = render({ configured: true, registrations: [{ ...reg, enrolled: true, enrolledAt: '2026-10-01 12:00:00' }] }, { justTurnedOn: true });
    expect(html).toContain('On since');
    expect(html).toContain('On. OrderOps can now ask for merge approvals.');
    expect(html).not.toContain('<button');
  });
  it('says not set up yet with no button, and shows a server error plainly', () => {
    const html = render({ configured: false, registrations: [] });
    expect(html).toContain('Not set up yet');
    expect(html).not.toContain('<button');
    expect(render(null, { error: 'Only the business owner can view ticket merging setup' })).toContain('Only the business owner');
    expect(render({ configured: true, registrations: [reg] }, { error: 'Something failed' })).toContain('role="alert"');
  });
});
