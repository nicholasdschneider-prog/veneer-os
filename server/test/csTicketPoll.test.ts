import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { UserRow } from '../src/db/db.js';
import { createCsTicketService } from '../src/csTickets/service.js';
import { attachmentPath, AUTH_BLOCK_MS, classifyCaseKey, createTicketPoller, mapOrderOpsMessage, mirrorRequestUrl, ORDEROPS_ORIGIN, POLL_INTERVAL_MS, type OrderOpsMessage } from '../src/csTickets/poll.js';
import { createTaskService } from '../src/tasks/service.js';
import { cleanBody } from '../src/csTickets/body.js';

const migrations = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const OWNER = '11111111-1111-4111-8111-111111111111', TEAM = 'team';
const oo = (over: Partial<OrderOpsMessage> = {}): OrderOpsMessage => ({
  id: 'oo-m1', direction: 'inbound', channel: 'email', fromName: 'Pat Rivera', fromEmail: 'pat@example.test', body: 'Any update on my claim?',
  attachments: JSON.stringify([{ filename: 'IMG_2.jpg', url: 'https://files.example.test/2', size: 10, type: 'image/jpeg' }]), messageType: 'message', createdAt: '2026-10-16T17:00:00.000Z', ...over,
});

describe('OrderOps ticket mirror poll', () => {
  let db: Database.Database;
  let tickets: ReturnType<typeof createCsTicketService>;
  let user: UserRow;
  let clock: number;
  const pendingWakes = () => db.prepare("SELECT wake_key,reason FROM conversation_wakeups WHERE conversation_id=? AND status='pending' ORDER BY created_at").all(OWNER) as { wake_key: string; reason: string }[];
  const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(db, migrations);
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'nick@example.test','Nick','owner')").run();
    db.prepare('INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,1)').run(TEAM, 'ERVP');
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,'Miles','codex','n','team',?)").run(OWNER, TEAM);
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,'Miles',1)").run(OWNER);
    user = db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
    tickets = createCsTicketService(db);
    clock = Date.parse('2026-10-16T17:05:00Z');
  });
  afterEach(() => db.close());
  const mirrored = () => {
    db.prepare('INSERT OR IGNORE INTO cs_ticket_owners(conversation_id) VALUES(?)').run(OWNER);
    const r = tickets.sync({ user, conversationId: OWNER }, { ticket_id: 'OO-1001', subject: 'Cracked skylight', messages: [
      { external_id: 'oo-m0', direction: 'in', author: 'customer', author_label: 'Pat Rivera', body: 'It arrived cracked.', at: '2026-10-16T12:00:00Z' },
    ] });
    db.prepare("UPDATE conversation_wakeups SET status='delivered' WHERE conversation_id=?").run(OWNER);
    return r;
  };
  const poller = (fetchImpl: typeof fetch, readCredential = async () => 'oo_veneer_test') =>
    createTicketPoller(db, { fetch: fetchImpl, readCredential, now: () => clock, log: { info: () => {}, warn: () => {} } });

  it('only ever GETs the two allowlisted OrderOps paths', () => {
    expect(mirrorRequestUrl('/api/cs/conversations/OO-1001/messages')).toBe(`${ORDEROPS_ORIGIN}/api/cs/conversations/OO-1001/messages`);
    expect(mirrorRequestUrl('/api/cs/leases/capability')).toContain('/api/cs/leases/capability');
    expect(() => mirrorRequestUrl('/api/cs/conversations/OO-1001/messages', 'POST')).toThrow(/read-only/);
    expect(() => mirrorRequestUrl('/api/cs/conversations/OO-1001')).toThrow(/not allowed/);
    expect(() => mirrorRequestUrl('/api/cs/leases/OO-1001/claim')).toThrow(/not allowed/);
    expect(() => mirrorRequestUrl('/api/cs/conversations/../../admin/messages')).toThrow(/not allowed/);
    expect(mirrorRequestUrl('/api/cs/conversations?search=VKNA4G&limit=5')).toContain('search=VKNA4G');
    expect(() => mirrorRequestUrl('/api/cs/conversations?search=VKNA4G&limit=5', 'POST')).toThrow(/read-only/);
    expect(() => mirrorRequestUrl('/api/cs/conversations?search=x&limit=500')).toThrow(/not allowed/);
  });

  it('fetches attachment files only by GET on OrderOps attachment paths', async () => {
    const gmail = `/api/cs/gmail-attachments/19fac4f7bf482bf5/${'ANGjdJ_BWZ2-x'.repeat(30)}`;
    expect(mirrorRequestUrl(gmail)).toBe(`${ORDEROPS_ORIGIN}${gmail}`);
    expect(mirrorRequestUrl('/objects/uploads/f5857974-3d75-43e0-a691-7fa5dc12907f.pdf')).toContain('/objects/uploads/');
    expect(mirrorRequestUrl('/api/cs/attachment-blobs/abc-123')).toContain('attachment-blobs');
    expect(() => mirrorRequestUrl(gmail, 'POST')).toThrow(/read-only/);
    expect(() => mirrorRequestUrl('/api/cs/gmail-attachments/a/../../leases/x/claim')).toThrow(/not allowed/);
    expect(() => mirrorRequestUrl('/objects/uploads/../private/x.pdf')).toThrow(/not allowed/);
    expect(attachmentPath(`${ORDEROPS_ORIGIN}/objects/uploads/a1.jpg`)).toBe('/objects/uploads/a1.jpg');
    expect(attachmentPath('https://files.example.test/2')).toBeNull();
    expect(attachmentPath('https://photos.google.com/photo/AF1Qip')).toBeNull();
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      if (String(url).endsWith('.pdf')) return new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'Content-Type': 'image/jpeg' } });
    }) as unknown as typeof fetch;
    const p = poller(fetchImpl);
    expect(await p.fetchAttachment(gmail)).toMatchObject({ type: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff]) });
    expect(await p.fetchAttachment('/objects/uploads/x.pdf')).toEqual({ error: 'Only photos and PDFs are shown here', status: 415 });
    expect(await p.fetchAttachment('https://files.example.test/2')).toMatchObject({ status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(methods).toEqual(['GET', 'GET']);
  });

  it('fetches files one at a time, retries an OrderOps 429, and shares a fetch of the same file', async () => {
    let active = 0, peak = 0, calls = 0, refused = false;
    const fetchImpl = vi.fn(async () => {
      calls++; active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (!refused) { refused = true; return new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }); }
      return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/png' } });
    }) as unknown as typeof fetch;
    const p = poller(fetchImpl);
    const results = await Promise.all(['/objects/uploads/a.png', '/objects/uploads/b.png', '/objects/uploads/a.png', '/objects/uploads/c.png'].map((r) => p.fetchAttachment(r)));
    expect(results.every((r) => 'type' in r && r.type === 'image/png')).toBe(true);
    expect(peak).toBe(1);
    expect(calls).toBe(4); // a (429, then retried), b, c; the second ask for a shared the first fetch
  });

  it('shows live messages when the database is busy instead of recording a poll error', async () => {
    const t = mirrored().ticket;
    const fetchImpl = vi.fn(async () => jsonResponse([oo({ id: 'm-live', body: 'Here are the photos' })])) as unknown as typeof fetch;
    const p = poller(fetchImpl);
    const real = db.transaction.bind(db);
    let busy = 2;
    (db as { transaction: unknown }).transaction = ((fn: () => unknown) => () => { if (busy-- > 0) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); return real(fn)(); }) as never;
    const r = await p.readNow(t.id);
    expect(r).toMatchObject({ added: 0, error: null });
    expect(r.live?.map((m) => m.body)).toEqual(['Here are the photos']);
    expect(tickets.read(t.id)?.last_poll_error).toBeNull();
    expect(await p.readNow(t.id)).toEqual({ added: 1, error: null }); // the next read saves it
    (db as { transaction: unknown }).transaction = real;
  });

  it('makes email bodies readable: no quoted history, signatures, image placeholders or HTML', () => {
    const reply = 'Here is the board.\r\n[image: IMG_4417.jpg]\r\n\r\nSent from my iPhone\r\n\r\nOn Wed, Jul 29, 2026, 12:18 AM Judah Schrotenboer <judah@example.test>\r\nwrote:\r\n\r\n> Can you send a photo?\r\n> Thanks';
    expect(cleanBody(reply)).toEqual({ text: 'Here is the board.', earlier: 'On Wed, Jul 29, 2026, 12:18 AM Judah Schrotenboer <judah@example.test>\nwrote:\n\n> Can you send a photo?\n> Thanks' });
    expect(cleanBody('Any news?\n\nPeter WilliamsSent from my iPhone').text).toBe('Any news?\n\nPeter Williams');
    expect(cleanBody('<div>Hi&nbsp;there<br>Line two</div><p>Bye &amp; thanks</p>').text).toBe('Hi there\nLine two\nBye & thanks');
    expect(cleanBody('See <https://photos.google.com/photo/AF1> please').text).toBe('See https://photos.google.com/photo/AF1 please');
    expect(cleanBody('Shipped today.\n\n[SMS delivery: delivered]').text).toBe('Shipped today.\n\n[SMS delivery: delivered]');
    expect(cleanBody('Thanks\n\n-----Original Message-----\nFrom: a').earlier).toContain('Original Message');
    expect(cleanBody('From: Pat\nSent: Monday\nhello')).toEqual({ text: '', earlier: 'From: Pat\nSent: Monday\nhello' });
    expect(cleanBody('Plain message').text).toBe('Plain message');
  });

  it('tells ticket codes from order numbers and conversation ids', () => {
    expect(classifyCaseKey('VKNA4G')).toBe('ticket_code');
    expect(classifyCaseKey('fwdr22')).toBe('ticket_code');
    expect(classifyCaseKey('100122214')).toBe('order_number');
    expect(classifyCaseKey('53edc425-5a23-40c9-93c5-da838d1529a8')).toBe('uuid');
    expect(classifyCaseKey('cb-4521')).toBe('other');
    expect(classifyCaseKey(null)).toBe('other');
  });

  it('links a task to its OrderOps ticket by exact code, reads the thread on demand, and keeps polling it while the task is open', async () => {
    const tasks = createTaskService(db);
    const task = tasks.create({ user, conversationId: OWNER }, { title: 'Peter Williams lost shipment', case_key: 'YL4YNP' }).task;
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).includes('search=')) return jsonResponse({ conversations: [{ id: 'conv-1', ticketNumber: 'YL4YNPX', subject: 'wrong' }, { id: 'conv-2', ticketNumber: 'YL4YNP', subject: 'A shipment from order #100122104 is on the way', customer: { name: 'Peter Williams', email: 'pw@example.test' } }] });
      return jsonResponse([oo({ id: 'm1', body: 'Are you able to determine if the shipment is lost?', fromName: 'Peter Williams', createdAt: '2026-10-27T19:22:00Z' })]);
    }) as unknown as typeof fetch;
    const p = poller(fetchImpl);
    const found = await p.findConversation('YL4YNP');
    expect(found).toMatchObject({ id: 'conv-2', ticketNumber: 'YL4YNP' });
    const ticket = tickets.linkTaskTicket(task, found!);
    expect(ticket).toMatchObject({ task_id: task.id, orderops_ticket_id: 'conv-2', customer_name: 'Peter Williams', ticket_conversation_id: null });
    expect(await p.readNow(ticket.id)).toEqual({ added: 1, error: null });
    expect(tickets.messages(ticket.id).map((m) => m.body)).toEqual(['Are you able to determine if the shipment is lost?']);
    expect(pendingWakes().filter((w) => w.wake_key.startsWith('cs-ticket:'))).toEqual([]); // a task-linked ticket has no ticket chat, so no ticket wake
    expect(tickets.pollCandidates(25).map((t) => t.id)).toEqual([ticket.id]); // polled although the owner is not an enrolled ticket owner
    tasks.mark({ user }, OWNER, { kind: 'task', id: task.id, mark: 'done' });
    expect(tickets.pollCandidates(25)).toEqual([]);
    expect(await p.findConversation('NOPE99')).toBeNull();
  });

  it('maps OrderOps rows onto the ticket record and drops internal notes', () => {
    expect(mapOrderOpsMessage(oo())).toEqual({ external_id: 'oo-m1', direction: 'in', channel: 'email', author: 'customer', author_label: 'Pat Rivera', body: 'Any update on my claim?', attachments: [{ name: 'IMG_2.jpg', reference: 'https://files.example.test/2' }], at: '2026-10-16T17:00:00.000Z' });
    expect(mapOrderOpsMessage(oo({ id: 'oo-m2', direction: 'outbound', channel: 'sms', fromName: null, actorType: 'api_principal', actorContext: { profile: 'Miles' }, body: 'Replacement ships Monday.', attachments: null, deliveryStatus: 'delivered' })))
      .toMatchObject({ direction: 'out', channel: 'sms', author: 'bot', author_label: 'Miles', body: 'Replacement ships Monday.\n\n[SMS delivery: delivered]' });
    expect(mapOrderOpsMessage(oo({ id: 'oo-m3', direction: 'outbound', channel: 'email', actorType: 'staff', actorContext: { displayName: 'Ali' }, body: 'Refund issued.' }))).toMatchObject({ author: 'human', author_label: 'Ali' });
    expect(mapOrderOpsMessage(oo({ messageType: 'internal_note' }))).toBeNull();
    expect(mapOrderOpsMessage(oo({ channel: 'internal', body: '' , attachments: null }))).toBeNull();
    expect(mapOrderOpsMessage(oo({ createdAt: 'nope' }))).toBeNull();
    expect(mapOrderOpsMessage(oo({ attachments: '{broken' }))).toMatchObject({ attachments: [] });
  });

  it('records new messages, wakes the ticket chat only for new inbound ones, and paces itself', async () => {
    const r = mirrored();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      expect(String((init?.headers as Record<string, string>).Authorization)).toBe('Bearer oo_veneer_test');
      return jsonResponse([oo({ id: 'oo-m0', body: 'It arrived cracked.', createdAt: '2026-10-16T12:00:00Z' }), oo({ id: 'oo-out', direction: 'outbound', actorType: 'staff', actorContext: { displayName: 'Ali' }, body: 'Looking into it.', createdAt: '2026-10-16T13:00:00Z' })]);
    }) as unknown as typeof fetch;
    const p = poller(fetchImpl);
    expect(await p.tick()).toMatchObject({ polled: 1, added: 1, woke: 0, errors: 0 });
    expect(calls).toEqual([`GET ${ORDEROPS_ORIGIN}/api/cs/conversations/OO-1001/messages`]);
    expect(tickets.messages(r.ticket.id).map((m) => m.external_id)).toEqual(['oo-m0', 'oo-out']);
    expect(pendingWakes()).toEqual([]);
    expect(tickets.read(r.ticket.id)).toMatchObject({ last_polled_at: new Date(clock).toISOString(), last_poll_error: null });
    // Within the interval nothing runs; after it, a new customer message wakes the ticket chat once.
    expect((await p.tick()).skipped).toBe('interval');
    clock += POLL_INTERVAL_MS;
    (fetchImpl as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => jsonResponse([oo({ id: 'oo-m0', createdAt: '2026-10-16T12:00:00Z' }), oo(), oo({ id: 'oo-m2', body: 'Second nudge', createdAt: '2026-10-16T17:01:00Z' })]));
    expect(await p.tick()).toMatchObject({ polled: 1, added: 2, woke: 1 });
    const wakes = pendingWakes();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.wake_key).toBe(`cs-ticket:${r.ticket.id}:poll:oo-m2`);
    expect(wakes[0]!.reason).toContain('2 new customer messages');
    expect(wakes[0]!.reason).toContain('oo-m1, oo-m2');
    expect(tickets.read(r.ticket.id)!.last_inbound_at).toBe('2026-10-16T17:01:00.000Z');
    // Already-recorded messages (from sync or an earlier poll) are never re-announced.
    clock += POLL_INTERVAL_MS;
    expect(await p.tick()).toMatchObject({ polled: 1, added: 0, woke: 0 });
    expect(pendingWakes()).toHaveLength(1);
  });

  it('skips done tickets and tickets whose owner is not enrolled', async () => {
    const r = mirrored();
    tickets.setStatus({ user, conversationId: OWNER, executionConversationId: r.ticket_conversation_id! }, { status: 'done' });
    const fetchImpl = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;
    expect(await poller(fetchImpl).tick()).toMatchObject({ polled: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    db.prepare("UPDATE cs_tickets SET status='open' WHERE id=?").run(r.ticket.id);
    db.prepare('UPDATE cs_ticket_owners SET enabled=0 WHERE conversation_id=?').run(OWNER);
    expect(await poller(fetchImpl).tick()).toMatchObject({ polled: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('backs off a failing ticket and pauses the mirror for 15 minutes on an auth refusal', async () => {
    const r = mirrored();
    let status = 503;
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, status)) as unknown as typeof fetch;
    const p = poller(fetchImpl);
    expect(await p.tick()).toMatchObject({ polled: 0, errors: 1 });
    expect(tickets.read(r.ticket.id)!.last_poll_error).toBe('OrderOps returned 503');
    expect(p.backoffState(r.ticket.id)).toMatchObject({ failures: 1, nextAt: clock + 60_000 });
    clock += POLL_INTERVAL_MS;
    expect(await p.tick()).toMatchObject({ polled: 0, errors: 1 });
    expect(p.backoffState(r.ticket.id)).toMatchObject({ failures: 2, nextAt: clock + 120_000 });
    clock += 2 * POLL_INTERVAL_MS;
    status = 401;
    expect(await p.tick()).toMatchObject({ polled: 0, errors: 1 });
    expect(p.authBlockedUntil()).toBe(clock + AUTH_BLOCK_MS);
    expect(tickets.read(r.ticket.id)!.last_poll_error).toContain('refused the mirror principal (401)');
    clock += POLL_INTERVAL_MS;
    expect((await p.tick()).skipped).toBe('auth_block');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // A missing credential never throws out of the loop.
    const broken = poller(fetchImpl, async () => { throw new Error('Doppler CLI is not available'); });
    clock += AUTH_BLOCK_MS;
    expect((await broken.tick()).skipped).toBe('credential');
  });

  it('reads the credential once per cache window', async () => {
    mirrored();
    const readCredential = vi.fn(async () => 'oo_veneer_test');
    const fetchImpl = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;
    const p = poller(fetchImpl, readCredential);
    await p.tick(); clock += POLL_INTERVAL_MS; await p.tick(); clock += POLL_INTERVAL_MS; await p.tick();
    expect(readCredential).toHaveBeenCalledTimes(1);
    clock += 10 * 60_000;
    await p.tick();
    expect(readCredential).toHaveBeenCalledTimes(2);
  });
});
