import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Server } from 'node:http';
import { migrate } from '../src/db/migrate.js';
import { createBotService, proposalSchema, validateDecisionEvidence, type Actor } from '../src/bots/service.js';
import { bindDecisionEvidence, bindHumanEvidence, readDecisionEvidence, ORDEROPS_ATTACHMENT_UNAVAILABLE } from '../src/bots/decisionEvidence.js';
import { employeeRouteAllowed } from '../src/bots/employeeAccess.js';
import { createBotsRouter } from '../src/bots/routes.js';
import { acceptEvent } from '../src/botWorkflows/routines.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZEAAAAAASUVORK5CYII=', 'base64');
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const choices = [{ id: 'a', label: 'Refund the AC line after return', description: 'Refund $1,393.21 once the unit is back', action: 'approve', recommended: true }, { id: 'b', label: 'Replace the unit instead', description: 'Ship a replacement, no refund', action: 'approve' }];
const refundRecord = { kind: 'record', label: 'Shopify refunds for #100120886', source: { system: 'shopify', order_id: '5551', order_number: '100120886', refund_ids: [] }, text: 'No refunds recorded as of Sep 30. Order total $1,690.67, paid.' };
const refund = { status: 'none', source: 'Shopify order 5551 refunds tab', as_of: '2026-09-30T14:00:00Z', scope: 'Order #100120886', evidence_kind: 'complete_refund_history' };

