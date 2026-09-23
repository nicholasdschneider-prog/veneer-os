import { z } from 'zod';
const line = z.string().trim().min(1).max(500);
export const draftPayload = z
  .object({
    channel: z.enum(['email', 'sms', 'slack', 'customer_portal']),
    account: line,
    recipients: z.array(line).min(1).max(20),
    subject: z.string().max(998).default(''),
    body: z.string().trim().min(1).max(12000),
    attachments: z
      .array(z.object({ name: line, reference: line }).strict())
      .max(10)
      .default([]),
    customer: line,
    ticket: line,
    context: z.string().max(2000).default(''),
  })
  .strict();
export type DraftPayload = z.infer<typeof draftPayload>;

const exactLine = z.string().min(1).max(500).refine(value => value.trim().length > 0);
export const exactDraftPayload = draftPayload.extend({
  account: exactLine, recipients: z.array(exactLine).min(1).max(20),
  body: z.string().min(1).max(12000), customer: exactLine, ticket: exactLine,
  attachments: z.array(z.object({name:exactLine,reference:exactLine,sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(10).default([]),
});
export const approvedMessageSchema = z.object({
  canonical_case: z.string().min(1).max(500),
  executor_conversation_id: z.string().min(1).max(200),
  payload: exactDraftPayload,
}).strict();
