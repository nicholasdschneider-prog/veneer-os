import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { migrate } from '../src/db/migrate.js';
import { createBotService, proposalSchema, type Actor } from '../src/bots/service.js';
import { retainEvidenceBytes } from '../src/bots/decisionEvidence.js';
import { createBrockRelay, signBody, signFileToken, verifyFileToken } from '../src/brockRelay/relay.js';
import { createBrockRouter } from '../src/brockRelay/routes.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZEAAAAAASUVORK5CYII=', 'base64');
const SECRET = 'test-secret-0123456789-abcdefghij';
const JAMES_KEY = 'james-key-for-tests';

describe('Brock relay', () => {
  let db: Database.Database, dir: string, ctx: AppContext, tess: Actor, nick: Actor, now: number;
  let secrets: Record<string, string>;
  let sent: { headers: Record<string, string>; body: string }[];
  let respond: () => Response;
  let relay: ReturnType<typeof createBrockRelay>;
  const servers: Server[] = [];
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys=ON');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@test.invalid','Nick','owner')").run();
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(2,'ali@test.invalid','Ali','member')").run();
    db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Team',1)").run();
    db.prepare("INSERT INTO business_team_members(team_id,user_id,role) VALUES('team',2,'member')").run();
    for (const id of ['tess', 'test', 'other']) {
      db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,?,'claude',?,'team','team')").run(id, id, id);
      db.prepare('INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,?,1)').run(id, id === 'tess' ? 'Tess' : id === 'test' ? 'Brock Relay Test' : 'Other');
      db.prepare("INSERT INTO business_bot_members(conversation_id,team_id,role) VALUES(?,'team','bot')").run(id);
    }
    nick = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow };
    tess = { ...nick, conversationId: 'tess' };
    dir = mkdtempSync(join(tmpdir(), 'brock-relay-'));
    ctx = { db, config: { dataDir: dir, appPublicOrigin: 'https://example.test' }, manager: { listSessionFiles: vi.fn(async () => []), statusOf: async () => 'idle' } } as unknown as AppContext;
    secrets = { BROCK_RELAY_MODE: 'live', BROCK_RELAY_WEBHOOK_URL: 'https://brock.example.test/hook', BROCK_RELAY_WEBHOOK_SECRET: SECRET, BROCK_RELAY_TEST_CHAT_ID: 'test', VENEER_JAMES_API_KEY: JAMES_KEY };
    sent = []; now = Date.parse('2026-11-25T15:00:00Z');
    respond = () => new Response('ok', { status: 200 });
    const fakeFetch = (async (_url: URL, init: RequestInit) => { sent.push({ headers: init.headers as Record<string, string>, body: String(init.body) }); return respond(); }) as unknown as typeof fetch;
    relay = createBrockRelay({ db, getSecret: (n) => secrets[n] ?? null, publicBase: 'https://example.test', fetch: fakeFetch, now: () => now, log: () => {} });
  });
  afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r())); db.close(); rmSync(dir, { recursive: true, force: true }); });

  const proposal = (extra: Record<string, unknown> = {}) => proposalSchema.parse({
    question: 'Refund the rooftop AC line for #100120886?', recommendation: 'Refund after return.', consequence: 'Covers one line only.',
    blocked_action: 'Refund only after the unit is received.', assignee_id: 1,
    choices: [{ id: 'a', label: 'Refund after return', action: 'approve', answer: 'refund', recommended: true }, { id: 'b', label: 'Replace the unit', action: 'approve' }],
    review_summary: { action_title: 'Refund the AC line', background: ['Unit arrived cracked.'] },
    as_of: { captured_at: '2026-11-25T14:00:00Z', ticket_id: 'T-1', orders: [{ order_number: '#100120886' }] },
    ...extra,
  });
  const raise = (actor: Actor = tess, extra: Record<string, unknown> = {}) => createBotService(db).raise(actor, { source_key: 's', proposal_key: crypto.randomUUID(), proposal: proposal(extra) });
  const events = () => sent.map((x) => JSON.parse(x.body) as Record<string, any>);
  let writes: { name: string; value: string }[][] = [];
  let writeFails = false;
  async function serve() {
    const app = express();
    const writer = async (pairs: { name: string; value: string }[]) => {
      if (writeFails) throw new Error(`doppler refused value ${pairs[1]!.value}`);
      writes.push(pairs); for (const p of pairs) secrets[p.name] = p.value;
    };
    app.use('/api/james/brock', createBrockRouter(ctx, relay, (n) => secrets[n] ?? null, { fetchAttachment: async () => ({ error: 'none', status: 404 }) }, writer));
    const server = app.listen(0); servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/james/brock`;
  }
  const answer = (base: string, body: Record<string, unknown>, key = crypto.randomUUID()) => fetch(`${base}/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${JAMES_KEY}`, 'idempotency-key': key }, body: JSON.stringify(body),
  });

  it('signs bodies like the James push and rejects tampered or expired file tokens', () => {
    expect(signBody('k', '{}')).toBe(`sha256=${crypto.createHmac('sha256', 'k').update('{}').digest('hex')}`);
    const t = signFileToken(SECRET, { d: 'x', v: 1, k: 'ev', i: 0, exp: now + 1000 });
    expect(verifyFileToken(SECRET, t, now)).toMatchObject({ d: 'x', v: 1, k: 'ev', i: 0 });
    expect(verifyFileToken(SECRET, t, now + 2000)).toBeNull();
    expect(verifyFileToken('another-secret-0123456789-abcdef', t, now)).toBeNull();
    const [v, p, s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ d: 'y', v: 1, k: 'ev', i: 0, exp: now + 1000 })).toString('base64url');
    expect(verifyFileToken(SECRET, `${v}.${forged}.${s}`, now)).toBeNull();
    expect(p).toBeTruthy();
  });

  it('does nothing while off or misconfigured', async () => {
    secrets.BROCK_RELAY_MODE = 'off'; raise(); await relay.tick();
    secrets.BROCK_RELAY_MODE = 'live'; secrets.BROCK_RELAY_WEBHOOK_URL = 'http://insecure.test'; await relay.tick();
    expect(sent).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) n FROM brock_relay_outbox').get()).toEqual({ n: 0 });
  });

  it('relays only needs-Nick cards from Tess (live) or the test chat (test)', async () => {
    raise(tess, { assignee_id: 2 });
    raise({ ...nick, conversationId: 'other' });
    secrets.BROCK_RELAY_MODE = 'test';
    raise(tess);
    await relay.tick();
    expect(sent).toHaveLength(0);
    const t = raise({ ...nick, conversationId: 'test' });
    await relay.tick();
    expect(events().map((e) => [e.type, e.card.card_id, e.test])).toEqual([['card.raised', t.id, true]]);
    secrets.BROCK_RELAY_MODE = 'live';
    await relay.tick();
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({ type: 'card.raised', test: false, card: { bot: { name: 'Tess' } } });
    await relay.tick();
    expect(events()).toHaveLength(2);
  });

  it('pushes the full card with signed, fetchable attachments', async () => {
    const sha = retainEvidenceBytes(ctx, png, 'image/png');
    const d = raise(tess, { evidence_items: [
      { kind: 'image', label: 'Customer photo', source: { system: 'chat_file', conversation_id: 'tess', path: '/x/photo.png' }, sha256: sha, retained: true },
      { kind: 'record', label: 'Shopify refunds', source: { system: 'shopify', order_id: '5551' }, text: 'No refunds.' },
    ] });
    await relay.tick();
    const [e] = events();
    expect(sent[0]!.headers['x-veneer-signature']).toBe(signBody(SECRET, sent[0]!.body));
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(sent[0]!.headers['idempotency-key']).toBe(e!.event_id);
    expect(e!.card).toMatchObject({
      card_id: d.id, version: 1, order_number: '100120886', order_note: null, customer: null, question: 'Refund the rooftop AC line for #100120886?',
      ticket: { orderops_ticket_id: 'T-1' }, title: 'Refund the AC line',
      options: [{ id: 'a', label: 'Refund after return', value: 'refund', recommended: true }, { id: 'b', value: null }],
      backstory: { recommendation: 'Refund after return.', evidence_notes: [{ label: 'Shopify refunds', text: 'No refunds.' }] },
    });
    expect(e!.card.customer_note).toMatch(/No customer/);
    expect(e!.card.attachments).toHaveLength(1);
    const a = e!.card.attachments[0];
    expect(a).toMatchObject({ origin: 'card_evidence', kind: 'image', name: 'Customer photo', sha256: sha });
    const base = await serve();
    const url = a.url.replace('https://example.test/api/james/brock', base);
    const got = await fetch(url);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await got.arrayBuffer())).toEqual(png);
    const cut = url.length - 10;
    expect((await fetch(url.slice(0, cut) + (url[cut] === 'A' ? 'B' : 'A') + url.slice(cut + 1))).status).toBe(404);
    // Superseded versions stop serving the old link.
    createBotService(db).revise(tess, d.id, 1, 'rev', proposal({ recommendation: 'Replace instead.' }));
    await relay.tick();
    now += 2 * 3_600_000;
    expect((await fetch(url)).status).toBe(404);
  });

  it('first answer wins: Brock answer, replay, conflict, and resolved event', async () => {
    const d = raise();
    await relay.tick();
    const base = await serve();
    expect((await fetch(`${base}/answer`, { method: 'POST' })).status).toBe(401);
    const body = { card_id: d.id, expected_version: 1, answer_text: 'Refund it, skip the return.', answered_via: 'grokbot_brock' };
    const noKey = await fetch(`${base}/answer`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${JAMES_KEY}` }, body: JSON.stringify(body) });
    expect(noKey.status).toBe(400);
    expect((await answer(base, { ...body, expected_version: 2 })).status).toBe(409);
    const first = await answer(base, body, 'brock-key-0001');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, card: { state: 'decided', answered_via: 'grokbot_brock', answer_text: body.answer_text } });
    const replay = await answer(base, body, 'brock-key-0001');
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    const second = await answer(base, { ...body, answer_text: 'Something different' }, 'brock-key-0002');
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'already_resolved', card: { state: 'decided' } });
    const stored = db.prepare('SELECT answer_json FROM bot_decisions WHERE id=?').get(d.id) as { answer_json: string };
    expect(JSON.parse(stored.answer_json)).toMatchObject({ action: 'custom', answer: body.answer_text, actor_id: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM bot_decision_events WHERE decision_id=? AND kind='answered'").get(d.id)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM conversation_wakeups WHERE conversation_id='tess' AND wake_key LIKE 'bot-decision:%'").get()).toEqual({ n: 1 });
    await relay.tick();
    expect(events().at(-1)).toMatchObject({ type: 'card.resolved', card_id: d.id, version: 1, resolution: 'answered', answered_via: 'grokbot_brock', answer: { action: 'custom', value: body.answer_text } });
  });

  it('a web answer resolves the card as veneer and blocks a later Brock answer', async () => {
    const d = raise();
    await relay.tick();
    createBotService(db).choose(nick, d.id, 1, 'web-1', 'a', '', 'this_case');
    await relay.tick();
    expect(events().at(-1)).toMatchObject({ type: 'card.resolved', resolution: 'answered', answered_via: 'veneer', answer: { choice_id: 'a', value: 'refund' } });
    const base = await serve();
    const late = await answer(base, { card_id: d.id, expected_version: 1, answer_text: 'x', answered_via: 'grokbot_brock' });
    expect(late.status).toBe(409);
  });

  it('withdraw, stale and revise each resolve once; revise re-raises the new version in order', async () => {
    const s = createBotService(db);
    const a = raise(); const b = raise(); const c = raise();
    await relay.tick();
    s.withdraw(tess, a.id, 1, 'w', { reason: 'moot', evidence: 'read' });
    s.markStaleForCase(['T-1'], { reason: 'customer_replied', detail: 'Customer replied', event_id: 'e1' });
    await relay.tick();
    const resolved = events().filter((e) => e.type === 'card.resolved');
    expect(resolved.map((e) => [e.card_id, e.resolution])).toEqual(expect.arrayContaining([[a.id, 'withdrawn'], [b.id, 'stale'], [c.id, 'stale']]));
    s.revise(tess, b.id, 1, 'rev', proposal({ recommendation: 'Revised.' }));
    await relay.tick();
    const tail = events().slice(-1);
    expect(tail[0]).toMatchObject({ type: 'card.raised', card: { card_id: b.id, version: 2 } });
    await relay.tick();
    expect(events().filter((e) => e.type === 'card.resolved')).toHaveLength(3);
  });

  it('retries in order with backoff and never stores the secret or URL', async () => {
    respond = () => new Response(`bad ${SECRET} at https://brock.example.test/hook`, { status: 500 });
    raise();
    await relay.tick();
    const row = db.prepare('SELECT * FROM brock_relay_outbox').get() as { attempts: number; status: string; last_error: string; next_attempt_at: string };
    expect(row).toMatchObject({ attempts: 1, status: 'pending' });
    expect(row.last_error).not.toContain(SECRET);
    expect(row.last_error).not.toContain('brock.example.test');
    await relay.tick();
    expect(sent).toHaveLength(1);
    respond = () => new Response('ok', { status: 200 });
    now += 31_000;
    await relay.tick();
    expect(sent).toHaveLength(2);
    expect(db.prepare('SELECT status FROM brock_relay_outbox').get()).toEqual({ status: 'sent' });
  });

  it('skips a raise and its resolve when the card resolved before it could be sent', async () => {
    respond = () => new Response('down', { status: 503 });
    const d = raise();
    await relay.tick();
    createBotService(db).withdraw(tess, d.id, 1, 'w', { reason: 'moot', evidence: 'read' });
    respond = () => new Response('ok', { status: 200 });
    now += 31_000;
    await relay.tick();
    expect(sent.slice(1)).toHaveLength(0);
    expect(db.prepare('SELECT event_type,status FROM brock_relay_outbox ORDER BY id').all()).toEqual([{ event_type: 'card.raised', status: 'skipped' }, { event_type: 'card.resolved', status: 'skipped' }]);
  });

  it('creates a dummy test card with fetchable attachments', async () => {
    secrets.BROCK_RELAY_MODE = 'test';
    const base = await serve();
    const r = await fetch(`${base}/test-card`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${JAMES_KEY}`, 'idempotency-key': 'test-card-0001' }, body: '{}' });
    expect(r.status).toBe(201);
    const { card_id } = await r.json() as { card_id: string };
    await relay.tick();
    const [e] = events();
    expect(e).toMatchObject({ type: 'card.raised', test: true, card: { card_id, order_number: null } });
    expect(e!.card.attachments.map((a: { kind: string }) => a.kind)).toEqual(['image', 'document']);
    for (const a of e!.card.attachments) expect((await fetch(a.url.replace('https://example.test/api/james/brock', base))).status).toBe(200);
    const cards = await fetch(`${base}/cards`, { headers: { authorization: `Bearer ${JAMES_KEY}` } });
    expect(await cards.json()).toMatchObject({ cards: [{ card_id, test: true }] });
  });

  it('webhook-config writes URL and secret to Doppler without ever returning or logging the secret', async () => {
    secrets.BROCK_RELAY_MODE = 'off'; writes = []; writeFails = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = await serve();
    const newSecret = 'grok-side-secret-' + 'x'.repeat(33);
    const post = (body: unknown, key: string | null = crypto.randomUUID(), auth = JAMES_KEY) => fetch(`${base}/webhook-config`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}`, ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) });
    const good = { url: 'https://api2.example.test/automations/webhook/abc', secret: newSecret };
    expect((await post(good, crypto.randomUUID(), 'wrong-key')).status).toBe(401);
    expect((await post(good, null)).status).toBe(400);
    expect((await post({ ...good, url: 'http://insecure.test/hook' })).status).toBe(400);
    expect((await post({ ...good, secret: 'short' })).status).toBe(400);
    expect((await post({ ...good, extra: 1 })).status).toBe(400);
    expect(writes).toHaveLength(0);
    const r = await post(good, 'webhook-config-0001');
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true, url: good.url, secret_length: newSecret.length, secret_sha256_prefix: crypto.createHash('sha256').update(newSecret).digest('hex').slice(0, 12) });
    expect(text).not.toContain(newSecret);
    expect(writes).toEqual([[{ name: 'BROCK_RELAY_WEBHOOK_URL', value: good.url }, { name: 'BROCK_RELAY_WEBHOOK_SECRET', value: newSecret }]]);
    expect(secrets.BROCK_RELAY_MODE).toBe('off');
    const stored = db.prepare("SELECT request_hash, response_json FROM james_idempotency WHERE key='webhook-config-0001'").get() as { request_hash: string; response_json: string };
    expect(JSON.stringify(stored)).not.toContain(newSecret);
    writeFails = true;
    const failed = await post({ ...good, secret: newSecret + 'y' });
    const failedText = await failed.text();
    expect(failed.status).toBe(502);
    expect(failedText).not.toContain(newSecret);
    for (const call of warn.mock.calls) expect(call.join(' ')).not.toContain(newSecret);
    warn.mockRestore();
  });
});