describe('decision evidence and staleness', () => {
  let db: Database.Database, dir: string, file: string, dataDir: string, ctx: AppContext, bot: Actor, human: Actor;
  let s: ReturnType<typeof createBotService>;
  const servers: Server[] = [];
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys=ON');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@test.invalid','Owner','owner')").run();
    db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Team',1)").run();
    for (const id of ['bot', 'source']) db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,?,'claude',?,'team','team')").run(id, id, id);
    db.prepare("INSERT INTO bot_event_sources(id,team_id,created_by,name) VALUES('orderops','team',1,'OrderOps')").run();
    human = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow }; bot = { ...human, conversationId: 'bot' };
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('bot','Avery',1)").run();
    db.prepare("INSERT INTO business_bot_members(conversation_id,team_id,role) VALUES('bot','team','bot')").run();
    s = createBotService(db);
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'decision-evidence-'))); file = join(dir, 'box.png'); writeFileSync(file, png);
    dataDir = join(dir, 'data'); mkdirSync(join(dataDir, 'uploads', 'abc'), { recursive: true });
    ctx = { db, config: { dataDir, staleQuestionWithdrawMs: 1000 }, manager: { listSessionFiles: vi.fn(async (id: string) => id === 'source' ? [{ path: file, source: 'write' }] : []), statusOf: async () => 'idle' } } as unknown as AppContext;
  });
  afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const proposal = (extra: Record<string, unknown> = {}) => proposalSchema.parse({ question: 'Refund the rooftop AC line for #100120886?', recommendation: 'Refund after return.', consequence: 'Covers one line only.', blocked_action: 'Refund only after the unit is received.', assignee_id: 1, choices, review_summary: { action_title: 'Refund the AC line', background: [], refund }, evidence_items: [refundRecord], ...extra });

  it('refuses a question that mentions photos without attaching them or a money question with unverified refund facts', () => {
    expect(() => validateDecisionEvidence(proposalSchema.parse({ question: 'Approve the refund? 24 photos show box damage.', recommendation: 'Refund', consequence: 'x', blocked_action: 'x', assignee_id: 1, choices, review_summary: { action_title: 'Refund', background: [], refund }, evidence_items: [refundRecord] }))).toThrow('attaches none');
    expect(() => validateDecisionEvidence(proposalSchema.parse({ question: 'Refund the order?', recommendation: 'Refund', consequence: 'x', blocked_action: 'x', assignee_id: 1, choices }))).toThrow('not verified');
    expect(() => validateDecisionEvidence(proposalSchema.parse({ question: 'Refund the order?', recommendation: 'Refund', consequence: 'x', blocked_action: 'x', assignee_id: 1, choices, review_summary: { action_title: 'Refund', background: [], refund: { status: 'not_verified' } } }))).toThrow('not verified');
    expect(() => validateDecisionEvidence(proposalSchema.parse({ question: 'Refund the order?', recommendation: 'Refund', consequence: 'x', blocked_action: 'x', assignee_id: 1, choices, review_summary: { action_title: 'Refund', background: [], refund } }))).toThrow('record evidence item');
    validateDecisionEvidence(proposal());
    // No photos, no money: nothing required.
    validateDecisionEvidence(proposalSchema.parse({ question: 'Which pack for 10 brackets?', recommendation: '27 oz', consequence: 'Teaches the pack only.', blocked_action: 'Record', assignee_id: 1, choices }));
  });

  it('retains cited files by hash, keeps excerpts, fills as_of, and serves bytes only for the current version', async () => {
    const items = [
      { kind: 'image', label: 'Box damage', source: { system: 'chat_file', conversation_id: 'source', path: file } },
      { kind: 'document', label: 'Carrier claim', source: { system: 'orderops', ticket_id: 'T1', attachment_id: 'att-9' } },
      { kind: 'message', label: 'Customer, Sep 29 (email)', source: { system: 'orderops', ticket_id: 'T1', message_id: 'm-3' }, text: 'The unit arrived with the foam crushed.   Photos attached.' },
      refundRecord,
    ];
    const orderopsAttachment = vi.fn(async () => pdf);
    const bound = await bindDecisionEvidence(ctx, bot, 'bot', proposal({ evidence_items: items, as_of: { captured_at: '2026-09-30T14:00:00Z', ticket_id: 'T1', last_inbound: [{ channel: 'email', message_id: 'm-3' }] } }), { orderopsAttachment });
    expect(orderopsAttachment).toHaveBeenCalledWith('T1', 'att-9');
    expect(bound.evidence_items!.map(i => i.retained)).toEqual([true, true, false, false]);
    expect(bound.evidence_items![2].text).toBe('The unit arrived with the foam crushed. Photos attached.');
    expect(bound.as_of).toMatchObject({ ticket_id: 'T1', evidence_hashes: [bound.evidence_items![0].sha256, bound.evidence_items![1].sha256] });
    const d = s.raise(bot, { source_key: 'T1', proposal_key: 'refund', proposal: bound });
    expect(readDecisionEvidence(ctx, human, d.id, 1, 0)).toMatchObject({ type: 'image/png' });
    expect(readDecisionEvidence(ctx, human, d.id, 1, 1)).toMatchObject({ type: 'application/pdf' });
    expect(() => readDecisionEvidence(ctx, human, d.id, 1, 2)).toThrow('unavailable');
    expect(() => readDecisionEvidence(ctx, human, d.id, 2, 0)).toThrow('Proposal changed');
    // A changed file cannot keep the old hash; without the OrderOps fetcher the file is refused with the exact dependency.
    writeFileSync(file, Buffer.concat([png, Buffer.from('x')]));
    await expect(bindDecisionEvidence(ctx, bot, 'bot', bound, { orderopsAttachment })).rejects.toThrow('changed since it was cited');
    await expect(bindDecisionEvidence(ctx, bot, 'bot', proposal({ evidence_items: [items[1], refundRecord] }))).rejects.toThrow(ORDEROPS_ATTACHMENT_UNAVAILABLE.slice(0, 40));
    await expect(bindDecisionEvidence(ctx, bot, 'bot', proposal({ evidence_items: [{ kind: 'record', label: 'Order', source: { system: 'shopify', order_id: '1' } }] }))).rejects.toThrow('put the facts');
    await expect(bindDecisionEvidence(ctx, bot, 'bot', proposal({ evidence_items: [{ kind: 'image', label: 'Photo', source: { system: 'shopify', order_id: '1' } }, refundRecord] }))).rejects.toThrow('cannot come from shopify');
    await expect(bindDecisionEvidence(ctx, bot, 'bot', proposal({ evidence_items: [{ kind: 'image', label: 'Photo', source: { system: 'upload', path: join(dataDir, 'uploads', 'abc', 'x.png') } }, refundRecord] }))).rejects.toThrow('bots cite chat files');
  });

  it('records a human upload as evidence on the question and refuses paths outside uploads', () => {
    const upload = join(dataDir, 'uploads', 'abc', 'unit.png'); writeFileSync(upload, png);
    const d = s.raise(bot, { source_key: 'T1', proposal_key: 'refund', proposal: proposal() });
    const item = bindHumanEvidence(ctx, { path: upload, label: 'unit.png' });
    expect(item).toMatchObject({ kind: 'image', retained: true, added_by: 'human', source: { system: 'upload' } });
    const view = s.addHumanEvidence(human, d.id, 1, 'attach-1', item);
    expect(view.human_evidence).toHaveLength(1);
    expect(s.addHumanEvidence(human, d.id, 1, 'attach-1', item).human_evidence).toHaveLength(1);
    expect(readDecisionEvidence(ctx, human, d.id, 1, 1)).toMatchObject({ type: 'image/png', item: { added_by: 'human' } });
    expect(() => bindHumanEvidence(ctx, { path: file, label: 'outside' })).toThrow('unavailable');
    expect(() => s.addHumanEvidence(bot, d.id, 1, 'bot-attach', item)).toThrow();
    expect(employeeRouteAllowed('POST', `/bots/decisions/${d.id}/evidence`)).toBe(true);
    expect(employeeRouteAllowed('GET', `/bots/decisions/${d.id}/evidence/1/0`)).toBe(true);
  });

  it('marks open questions stale when the case moves on, refuses answers until revised, wakes the bot, and withdraws forgotten ones', () => {
    const d = s.raise(bot, { source_key: 'T1', proposal_key: 'refund', proposal: proposal({ as_of: { captured_at: '2026-09-30T14:00:00Z', ticket_id: 'T1', last_inbound: [{ channel: 'email', message_id: 'm-3' }] } }) });
    const other = s.raise(bot, { source_key: 'T2', proposal_key: 'refund', proposal: proposal({ as_of: { captured_at: '2026-09-30T14:00:00Z', ticket_id: 'T2', last_inbound: [] } }) });
    const wakes = () => (db.prepare('SELECT count(*) n FROM conversation_wakeups').get() as { n: number }).n;
    const before = wakes();
    acceptEvent(db, 'orderops', { id: 'customer.replied:m-4', type: 'customer.replied', ticket_id: 'T1', occurred_at: '2026-09-30T14:20:00Z', assigned_bot: '11111111-1111-4111-8111-111111111111' });
    const stale = s.view(human, s.read(human, d.id));
    expect(stale.stale).toMatchObject({ reason: 'customer_replied', since: '2026-09-30T14:20:00Z' });
    expect(s.view(human, s.read(human, other.id)).stale).toBeNull();
    expect(wakes()).toBeGreaterThan(before);
    expect(db.prepare("SELECT reason FROM conversation_wakeups WHERE reason LIKE 'VeneerBots stale question%'").all()).toHaveLength(1);
    expect(() => s.choose(human, d.id, 1, 'click', 'a', '', 'this_case')).toThrow('stale');
    expect(() => s.answerCustom(human, d.id, 1, 'typed', 'Replace it')).toThrow('stale');
    // Same event again: no second mark or wake.
    acceptEvent(db, 'orderops', { id: 'customer.replied:m-4', type: 'customer.replied', ticket_id: 'T1', occurred_at: '2026-09-30T14:20:00Z', assigned_bot: '11111111-1111-4111-8111-111111111111' });
    expect(db.prepare("SELECT count(*) n FROM bot_decision_events WHERE decision_id=? AND kind='stale'").get(d.id)).toEqual({ n: 1 });
    // Revising clears the mark and the fresh version is answerable.
    const revised = s.revise(bot, d.id, 1, 'rev', proposal({ as_of: { captured_at: '2026-09-30T14:25:00Z', ticket_id: 'T1', last_inbound: [{ channel: 'email', message_id: 'm-4' }] } }));
    expect(revised.stale).toBeNull();
    expect(s.choose(human, d.id, 2, 'click2', 'a', '', 'this_case').state).toBe('decided');
    // A stale question nobody refreshes is withdrawn after the configured period with an audit note.
    acceptEvent(db, 'orderops', { id: 'customer.replied:m-9', type: 'customer.replied', ticket_id: 'T2', occurred_at: '2026-09-30T14:30:00Z', assigned_bot: '11111111-1111-4111-8111-111111111111' });
    expect(s.withdrawStaleQuestions(60 * 60 * 1000, Date.parse('2026-09-30T14:40:00Z'))).toEqual([]);
    expect(s.withdrawStaleQuestions(60 * 60 * 1000, Date.parse('2026-09-30T16:00:00Z'))).toEqual([other.id]);
    expect(s.view(human, s.read(human, other.id))).toMatchObject({ state: 'decided', answer: { action: 'withdraw', automatic: true } });
    expect(s.withdrawStaleQuestions(60 * 60 * 1000, Date.parse('2026-09-30T16:00:00Z'))).toEqual([]);
  });

  it('enforces evidence at the API, attaches files with a typed answer, and serves evidence through the route', async () => {
    let requestActor: Actor = bot;
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = requestActor.user; req.agentConversationId = requestActor.conversationId; next(); });
    app.use('/api/bots', createBotsRouter(ctx, { evidenceFetchers: {} }));
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/bots`;
    const post = (path: string, body: object) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const bare = await post('/decisions', { source_key: 'T1', proposal_key: 'photos', proposal: { ...proposal(), question: 'Approve? See the 24 photos.' } });
    expect(bare.status).toBe(400); expect((await bare.json()).error).toContain('attaches none');
    const ok = await post('/decisions', { source_key: 'T1', proposal_key: 'refund', proposal: proposal({ evidence_items: [{ kind: 'image', label: 'Box', source: { system: 'chat_file', conversation_id: 'source', path: file } }, refundRecord] }) });
    expect(ok.status).toBe(200);
    const { decision } = await ok.json();
    expect(decision.proposal.evidence_items[0]).toMatchObject({ retained: true });
    requestActor = human;
    const served = await fetch(`${base}/decisions/${decision.id}/evidence/1/0`);
    expect(served.status).toBe(200); expect(served.headers.get('content-type')).toBe('image/png'); expect(served.headers.get('cache-control')).toBe('private, no-store');
    const upload = join(dataDir, 'uploads', 'abc', 'unit.png'); writeFileSync(upload, png);
    const answered = await post(`/decisions/${decision.id}/custom`, { expected_version: 1, request_key: 'typed', text: 'Replace it, the unit itself is cracked', evidence: [{ path: upload, label: 'unit.png' }] });
    expect(answered.status).toBe(200);
    const body = await answered.json();
    expect(body.decision).toMatchObject({ state: 'decided', answer: { action: 'custom' } });
    expect(body.decision.human_evidence).toHaveLength(1);
    expect(db.prepare("SELECT reason FROM conversation_wakeups ORDER BY rowid DESC LIMIT 1").get()).toMatchObject({ reason: expect.stringContaining('Replace it') });
  });
});
