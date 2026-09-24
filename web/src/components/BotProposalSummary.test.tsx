import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotProposalSummary, BotProposalDetails } from './BotProposalSummary';
import type { BotDecision } from '@/lib/bots';

describe('human decision review', () => {
  it('separates technical details without losing a long action-only recommendation',()=>{
    const recommendation='A long material recommendation. '.repeat(20);
    const decision={proposal:{question:'Review',recommendation,consequence:'Material limit',blocked_action:'Verify first'}} as BotDecision;
    const main=renderToStaticMarkup(<BotProposalSummary decision={decision} hideDetails />);
    const details=renderToStaticMarkup(<BotProposalDetails decision={decision} />);
    expect(main).not.toContain('<details');expect(main).toContain('Material limit');
    expect(details).toContain(recommendation);expect(details).toContain('Verify first');
  });

  it('puts the unmodified draft first and preserves limits and original protocol', () => {
    const decision = { id: 'reference-1', version: 2, proposal: {
      recommendation: 'Send a tracking update.', consequence: 'No refund approved. The date is an estimate.',
      blocked_action: 'Recheck material evidence. EXACT DRAFT: Hello, we cannot confirm delivery yet.',
    } } as BotDecision;
    const html = renderToStaticMarkup(<BotProposalSummary decision={decision} showIdentifiers />);
    const firstDisclosure = html.indexOf('<details');
    expect(html.indexOf('No refund approved. The date is an estimate.')).toBeLessThan(firstDisclosure);
    expect(html).toContain('Proposed customer reply');
    expect(html).toContain('Hello, we cannot confirm delivery yet.');
    expect(html.indexOf('Hello, we cannot confirm delivery yet.')).toBeLessThan(html.indexOf('Impact &amp; limits'));
    expect(html.indexOf('Hello, we cannot confirm delivery yet.')).toBeLessThan(firstDisclosure);
    expect(html.indexOf('Recheck material evidence.')).toBeGreaterThan(html.indexOf('Original details &amp; conditions'));
    expect(html).toContain('reference-1');
    expect(html).not.toContain('line-clamp');
  });
  it('keeps card limits visible while preserving the complete background behind an explicit disclosure', () => {
    const decision = { proposal: {
      recommendation: 'Check parcel 1 and parcel 2. Only one has carrier acceptance.',
      consequence: '$0 update only; no refund or replacement. Delivery is not guaranteed.',
      blocked_action: 'Refresh tracking before sending.',
    } } as BotDecision;
    const html = renderToStaticMarkup(<BotProposalSummary decision={decision} compact />);
    expect(html.indexOf(decision.proposal.consequence)).toBeLessThan(html.indexOf('<details'));
    expect(html).toContain(decision.proposal.recommendation);
    expect(html).toContain(decision.proposal.blocked_action);
    expect(html).not.toContain('Proposed customer reply');
    expect(html).toContain('Not verified');
    expect(html).not.toContain('line-clamp');
  });

  it.each(['none', 'partial', 'full', 'not_verified'] as const)('shows only supplied %s refund evidence and hides short background initially', (status) => {
    const refund = status === 'not_verified' ? {status} : { status, source: 'Synthetic ledger receipt', as_of:'2026-09-23T12:00:00Z', scope:'This order', evidence_kind: status === 'none' ? 'complete_refund_history' : 'completed_refund', receipt:'receipt-1', amount:12.50,currency:'USD' };
    const decision={proposal:{question:'$0 new action',recommendation:'Long background',consequence:'No new refund authority',blocked_action:'EXACT DRAFT: Exact reply',review_summary:{action_title:'Send a factual update',customer_request:'Customer wants a delivery update',background:['Shipment not confirmed'],refund}}} as BotDecision;
    const html=renderToStaticMarkup(<BotProposalSummary decision={decision} />);
    expect(html).toContain('What does the customer want?');
    expect(html).toContain('Already refunded?');
    expect(html).toContain({none:'NO',partial:'PARTIAL',full:'YES',not_verified:'Not verified'}[status]);
    expect(html).not.toContain('Shipment not confirmed');
    if(status!=='not_verified') expect(html).toContain('Synthetic ledger receipt');
    expect(html.match(/Exact reply/g)).toHaveLength(1);
  });

  it('shows every structured message authorization field and keeps exact body whitespace', () => {
    const decision = { proposal: { recommendation:'Send the approved note.',consequence:'No financial actions.',blocked_action:'Verify source first.',message_delivery:{canonical_case:'fixture-case',executor_conversation_id:'fixture-nora',payload:{channel:'email',account:'Fixture support',recipients:['fixture@example.test'],subject:'Fixture subject',body:'Exact body.\nSecond line. ',customer:'Fixture customer',ticket:'fixture-case',context:'Fixture context',attachments:[{name:'evidence.pdf',reference:'retained-evidence',sha256:'a'.repeat(64)}]}}} } as BotDecision;
    const html=renderToStaticMarkup(<BotProposalSummary decision={decision} />);
    for(const text of ['Exact customer message to authorize','Fixture support','fixture@example.test','fixture-case','fixture-nora','Fixture subject','Exact body.\nSecond line. ','evidence.pdf','retained-evidence','a'.repeat(64)])expect(html).toContain(text);
  });
});
