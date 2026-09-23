import React from 'react';
import { createRoot } from 'react-dom/client';
import { BotProposalSummary } from '../../web/src/components/BotProposalSummary';
import { decisionTitle } from '../../web/src/lib/decisionPresentation';
import type { BotDecision } from '../../web/src/lib/bots';
import '../../web/src/styles.css';
const base={id:'fixture',version:1,proposal:{question:'Scott custom shades — $0 new action',recommendation:'Original long background. '.repeat(30),consequence:'Factual update only. No production, purchase, refund, or delivery promise is authorized.',blocked_action:'Verify unchanged facts. EXACT DRAFT: Hi Scott,\n\nWe have asked the vendor to confirm the corrected specifications. We do not yet have a confirmed production or ship date.\n\nThanks,\nFixture support',review_summary:{action_title:'Send Scott an update about his custom shades',customer_request:'Scott wants the three custom shades he already paid for.',background:['The corrected specifications were sent to the vendor.','Written acceptance and a ship date remain unconfirmed.'],refund:{status:'not_verified'}}}} as BotDecision;
createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-3xl space-y-5 bg-background p-4 text-foreground">{['not_verified','none','partial','full','legacy','action'].map((status,i)=>{
 const d=structuredClone(base);
 if(status==='legacy')delete d.proposal.review_summary;
 else if(status!=='action')d.proposal.review_summary!.refund=(status==='not_verified'?{status}:{status,source:'Synthetic ledger export',as_of:'2026-09-23T12:00:00Z',scope:'Fixture order only',evidence_kind:status==='none'?'complete_refund_history':'completed_refund',receipt:'fixture-receipt',amount:12.50,currency:'USD'}) as NonNullable<typeof d.proposal.review_summary>['refund'];
 if(status==='action'){d.proposal.blocked_action='Verify the exact scope.';d.proposal.review_summary!.action_title='Ask the vendor to confirm specifications';}
 return <article key={status} data-case={status} className="rounded-2xl border bg-card p-4"><h2 className="mb-4 text-xl font-semibold">{decisionTitle(d.proposal)}</h2><BotProposalSummary decision={d} compact={i%2===1} showIdentifiers /></article>;
})}</main>);
