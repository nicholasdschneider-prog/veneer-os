import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StandingReview, StandingStatus, type StandingSetup } from './CsPhotoRequestSetup';

const setup: StandingSetup = {
  business_id: 'team', status: 'not_enrolled', review_hash: 'a'.repeat(64), expected_version: 0, default_daily_cap: 20,
  template: { key: 'product-label-photo-v1', title: 'Product-label photo request', channel: 'email', body: 'Please reply with a clear photo of the product label.' },
  limits: ['One request per ticket.', 'No refund, replacement, tracking reply, fit promise or other commitment.'],
  candidates: [{ conversation_id: 'bot', name: 'Fixture', subteam: 'Customer Service' }],
  policy: null, sent_with_receipt: 0, used_today: 0,
};
const policy = { id: 'p', version: 1, daily_cap: 20, created_at: '2026-09-29 12:00:00', executors: [{ conversation_id: 'bot', name: 'Fixture' }], revoked: null };

describe('photo request owner setup', () => {
  it('shows the exact message and every limit before authorization', () => {
    const html = renderToStaticMarkup(<StandingReview setup={setup} />);
    expect(html).toContain('Please reply with a clear photo of the product label.');
    expect(html).toContain('One request per ticket.');
    expect(html).toContain('No refund, replacement');
    expect(renderToStaticMarkup(<StandingStatus setup={setup} />)).toBe('');
  });
  it('names the bots and the daily limit once authority is on', () => {
    const html = renderToStaticMarkup(<StandingStatus setup={{ ...setup, status: 'enrolled', policy, used_today: 3, sent_with_receipt: 2 }} />);
    expect(html).toContain('Standing authority is on');
    expect(html).toContain('Fixture may send this request without asking you');
    expect(html).toContain('Daily limit 20; 3 used today; 2 sent with a receipt');
  });
  it('says plainly when authority was stopped', () => {
    const html = renderToStaticMarkup(<StandingStatus setup={{ ...setup, status: 'revoked', policy: { ...policy, revoked: { reason: 'Too many requests', created_at: '2026-09-29 13:00:00' } } }} />);
    expect(html).toContain('Standing authority is off');
    expect(html).toContain('Too many requests');
  });
});
