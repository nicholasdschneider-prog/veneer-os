import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { ConversationRow, UserRow } from '../src/db/db.js';
import type { AppContext } from '../src/context.js';
import { createCsTicketService, presentMessage } from '../src/csTickets/service.js';
import { createCsTicketsRouter } from '../src/csTickets/routes.js';
import { createBotService, proposalSchema } from '../src/bots/service.js';
import { acceptEventDetailed, saveRoutine } from '../src/botWorkflows/routines.js';
import { wakeTarget } from '../src/coordination/botLane.js';
import { coordinationLane } from '../src/coordination/store.js';
import { canSendToConversation, canViewConversation } from '../src/conversations/access.js';
import { BOT_TOOL_DEFINITIONS, callBotTool } from '../src/mcp/botTools.js';

const migrations = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const OWNER = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222', TEAM = 'team';
const sample = (extra: Record<string, unknown> = {}) => ({
  ticket_id: 'OO-1001', subject: 'Cracked skylight on arrival', channel: 'email',
  customer: { name: 'Pat Rivera', email: 'pat@example.test' }, orders: [{ order_number: '#4521' }],
  summary: 'ParcelGuard claim; photos received.',
  messages: [
    { external_id: 'm1', direction: 'in', author: 'customer', author_label: 'Pat Rivera', body: 'The skylight arrived cracked, photos attached.', attachments: [{ name: 'IMG_1.jpg' }], at: '2026-10-16T12:00:00Z' },
    { external_id: 'm2', direction: 'out', author: 'bot', author_label: 'Miles', body: 'Sorry about that, filing the claim now.', at: '2026-10-16T12:10:00Z' },
  ],
  ...extra,
});

