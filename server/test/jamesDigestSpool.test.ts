import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { MailNotSentError, type MailMessage } from '../src/jamesLink/mail.js';
import { JamesLink } from '../src/jamesLink/service.js';
import { importSpool, spoolKey, validateItem } from '../src/jamesLink/spool.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let db: Database.Database;
let dir: string;
let clock: number;
let link: JamesLink;
const sent: Array<{ to: string; subject: string; body: string }> = [];
let failTo: string[] = [];
let unclear: 'no_id' | null = null;
let sentBox: MailMessage[] = [];
const fetchMock = vi.fn();

function item(over: Record<string, unknown> = {}) {
  return {
    version: 1, source: 'ervp/vendor-reply-watch', idempotency_key: 'vendor-reply-0001', created_at: '2026-10-14T13:11:27.177361+00:00',
    category: 'change_alert', subject: '[VENEER] Vendor reply: Karen re PO 100122602', body: 'Karen says the PO line must change.',
    urgent: null, needs_nick_today: false, needed_on: null, reason: null, evidence: null, immediate: null, ...over,
  };
}
const URGENT = { urgent: 'money', needs_nick_today: true, needed_on: '2026-10-15', reason: 'Refund due today', evidence: ['order 1001'] };
/** Spool an item the way ERVP does: write it to tmp, then link it into inbox under its key. */
function spool(value: Record<string, unknown>, key = spoolKey(String(value.source), String(value.idempotency_key))) {
  const tmp = path.join(dir, 'tmp', `${key}.1.json`);
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.linkSync(tmp, path.join(dir, 'inbox', `${key}.json`));
  fs.unlinkSync(tmp);
  return key;
}
const receipt = (key: string) => JSON.parse(fs.readFileSync(path.join(dir, 'receipts', `${key}.json`), 'utf8'));
const exists = (...p: string[]) => fs.existsSync(path.join(dir, ...p));
function adapterReady(over: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(dir, 'ERVP_ADAPTER_READY'), JSON.stringify({
    version: 1, build: 822, commit: 'aeabeafe', at: '2026-10-14T12:27:08Z', heartbeat_email_disabled: true, heartbeat_task_mode: 'buffer_only', ...over,
  }));
}
const accept = () => fs.writeFileSync(path.join(dir, 'CUTOVER_ACCEPTED'), JSON.stringify({ version: 1, coordination_thread: '9bb5b47e', contract_check_key: 'k' }));
const at = (isoTime: string) => { clock = Date.parse(isoTime); };

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'james-digest-test-'));
  sent.length = 0;
  failTo = [];
  unclear = null;
  sentBox = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
  at('2026-10-14T13:00:00Z'); // 9:00 ET
  link = new JamesLink({
    db,
    getSecret: (name) => ({ JAMES_WEBHOOK_URL: 'https://grok.example.com/hook', JAMES_WEBHOOK_KEY: 'hook-key' } as Record<string, string>)[name] ?? null,
    fetch: fetchMock as unknown as typeof fetch,
    mailer: {
      async send(to, subject, body) {
        if (failTo.includes(to)) throw new MailNotSentError('smtp down');
        sent.push({ to, subject, body });
        return { messageId: unclear === 'no_id' ? null : `msg-${sent.length}` };
      },
      async search(query) { return query.startsWith('in:sent') ? sentBox : []; },
    },
    now: () => clock,
    publicOrigin: 'https://veneer.example.com',
    postToChat: async () => ({}),
    statusOf: async () => 'idle',
    sleep: async () => undefined,
    spoolDir: dir,
    commit: 'abc123',
  });
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('spool item validation', () => {
  it('accepts a routine item and an urgent one with every authority field', () => {
    const routine = item();
    expect(validateItem(JSON.stringify(routine), spoolKey(routine.source, routine.idempotency_key))).toMatchObject({ ok: true });
    const urgent = item({ ...URGENT, idempotency_key: 'urgent-0001', immediate: { status: 'sent', to: 'nicks@mail.grokbot.com', message_id: 'x1' } });
    expect(validateItem(JSON.stringify(urgent), spoolKey(urgent.source, urgent.idempotency_key))).toMatchObject({ ok: true });
  });
  it('rejects urgent items missing authority, routine items carrying it, bad keys and bad JSON', () => {
    const check = (value: Record<string, unknown>) => validateItem(JSON.stringify(value), spoolKey(String(value.source), String(value.idempotency_key)));
    expect(check(item({ urgent: 'money' }))).toMatchObject({ ok: false, reason: expect.stringContaining('needs_nick_today') });
    expect(check(item({ ...URGENT, needed_on: null, immediate: { status: 'sent', to: 'a', message_id: null } }))).toMatchObject({ ok: false, reason: expect.stringContaining('needed_on') });
    expect(check(item({ ...URGENT, needed_on: 'tomorrow', immediate: { status: 'sent', to: 'a', message_id: null } }))).toMatchObject({ ok: false });
    expect(check(item({ reason: 'not urgent' }))).toMatchObject({ ok: false, reason: expect.stringContaining('reason must be null') });
    expect(check(item({ source: 'other/x' }))).toMatchObject({ ok: false });
    expect(validateItem(JSON.stringify(item()), 'f'.repeat(64))).toMatchObject({ ok: false, reason: expect.stringContaining('is not sha256') });
    expect(validateItem('{', 'f'.repeat(64))).toEqual({ ok: false, reason: 'not valid JSON' });
  });
});

