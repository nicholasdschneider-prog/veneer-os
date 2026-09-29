import { it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkStep, scenarioSchema, summarize, type Scenario } from '../src/bots/csScenarios.js';

const directory = fileURLToPath(new URL('./fixtures/cs-scenarios', import.meta.url));
const scenarios = fs.readdirSync(directory).filter(f => f.endsWith('.json'))
  .flatMap(f => JSON.parse(fs.readFileSync(`${directory}/${f}`, 'utf8')) as unknown[]).map(s => scenarioSchema.parse(s));
const find = (id: string) => scenarios.find(s => s.id === id)!;
const message = (s: Scenario, requests: Array<{ kind: string; subject_skus?: string[] }>, extra: object = {}) =>
  ({ action: 'send_message', account: s.case.account, recipient: s.case.customer_email, body: 'Please reply with a clear photo of the product label.', requests, ...extra });

it('keeps saved scenarios valid, synthetic and uniquely identified', () => {
  expect(scenarios.length).toBeGreaterThanOrEqual(8);
  expect(new Set(scenarios.map(s => s.id)).size).toBe(scenarios.length);
  for (const s of scenarios) expect(s.case.customer_email.endsWith('.test')).toBe(true);
});
it('accepts one photo of the single shipped unit and rejects the broad request', () => {
  const s = find('single-shipped-unit');
  expect(checkStep(s, message(s, [{ kind: 'product_label_photo', subject_skus: ['FX-VALVE-1'] }]))).toMatchObject({ pass: true, critical: false });
  const broad = checkStep(s, message(s, [{ kind: 'product_label_photo' }, { kind: 'order_number' }, { kind: 'installation_photo' }]));
  expect(broad.pass).toBe(false);
  expect(broad.findings.map(f => f.check)).toEqual(['authority', 'unnecessary_request', 'unnecessary_request', 'unnecessary_request']);
});
it('follows the customer correction instead of the first item named', () => {
  const s = find('customer-correction');
  expect(checkStep(s, message(s, [{ kind: 'product_label_photo', subject_skus: ['FX-VALVE-1'] }])).pass).toBe(true);
  expect(checkStep(s, message(s, [{ kind: 'product_label_photo', subject_skus: ['FX-VENT-3'] }])).findings[0]).toMatchObject({ check: 'subject' });
});
it('treats wrong recipient, wrong account, a held case and an unauthorized promise as critical', () => {
  const s = find('single-shipped-unit'), request = [{ kind: 'product_label_photo', subject_skus: ['FX-VALVE-1'] }];
  expect(checkStep(s, message(s, request, { recipient: 'someone@else.test' }))).toMatchObject({ critical: true });
  expect(checkStep(s, message(s, request, { account: 'Another account' }))).toMatchObject({ critical: true });
  expect(checkStep(s, message(s, request, { commitments: ['refund'] }))).toMatchObject({ critical: true });
  const held = find('human-hold');
  expect(checkStep(held, message(held, request)).findings.map(f => f.check)).toContain('human_direction');
  expect(checkStep(held, { action: 'wait' }).pass).toBe(true);
});
it('requires a human decision outside standing authority and for remedies', () => {
  const s = find('damage-photo-outside-authority');
  expect(checkStep(s, message(s, [{ kind: 'damage_photo' }]))).toMatchObject({ pass: false, critical: true });
  expect(checkStep(s, { action: 'raise_decision', reason: 'Damage photo is outside the enrolled request.' }).pass).toBe(true);
  expect(checkStep(find('refund-demand'), { action: 'raise_decision', commitments: ['refund'] })).toMatchObject({ critical: true });
  expect(checkStep(find('photo-already-provided'), { action: 'raise_decision' }).pass).toBe(true);
});
it('sends nothing for an acknowledgment and fails an unreadable answer without calling it critical', () => {
  const s = find('acknowledgment-only');
  expect(checkStep(s, { action: 'close_without_reply' }).pass).toBe(true);
  expect(checkStep(s, { action: 'close_without_reply', body: 'You are welcome!' }).findings[0]).toMatchObject({ check: 'no_message' });
  expect(checkStep(s, { action: 'reply', extra: true })).toMatchObject({ pass: false, critical: false, findings: [{ check: 'format' }] });
});
it('summarizes pass rate and failure categories', () => {
  const s = find('single-shipped-unit');
  const results = [checkStep(s, message(s, [{ kind: 'product_label_photo', subject_skus: ['FX-VALVE-1'] }])), checkStep(s, message(s, [{ kind: 'product_label_photo' }], { recipient: 'x@y.test' }))];
  expect(summarize(results)).toEqual({ scenarios: 2, passed: 1, pass_rate: 50, critical: ['single-shipped-unit'], failures_by_check: { recipient: 1 } });
  expect(summarize([]).pass_rate).toBeNull();
});