describe('cs tickets owned inside Veneer (Miles pilot)', () => {
  let db: Database.Database;
  let user: UserRow;
  let tickets: ReturnType<typeof createCsTicketService>;
  const conv = (id: string) => db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow;
  const pendingWakes = (id: string) => db.prepare("SELECT wake_key,reason FROM conversation_wakeups WHERE conversation_id=? AND status='pending' ORDER BY created_at").all(id) as { wake_key: string; reason: string }[];
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(db, migrations);
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'nick@example.test','Nick','owner'),(2,'ali@example.test','Ali','member')").run();
    db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,1)").run(TEAM, 'ERVP');
    for (const [id, name] of [[OWNER, 'Miles'], [OTHER, 'Tess']] as const) {
      db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,?,'codex',?,'team',?)").run(id, name, `native-${id}`, TEAM);
      db.prepare('INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,?,1)').run(id, name);
    }
    db.prepare('INSERT INTO cs_ticket_owners(conversation_id) VALUES(?)').run(OWNER);
    user = db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
    tickets = createCsTicketService(db);
  });
  afterEach(() => db.close());

  it('mirrors a ticket into its own chat, wakes it there, and keeps it visible where the bot is', () => {
    const r = tickets.sync({ user, conversationId: OWNER }, sample());
    expect(r.created).toBe(true);
    expect(r.messages_added).toBe(2);
    expect(r.handed_off).toBe(true);
    const lane = conv(r.ticket_conversation_id!);
    expect(lane.title).toBe('Ticket OO-1001 · Cracked skylight on arrival');
    expect(lane.business_team_id).toBe(TEAM);
    expect(coordinationLane(db, lane.id)?.owner_id).toBe(OWNER);
    // The wake is scheduled on the owner's chat and lands in the ticket chat.
    const [wake] = pendingWakes(OWNER);
    expect(wake!.wake_key.startsWith(`cs-ticket:${r.ticket.id}:sync:`)).toBe(true);
    expect(wake!.reason).toContain('owns it start to finish');
    expect(wakeTarget(db, conv(OWNER), 'w1', wake!.wake_key).id).toBe(lane.id);
    // Visible exactly where Miles is; never a send target for a human.
    expect(canViewConversation(user, lane, db)).toBe(true);
    expect(canSendToConversation(user, lane, db)).toBe(false);
    expect(tickets.ticketOfLane(lane.id)?.orderops_ticket_id).toBe('OO-1001');
  });

  it('dedupes messages by OrderOps id and does not hand off when synced from the ticket chat', () => {
    const first = tickets.sync({ user, conversationId: OWNER }, sample());
    const again = tickets.sync({ user, conversationId: OWNER, executionConversationId: first.ticket_conversation_id! }, sample({
      messages: [...sample().messages, { external_id: 'm3', direction: 'in', author: 'customer', body: 'Any update?', at: '2026-10-16T15:00:00Z' }],
    }));
    expect(again.created).toBe(false);
    expect(again.messages_added).toBe(1);
    expect(again.handed_off).toBe(false);
    expect(again.ticket.last_inbound_at).toBe('2026-10-16T15:00:00Z');
    expect(tickets.messages(first.ticket.id)).toHaveLength(3);
    expect(pendingWakes(OWNER)).toHaveLength(1);
  });

  it('refuses bots that are not enrolled owners and protects another owner\'s ticket', () => {
    expect(() => tickets.sync({ user, conversationId: OTHER }, sample())).toThrow(/enrolled/);
    tickets.sync({ user, conversationId: OWNER }, sample());
    db.prepare('INSERT INTO cs_ticket_owners(conversation_id) VALUES(?)').run(OTHER);
    expect(() => tickets.sync({ user, conversationId: OTHER }, sample())).toThrow(/another bot/);
    expect(() => tickets.setStatus({ user, conversationId: OTHER }, { ticket_id: 'OO-1001', status: 'done' })).toThrow(/does not own/);
  });

  it('routes an OrderOps customer.replied event to the ticket chat and skips the owner\'s routine', () => {
    db.prepare("INSERT INTO bot_event_sources(id,team_id,created_by,name) VALUES('source',?,1,'OrderOps')").run(TEAM);
    for (const id of [OWNER, OTHER]) saveRoutine(db, user, id, { name: 'Replies', instructions: 'Handle', kind: 'customer.replied', source: 'source', enabled: true });
    const r = tickets.sync({ user, conversationId: OWNER }, sample());
    tickets.setStatus({ user, conversationId: OWNER, executionConversationId: r.ticket_conversation_id! }, { status: 'done', reason: 'Claim filed' });
    const accepted = acceptEventDetailed(db, 'source', { id: 'evt-1', type: 'customer.replied', ticket_id: 'OO-1001', occurred_at: '2026-10-16T16:00:00Z', assigned_bot: OWNER });
    expect(accepted.queued).toBe(1);
    const wakes = pendingWakes(OWNER);
    expect(wakes.map((w) => w.wake_key)).toEqual(expect.arrayContaining([`cs-ticket:${r.ticket.id}:event:source:evt-1`]));
    expect(wakes.some((w) => w.wake_key.startsWith('bot-routine:'))).toBe(false);
    expect(tickets.read(r.ticket.id)!.status).toBe('open');
    // A ticket nobody owns in Veneer still goes to the routine as before.
    const other = acceptEventDetailed(db, 'source', { id: 'evt-2', type: 'customer.replied', ticket_id: 'OO-2002', occurred_at: '2026-10-16T16:00:00Z', assigned_bot: OTHER });
    expect(other.queued).toBe(1);
    expect(pendingWakes(OTHER).some((w) => w.wake_key.startsWith('bot-routine:'))).toBe(true);
  });

  it('binds a question raised from the ticket chat and sends the answer wake back there', () => {
    const r = tickets.sync({ user, conversationId: OWNER }, sample());
    const bots = createBotService(db);
    const d = bots.raise({ user, conversationId: OWNER }, { source_key: 'OO-1001', proposal_key: 'claim', proposal: proposalSchema.parse({
      question: 'Replace or refund the skylight?', recommendation: 'Replace.', consequence: 'Ships a new unit.', assignee_id: 1, blocked_action: 'Ship replacement',
      choices: [{ id: 'replace', label: 'Ship a replacement skylight', description: 'Matches the claim photos', action: 'approve', recommended: true }, { id: 'refund', label: 'Refund the skylight line', description: 'Customer keeps the cracked unit', action: 'reject' }],
    }) });
    expect(tickets.linkDecision(d.id, r.ticket_conversation_id!)?.id).toBe(r.ticket.id);
    expect(tickets.read(r.ticket.id)!.status).toBe('waiting_human');
    const listed = tickets.list({ user }, OWNER, 'needs_you');
    expect(listed.tickets).toHaveLength(1);
    expect(listed.tickets[0]!.open_decision).toMatchObject({ id: d.id, recommended: 'Ship a replacement skylight' });
    expect(tickets.list({ user }, OWNER, 'waiting').tickets).toHaveLength(0);
    bots.choose({ user }, d.id, 1, 'k1', 'replace', '', 'this_case');
    tickets.decisionAnswered(d.id);
    expect(tickets.read(r.ticket.id)!.status).toBe('open');
    const answer = pendingWakes(OWNER).find((w) => w.wake_key.startsWith('bot-decision:'))!;
    expect(wakeTarget(db, conv(OWNER), 'w2', answer.wake_key).id).toBe(r.ticket_conversation_id);
    const context = tickets.contextBlock(r.ticket_conversation_id!)!;
    expect(context).toContain('Pat Rivera <pat@example.test>');
    expect(context).toContain('IN Pat Rivera: The skylight arrived cracked');
    expect(context).toContain('[attachments: IMG_1.jpg]');
    expect(context).toContain(`Question ${d.id} v1 (decided): Replace or refund the skylight? → answer: Ship a replacement skylight`);
    expect(tickets.laneRules(r.ticket_conversation_id!)).toContain('OrderOps ticket OO-1001');
    expect(tickets.laneRules(OWNER)).toBeNull();
  });

  it('records a human note once, wakes the ticket chat, and marks Remember as a standing instruction', () => {
    const r = tickets.sync({ user, conversationId: OWNER }, sample());
    const note = tickets.humanNote({ user }, r.ticket.id, { body: 'Always offer a replacement first on ParcelGuard claims.', remember: true, request_key: 'n1' });
    expect(note.duplicate).toBe(false);
    expect(tickets.humanNote({ user }, r.ticket.id, { body: 'Always offer a replacement first on ParcelGuard claims.', remember: true, request_key: 'n1' }).duplicate).toBe(true);
    const wake = pendingWakes(OWNER).find((w) => w.wake_key === `cs-ticket:${r.ticket.id}:note:${note.note_id}`)!;
    expect(wake.reason).toContain('Nick wrote on ticket OO-1001');
    expect(wake.reason).toContain('update_skill');
    expect(tickets.contextBlock(r.ticket_conversation_id!)).toContain('NOTE Nick [Remember]: Always offer a replacement first');
    const ali = db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow;
    expect(() => tickets.detail({ user: ali }, r.ticket.id)).toThrow(/not found/);
  });

  it('keeps bot notes short with tappable choices, carries human attachments to the ticket chat, and tells the bot the style', () => {
    const r = tickets.sync({ user, conversationId: OWNER }, sample());
    const lane = { user, conversationId: OWNER, executionConversationId: r.ticket_conversation_id! };
    expect(() => tickets.botNote(lane, { body: 'REPLY TO NICHOLAS — see thread 2896e911.' })).toThrow(/Rewrite the note/);
    expect(() => tickets.botNote(lane, { body: 'Short.', choices: [{ label: 'A', note: 'a', recommended: true }, { label: 'B', note: 'b', recommended: true }] })).toThrow(/at most one/);
    expect(() => tickets.botNote(lane, { body: 'Short.', choices: [{ label: 'Only one', note: 'x' }] })).toThrow();
    const noted = tickets.botNote(lane, { body: 'The carrier has the photos. We need you to pick refund or replacement.', choices: [{ label: 'Ship a replacement', note: 'Ship a replacement skylight.', recommended: true }, { label: 'Refund the line', note: 'Refund the skylight line.' }] });
    expect(noted.choices).toBe(2);
    const msgs = tickets.messages(r.ticket.id).map(presentMessage);
    expect(msgs[msgs.length - 1]).toMatchObject({ author: 'bot', choices: [{ label: 'Ship a replacement', recommended: true }, { label: 'Refund the line' }] });
    expect(tickets.contextBlock(r.ticket_conversation_id!)).toContain('[choices offered: Ship a replacement | Refund the line]');
    expect(tickets.laneRules(r.ticket_conversation_id!)).toContain('at most three plain sentences');
    const human = tickets.humanNote({ user }, r.ticket.id, { body: 'Here is the invoice.', remember: false, request_key: 'n2', attachments: [{ name: 'invoice.pdf', reference: '/data/uploads/ab12cd34ef/invoice.pdf' }] });
    const wake = pendingWakes(OWNER).find((w) => w.wake_key === `cs-ticket:${r.ticket.id}:note:${human.note_id}`)!;
    expect(wake.reason).toContain('- /data/uploads/ab12cd34ef/invoice.pdf (invoice.pdf)');
    expect(wake.reason).toContain('End with 2–4 tappable choices');
    expect(tickets.messages(r.ticket.id).map(presentMessage).pop()).toMatchObject({ author: 'human', attachments: [{ name: 'invoice.pdf' }] });
  });

  describe('HTTP and tool surface', () => {
    let server: Server, url: string;
    beforeEach(async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const bot = String(req.headers['x-test-bot'] ?? '');
        const execution = String(req.headers['x-test-execution'] ?? '');
        req.user = bot ? { ...user, botSession: true } as UserRow : user;
        if (bot) req.agentConversationId = bot;
        if (execution) req.agentExecutionConversationId = execution;
        next();
      });
      app.use('/api/cs-tickets', createCsTicketsRouter({ db } as unknown as AppContext));
      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => { await new Promise((resolve) => server.close(resolve)); });
    const callApi = (headers: Record<string, string>) => async (path: string, init?: RequestInit) => {
      const res = await fetch(url + path, { ...init, headers: { 'Content-Type': 'application/json', ...headers } });
      return (await res.json()) as Record<string, unknown>;
    };
    it('serves the tools to the enrolled bot and the ticket page to its humans', async () => {
      expect(BOT_TOOL_DEFINITIONS.map((t) => t.name)).toEqual(expect.arrayContaining(['sync_cs_ticket', 'set_cs_ticket_status', 'add_cs_ticket_note']));
      const synced = await callBotTool({ name: 'sync_cs_ticket', args: sample(), callApi: callApi({ 'x-test-bot': OWNER }) });
      const payload = JSON.parse(synced!.content[0]!.text) as { ticket: { id: string }; ticket_conversation_id: string; handed_off: boolean };
      expect(payload.handed_off).toBe(true);
      const noted = await callBotTool({ name: 'add_cs_ticket_note', args: { body: 'Claim filed with ParcelGuard, ref PG-77.' }, callApi: callApi({ 'x-test-bot': OWNER, 'x-test-execution': payload.ticket_conversation_id }) });
      expect(JSON.parse(noted!.content[0]!.text)).toMatchObject({ ticket: { id: payload.ticket.id } });
      const refused = await callBotTool({ name: 'set_cs_ticket_status', args: { status: 'done' }, callApi: callApi({ 'x-test-bot': OTHER }) });
      expect(JSON.parse(refused!.content[0]!.text)).toMatchObject({ error: expect.stringContaining('enrolled') });
      const list = await callApi({})(`/api/cs-tickets?owner=${OWNER}&filter=waiting&q=skylight`);
      expect(list).toMatchObject({ enabled: true, owner: { name: 'Miles' }, tickets: [{ orderops_ticket_id: 'OO-1001', message_count: 3, open_decision: null }] });
      const detail = await callApi({})(`/api/cs-tickets/${payload.ticket.id}`);
      expect((detail.messages as unknown[]).length).toBe(3);
      expect(detail.decisions).toEqual([]);
      const noteResult = await callApi({})(`/api/cs-tickets/${payload.ticket.id}/notes`, { method: 'POST', body: JSON.stringify({ body: 'Check the photos again.', remember: false, request_key: 'h1' }) });
      expect(noteResult).toMatchObject({ duplicate: false });
      expect(await callApi({ 'x-test-bot': OWNER })(`/api/cs-tickets/${payload.ticket.id}`)).toMatchObject({ error: expect.stringContaining('human') });
    });
  });
});