describe('importer', () => {
  beforeEach(() => { for (const d of ['inbox', 'tmp', 'ingested', 'rejected', 'receipts', 'originals']) fs.mkdirSync(path.join(dir, d)); });

  it('ingests, receipts and moves valid items, rejects invalid ones, and leaves foreign files alone', () => {
    const good = spool(item());
    const bad = spool(item({ idempotency_key: 'bad-item-0001', urgent: 'customer' }));
    fs.writeFileSync(path.join(dir, 'inbox', '.pending-abc.json'), '{}');
    fs.writeFileSync(path.join(dir, 'originals', `${good}.json`), 'ervp copy');
    expect(importSpool(db, dir, '2026-10-14T13:00:00.000Z')).toEqual({ ingested: 1, duplicate: 0, rejected: 1 });
    expect(receipt(good)).toMatchObject({ key: good, state: 'ingested', reason: null, digest_date: null, message_id: null });
    expect(exists('ingested', `${good}.json`)).toBe(true);
    expect(receipt(bad)).toMatchObject({ state: 'rejected', reason: expect.stringContaining('needs_nick_today') });
    expect(exists('rejected', `${bad}.json`) && exists('rejected', `${bad}.err`)).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'inbox'))).toEqual(['.pending-abc.json']);
    expect(fs.readFileSync(path.join(dir, 'originals', `${good}.json`), 'utf8')).toBe('ervp copy');
    expect(db.prepare('SELECT source, idempotency_key, state FROM james_digest_items').all())
      .toEqual([{ source: 'ervp/vendor-reply-watch', idempotency_key: 'vendor-reply-0001', state: 'ingested' }]);
  });

  it('re-ingests after a crash without a duplicate and keeps the stored state', () => {
    const key = spool(item());
    importSpool(db, dir, '2026-10-14T13:00:00.000Z');
    db.prepare("UPDATE james_digest_items SET state = 'digested', digest_date = '2026-10-15', message_id = 'm9'").run();
    // A crash before the rename leaves the same file in inbox.
    fs.copyFileSync(path.join(dir, 'ingested', `${key}.json`), path.join(dir, 'inbox', `${key}.json`));
    expect(importSpool(db, dir, '2026-10-14T13:01:00.000Z')).toEqual({ ingested: 0, duplicate: 1, rejected: 0 });
    expect(receipt(key)).toMatchObject({ state: 'digested', digest_date: '2026-10-15', message_id: 'm9' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM james_digest_items').get()).toEqual({ n: 1 });
  });
});

