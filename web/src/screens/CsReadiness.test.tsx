import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReadinessList, type Readiness } from './CsReadiness';

const capability = { authority: 'One human send authorization.', evidence: ['Last 30 days: 1 sent with receipt.'], tests: [] as string[] };
const readiness: Readiness = {
  business_id: 'team', as_of: '2026-09-29T12:00:00.000Z', autonomous: [], notice: 'Readiness reports recorded facts.',
  capabilities: [
    { ...capability, id: 'approved-customer-reply', title: 'Send an approved customer reply', summary: 'One approval, one send.', state: 'live', state_label: 'Live', blockers: [] },
    { ...capability, id: 'routine-product-label-photo', title: 'Request a product-label photo', summary: 'Fixed request.', state: 'blocked_on_integration', state_label: 'Blocked on integration',
      blockers: [{ owner: 'OrderOps source owner', dependency: 'Deploy the routine source adapter.' }] },
  ],
};

describe('customer service readiness', () => {
  it('says plainly when nothing runs without approval and names each blocker owner', () => {
    const html = renderToStaticMarkup(<ReadinessList readiness={readiness} />);
    expect(html).toContain('No task runs without your approval yet');
    expect(html).toContain('1 of 2 capabilities are working today');
    expect(html).toContain('OrderOps source owner:');
    expect(html).toContain('Blocked on integration');
    expect(html).toContain('None yet.');
  });
  it('counts tasks that run under standing authority', () => {
    const html = renderToStaticMarkup(<ReadinessList readiness={{ ...readiness, autonomous: ['routine-product-label-photo'] }} />);
    expect(html).toContain('1 task can run without per-message approval');
  });
});
