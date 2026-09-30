import fs from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { BotDecision } from '@/lib/bots';
import { BotProposalSummary } from './BotProposalSummary';
import { ChatDecisionCard } from './chat/ChatDecisionCard';
import { canApproveFromQueue } from '@/screens/Bots';

const manifest=JSON.parse(fs.readFileSync(new URL('../../../docs/reports/contact-verification/build487/golden.json',import.meta.url),'utf8')).targets[0].manifest;
const decision={id:'fixture',conversation_id:'fixture',version:1,state:'needs_input',bot_name:'Nora',can_answer:true,proposal:{question:'Authorize this exact verification pair?',recommendation:'Send the two templates shown.',consequence:'No financial action.',blocked_action:'Only the specified pair.',contact_verification:manifest},answer:null} as BotDecision;

it('shows both exact public templates and source-only link slots before chat approval controls',()=>{
 const html=renderToStaticMarkup(<ChatDecisionCard decision={decision}/>);
 for(const c of manifest.channels){expect(html).toContain(c.accountId);expect(html).toContain(c.from);expect(html).toContain(c.recipient);expect(html).toContain(c.segments[0].text);expect(html).toContain(`[Single-use ${c.channel} verification link]`);}
 expect(html).toContain(manifest.statement);expect(html).toContain(manifest.target.caseCustomerId);expect(html).toContain(manifest.target.orderCustomerId);
 expect(html.indexOf('Exact email and SMS to authorize')).toBeLessThan(html.indexOf('Approves this proposal'));
 expect(html).not.toContain('href="'+manifest.channels[0].slot.origin);expect(canApproveFromQueue(decision)).toBe(false);
});
it('preserves literal whitespace, escapes template text and exposes the same pair in the detailed view',()=>{
 const d=structuredClone(decision);d.proposal.contact_verification!.channels[0]!.segments[0]={kind:'literal',text:'Exact <script>literal</script>  \nNext line '};
 const html=renderToStaticMarkup(<BotProposalSummary decision={d}/>);
 expect(html).toContain('Exact &lt;script&gt;literal&lt;/script&gt;  \nNext line ');expect(html).not.toContain('<script>');expect(html).toContain('Exact sms template');expect(html).toContain('Attachments:');
});