describe('readiness and cutover gate', () => {
  it('writes NATIVE_READY after the self-check, leaving no self-check rows', () => {
    link.runSpool(clock);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'NATIVE_READY'), 'utf8'))).toMatchObject({ version: 1, build: 827, commit: 'abc123' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM james_digest_items').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM james_digest_rejections').get()).toEqual({ n: 0 });
  });

  it('writes ACTIVE only with an accepted cutover and a buffer-only ERVP adapter, for tomorrow after 8:30 ET', () => {
    link.runSpool(clock);
    adapterReady({ heartbeat_task_mode: 'email' });
    accept();
    link.runSpool(clock);
    expect(exists('ACTIVE')).toBe(false);
    adapterReady();
    fs.rmSync(path.join(dir, 'CUTOVER_ACCEPTED'));
    link.runSpool(clock);
    expect(exists('ACTIVE')).toBe(false);
    accept();
    link.runSpool(clock);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'ACTIVE'), 'utf8'))).toMatchObject({ version: 1, first_digest_date: '2026-10-15' });
    expect(exists('CUTOVER_ACCEPTED')).toBe(false);
    // Removing ACTIVE is a full rollback: nothing writes it back.
    fs.rmSync(path.join(dir, 'ACTIVE'));
    link.runSpool(clock);
    expect(exists('ACTIVE')).toBe(false);
  });

  it('uses today as the first digest date before 8:30 ET', () => {
    at('2026-10-14T11:00:00Z'); // 7:00 ET
    adapterReady();
    accept();
    link.runSpool(clock);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'ACTIVE'), 'utf8')).first_digest_date).toBe('2026-10-14');
  });
});

