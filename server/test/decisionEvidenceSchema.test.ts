import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BOT_TOOL_DEFINITIONS } from '../src/mcp/botTools.js';
import { evidenceSourceSchema, proposalInputSchema } from '../src/bots/service.js';
import { proposalDiagnostics } from '../src/bots/proposalDiagnostics.js';
// Use the installed JSON Schema validator, with no source/provider transport.
const Ajv = createRequire(import.meta.url)('ajv');
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const proposal = { question: 'Which item?', recommendation: 'Check item', consequence: 'None', blocked_action: 'Wait', assignee_id: 1, choices: [{id:'a',label:'Check the item',description:'Inspect evidence',action:'approve'}, {id:'b',label:'Hold the item',description:'Wait',action:'defer'}] };
const valid = [
  { system: 'chat_file', conversation_id: 'original', path: '/retained/image.png' },
  { system: 'upload', path: '/uploads/image.png' },
  { system: 'gmail', message_id: 'message', attachment_id: ' '+ 'x'.repeat(4094)+' ' },
  { system: 'orderops', ticket_id: 'TICKET', message_id: 'message' },
  { system: 'shopify', order_id: '123', order_number: '100118158', refund_ids: [] },
];
const invalid = [
  { system: 'orderops', order_number: '123', order_id: '123', conversation_id: 'chat' },
  { system: 'orderops', ticket_id: 'T', order_id: '123' },
  { system: 'chat_file', path: '/image.png' },
  { system: 'chat_file', conversation_id: 'chat', path: '/image.png', filename: 'image.png' },
  { system: 'shopify', order_number: '123' },
  { system: 'gmail', message_id: 'm', attachment_id: 'x'.repeat(4097) },
  { system: 'gmail', message_id: 'm', attachment_id: '' },
  { system: 'gmail', message_id: 'm', attachment_id: 123 },
  { system: 'shopify', order_id: '1', refund_ids: Array(21).fill('r') },
  { system: 'other', path: 'secret' },
];
describe('decision evidence callable/server parity', () => {
  for (const name of ['raise_decision', 'update_decision']) it(`${name} exposes strict provider-compatible variants`, () => {
    const tool = BOT_TOOL_DEFINITIONS.find(t => t.name === name)!;
    const schema = tool.inputSchema as any;
    const source = schema.properties.proposal.properties.evidence_items.items.properties.source;
    expect(source.anyOf).toHaveLength(5);
    const validate = ajv.compile(source);
    for (const input of valid) { expect(validate(input)).toBe(true); expect(evidenceSourceSchema.safeParse(input).success).toBe(true); }
    for (const input of invalid) { expect(validate(input)).toBe(false); expect(evidenceSourceSchema.safeParse(input).success).toBe(false); }
    const call = ajv.compile(schema);
    for (const [index, source] of valid.entries()) {
      const p = { ...proposal, evidence_items: [{ kind: index < 3 ? 'image' : 'record', label: 'Evidence', source }] };
      const args = name === 'raise_decision' ? { source_key:'s', proposal_key:'p', proposal:p } : { decision_id:'d', expected_version:1, request_key:'k', proposal:p };
      expect(call(args), JSON.stringify(call.errors)).toBe(true);
      expect(proposalInputSchema.safeParse(p).success).toBe(true);
    }
  });
  it('finds applicable generic paths hidden by the outer proposal union, without values or unknown keys', () => {
    const p = { ...proposal, evidence_items: [
      ...Array(3).fill({ kind:'image', label:'Photo', source: valid[0] }),
      { kind:'record', label:'Record', source: invalid[0] },
      { kind:'image', label:'Photo', source: invalid[2] },
      { kind:'image', label:'Photo', source: invalid[3] },
      { kind:'record', label:'Record', source: invalid[4] },
    ] };
    expect(z.object({proposal:proposalInputSchema}).safeParse({proposal:p}).success).toBe(false);
    const error = proposalDiagnostics(p);
    expect(error).toContain('proposal.evidence_items.3.source.ticket_id');
    expect(error).toContain('proposal.evidence_items.4.source.conversation_id');
    expect(error).toContain('proposal.evidence_items.5.source: Unexpected fields');
    expect(error).toContain('proposal.evidence_items.6.source.order_id');
    expect(error).not.toContain('binding_hash');
    const privateInput = { ...p, SECRET_KEY_VALUE: 'SECRET_VALUE', evidence_items:[{kind:'record',label:'r',source:{system:'SECRET_ENUM'}}] };
    expect(proposalDiagnostics(privateInput)).not.toContain('SECRET');
  });
  it('retains autoship diagnostics and bounds output', () => {
    const error = proposalDiagnostics({...proposal, kind:'autoship_package'});
    expect(error).toContain('proposal.scope');
    expect(error).not.toContain('Unexpected fields');
    const many = proposalDiagnostics({...proposal,evidence_items:Array(100).fill({source:{system:'orderops'}})});
    expect(many.length).toBeLessThan(2400); expect(many).toContain('omitted');
  });
});
