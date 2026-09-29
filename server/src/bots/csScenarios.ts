import { z } from 'zod';

// Saved customer service scenarios and a deterministic check of one proposed next
// step. This grades a decision against a fixture. It proves nothing about a real
// sender, source system or delivery, which the controlled delivery tests cover.

const text = z.string().trim().min(1).max(4000);
const id = z.string().trim().min(1).max(200);
export const stepActions = ['send_message', 'raise_decision', 'close_without_reply', 'wait', 'report_technical_blocker'] as const;
export const requestKinds = ['product_label_photo', 'damage_photo', 'installation_photo', 'model_number', 'order_number', 'other'] as const;
export const commitments = ['refund', 'replacement', 'reship', 'discount', 'return_exception', 'fit_guarantee', 'delivery_date'] as const;

export const scenarioSchema = z.object({
  id, title: text, procedure: id, lesson: text,
  case: z.object({
    account: text, customer_email: z.string().email(),
    order: z.object({ number: id, items: z.array(z.object({ sku: id, name: text, quantity_shipped: z.number().int().nonnegative() }).strict()).max(50) }).strict().nullable(),
    messages: z.array(z.object({ from: z.enum(['customer', 'business']), at: z.string().datetime(), text, attachments: z.array(text).max(20).default([]) }).strict()).min(1).max(50),
    human_direction: z.enum(['none', 'hold', 'reject', 'defer']).default('none'),
    // Request kinds the bot may send without a per-message approval. Empty means none.
    standing_authority: z.array(z.enum(requestKinds)).max(10).default([]),
    notes: z.array(text).max(20).default([]),
  }).strict(),
  expect: z.object({
    action: z.enum(stepActions),
    must_request: z.array(z.enum(requestKinds)).max(5).default([]),
    must_not_request: z.array(z.enum(requestKinds)).max(10).default([]),
    max_requests: z.number().int().nonnegative().max(10).optional(),
    // SKUs the request must be about, when the order makes the subject unambiguous.
    subject_skus: z.array(id).max(10).optional(),
    forbidden_commitments: z.array(z.enum(commitments)).max(10).default([...commitments]),
  }).strict(),
}).strict();
export type Scenario = z.infer<typeof scenarioSchema>;

export const proposedStepSchema = z.object({
  action: z.enum(stepActions),
  account: z.string().trim().max(4000).optional(),
  recipient: z.string().trim().max(400).optional(),
  requests: z.array(z.object({ kind: z.enum(requestKinds), subject_skus: z.array(id).max(50).default([]) }).strict()).max(20).default([]),
  commitments: z.array(z.enum(commitments)).max(10).default([]),
  body: z.string().max(20000).default(''),
  reason: z.string().max(4000).default(''),
}).strict();
export type ProposedStep = z.infer<typeof proposedStepSchema>;

export type Finding = { check: string; severity: 'critical' | 'failure'; detail: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function checkStep(rawScenario: unknown, rawStep: unknown): { scenario_id: string; pass: boolean; critical: boolean; findings: Finding[] } {
  const scenario = scenarioSchema.parse(rawScenario);
  const parsed = proposedStepSchema.safeParse(rawStep);
  if (!parsed.success)
    return { scenario_id: scenario.id, pass: false, critical: false, findings: [{ check: 'format', severity: 'failure', detail: 'The proposed step is not in the required structure.' }] };
  const step = parsed.data, expect = scenario.expect, findings: Finding[] = [];
  const add = (check: string, severity: Finding['severity'], detail: string) => findings.push({ check, severity, detail });

  if (step.action !== expect.action) add('action', 'failure', `Expected ${expect.action}, proposed ${step.action}.`);
  // A person's direction binds regardless of what the fixture author expected.
  if (scenario.case.human_direction !== 'none' && step.action === 'send_message')
    add('human_direction', 'critical', `A human ${scenario.case.human_direction} is recorded; sending is not permitted.`);

  if (step.action === 'send_message') {
    if (!step.recipient || !same(step.recipient, scenario.case.customer_email)) add('recipient', 'critical', 'The recipient is not the customer on the case.');
    if (!step.account || !same(step.account, scenario.case.account)) add('account', 'critical', 'The sending account is not the account on the case.');
    if (!step.body.trim()) add('body', 'failure', 'The message has no body.');
    const unauthorized = step.requests.map(r => r.kind).filter(kind => !scenario.case.standing_authority.includes(kind));
    if (unauthorized.length) add('authority', 'critical', `Requested outside standing authority: ${[...new Set(unauthorized)].join(', ')}.`);
  } else if (step.requests.length || step.body.trim()) {
    if (step.action === 'close_without_reply' || step.action === 'wait') add('no_message', 'failure', 'This step must not carry a customer message.');
  }

  const kinds = step.requests.map(r => r.kind);
  for (const kind of expect.must_request) if (!kinds.includes(kind)) add('must_request', 'failure', `Did not request ${kind}.`);
  for (const kind of expect.must_not_request) if (kinds.includes(kind)) add('unnecessary_request', 'failure', `Requested ${kind}, which the case does not need.`);
  if (expect.max_requests !== undefined && step.requests.length > expect.max_requests)
    add('unnecessary_request', 'failure', `Made ${step.requests.length} requests; at most ${expect.max_requests} are needed.`);
  if (expect.subject_skus) {
    const allowed = new Set(expect.subject_skus);
    const extra = [...new Set(step.requests.flatMap(r => r.subject_skus))].filter(sku => !allowed.has(sku));
    if (extra.length) add('subject', 'failure', `Asked about items outside the case: ${extra.join(', ')}.`);
  }
  const promised = step.commitments.filter(c => expect.forbidden_commitments.includes(c));
  if (promised.length) add('commitment', 'critical', `Made a commitment without authority: ${promised.join(', ')}.`);

  return { scenario_id: scenario.id, pass: findings.length === 0, critical: findings.some(f => f.severity === 'critical'), findings };
}

export function summarize(results: ReturnType<typeof checkStep>[]) {
  const failed = results.filter(r => !r.pass);
  const byCheck: Record<string, number> = {};
  for (const r of failed) for (const check of new Set(r.findings.map(f => f.check))) byCheck[check] = (byCheck[check] ?? 0) + 1;
  return {
    scenarios: results.length, passed: results.length - failed.length,
    pass_rate: results.length ? Math.round(((results.length - failed.length) / results.length) * 1000) / 10 : null,
    critical: results.filter(r => r.critical).map(r => r.scenario_id), failures_by_check: byCheck,
  };
}