describe('ACTIVE daily digest', () => {
  async function activate() {
    adapterReady();
    accept();
    await link.tick(); // 9:00 ET on 10-14: first digest is 10-15
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'ACTIVE'), 'utf8')).first_digest_date).toBe('2026-10-15');
  }
  const digests = () => sent.filter((m) => m.subject.startsWith('[VENEER] Daily digest'));

  it('sends one digest per date with ERVP items, urgent checks first, and receipts them', async () => {
    await activate();
    expect(sent).toEqual([]);
    const routine = spool(item());
    const contract = spool(item({ source: 'ervp/contract-check', idempotency_key: 'contract-check-0001' }));
    const urgent = spool(item({ ...URGENT, idempotency_key: 'urgent-0002', subject: 'Refund 1001', created_at: '2026-10-14T15:00:00Z', immediate: { status: 'unknown', to: 'nicks@mail.grokbot.com', message_id: null } }));
    const rejected = spool(item({ idempotency_key: 'bad-item-0002', urgent: 'customer' }));
    at('2026-10-14T20:00:00Z');
    await link.tick();
    expect(receipt(routine).state).toBe('ingested');
    expect(digests()).toEqual([]);

    at('2026-10-15T12:31:00Z'); // 8:31 ET on the first digest date
    await link.tick();
    expect(digests()).toHaveLength(1);
    const mail = digests()[0]!;
    expect(mail).toMatchObject({ to: 'nicks@mail.grokbot.com', subject: '[VENEER] Daily digest 2026-10-15' });
    expect(mail.subject).not.toContain('[VENEER] [VENEER]');
    expect(mail.body).toContain('NEEDS A MANUAL SENT CHECK: 1 urgent item');
    expect(mail.body.indexOf('Refund 1001')).toBeLessThan(mail.body.indexOf('Vendor reply: Karen'));
    expect(mail.body).toContain('immediate email: unknown');
    expect(mail.body).toContain(`key ${routine}`);
    expect(mail.body).not.toContain(contract);
    expect(mail.body).toContain(`${rejected}: `);
    expect(mail.body).toContain('James webhook: healthy');
    expect(db.prepare('SELECT status, message_id, item_count, rejected_count FROM james_digests').all())
      .toEqual([{ status: 'sent', message_id: 'msg-1', item_count: 2, rejected_count: 1 }]);
    expect(receipt(routine)).toMatchObject({ state: 'digested', digest_date: '2026-10-15', message_id: 'msg-1' });
    expect(receipt(urgent)).toMatchObject({ state: 'digested' });
    expect(receipt(contract)).toMatchObject({ state: 'ingested' });

    at('2026-10-15T13:31:00Z');
    await link.tick();
    expect(digests()).toHaveLength(1);
    // The next day's digest goes even when empty: it is the heartbeat.
    at('2026-10-16T12:35:00Z');
    await link.tick();
    expect(digests()).toHaveLength(2);
    expect(digests()[1]!.body).toContain('ERVP items (0)');
  });

  it('carries held James pushes and the webhook state, with no separate webhook-down email', async () => {
    await activate();
    fetchMock.mockImplementation(async () => new Response('{"error":"rate limit"}', { status: 400 }));
    at('2026-10-15T12:31:00Z');
    await link.tick();
    expect(sent.filter((m) => !m.subject.startsWith('[VENEER] Daily digest'))).toEqual([]);
    const mail = digests()[0]!;
    expect(mail.body).toMatch(/James webhook: failing since 2026-10-15T12:31:00.000Z; 1 push\(es\) held for this digest; last error: webhook returned HTTP 400/);
    expect(db.prepare("SELECT status, digest_date FROM james_pushes WHERE kind = 'heartbeat' AND json_extract(payload_json, '$.date') = '2026-10-15'").get()).toEqual({ status: 'emailed', digest_date: '2026-10-15' });
  });

  it('marks an unclear send unknown, never re-sends it, and names it in the next digest', async () => {
    await activate();
    const key = spool(item());
    unclear = 'no_id';
    at('2026-10-15T12:31:00Z');
    await link.tick();
    expect(digests()).toHaveLength(1);
    expect(digests()[0]!.to).toBe('nicks@mail.grokbot.com');
    expect(db.prepare('SELECT status, message_id FROM james_digests').get()).toEqual({ status: 'unknown', message_id: null });
    expect(receipt(key)).toMatchObject({ state: 'digest_unknown', digest_date: '2026-10-15' });
    at('2026-10-15T14:00:00Z');
    await link.tick();
    expect(digests()).toHaveLength(1);
    unclear = null;
    at('2026-10-16T12:31:00Z');
    await link.tick();
    expect(digests()).toHaveLength(2);
    expect(digests()[1]!.body).toContain(`2026-10-15: 1 item(s), keys ${key}`);
    expect(digests()[1]!.body).not.toContain('Karen says the PO line must change.');
  });

  it('proves an unclear send through an exact Sent match', async () => {
    await activate();
    unclear = 'no_id';
    sentBox = [{ messageId: 'sent-1', sender: 'me', subject: '[VENEER] Daily digest 2026-10-15', text: '' }];
    at('2026-10-15T12:31:00Z');
    await link.tick();
    expect(db.prepare('SELECT status, message_id FROM james_digests').get()).toEqual({ status: 'sent', message_id: 'sent-1' });
  });

  it('falls back to the second address only after a certain failure, and releases items when both fail', async () => {
    await activate();
    const key = spool(item());
    failTo = ['nicks@mail.grokbot.com', 'nick@elkhartrvparts.com'];
    at('2026-10-15T12:31:00Z');
    await link.tick();
    expect(db.prepare('SELECT status FROM james_digests').get()).toEqual({ status: 'failed' });
    expect(receipt(key).state).toBe('ingested');
    expect(db.prepare('SELECT digest_date FROM james_digest_items').get()).toEqual({ digest_date: null });
    at('2026-10-15T15:00:00Z');
    await link.tick();
    expect(sent).toEqual([]);
    failTo = ['nicks@mail.grokbot.com'];
    at('2026-10-16T12:31:00Z');
    await link.tick();
    expect(sent.map((m) => m.to)).toEqual(['nick@elkhartrvparts.com']);
    expect(db.prepare("SELECT status FROM james_digests WHERE date = '2026-10-16'").get()).toEqual({ status: 'fallback' });
    expect(receipt(key)).toMatchObject({ state: 'digested', digest_date: '2026-10-16' });
  });

  it('includes bodies in full up to about 60 KB, then lists subject, source and key only', async () => {
    await activate();
    const keys = Array.from({ length: 20 }, (_, n) => spool(item({ idempotency_key: `bulk-item-${String(n).padStart(4, '0')}`, subject: `Bulk ${n}`, body: `${String(n).padStart(2, '0')}`.repeat(2000), created_at: `2026-10-14T14:${String(n).padStart(2, '0')}:00Z` })));
    at('2026-10-15T12:31:00Z');
    await link.tick();
    const body = digests()[0]!.body;
    expect(body).toContain('00'.repeat(2000));
    expect(body).not.toContain('19'.repeat(2000));
    expect(body).toContain(`— Bulk 19 · ervp/vendor-reply-watch · key ${keys[19]}`);
    expect(body.length).toBeLessThan(75_000);
  });

  it('settles a digest left sending by a dead process as unknown without sending', async () => {
    await activate();
    db.prepare("INSERT INTO james_digests (date, status, claimed_at) VALUES ('2026-10-14', 'sending', '2026-10-14T12:31:00.000Z')").run();
    at('2026-10-14T20:00:00Z');
    await link.tick();
    expect(db.prepare("SELECT status FROM james_digests WHERE date = '2026-10-14'").get()).toEqual({ status: 'unknown' });
    expect(sent).toEqual([]);
  });
});
