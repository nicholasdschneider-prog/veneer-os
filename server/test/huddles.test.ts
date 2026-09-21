import Database from 'better-sqlite3';
import express from 'express';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { ConversationWakeupRow, UserRow } from '../src/db/db.js';
import {
  BOT_POSTS_PER_10_MIN,
  createHuddleReconciler,
  createHuddleService,
  dedupeKeyFor,
  HuddleError,
  WAKE_SPACING_MS,
  type Actor,
} from '../src/huddles/service.js';
import { createHuddlesRouter } from '../src/huddles/routes.js';
import { createConversationWakeupScheduler } from '../src/scheduled/wakeups.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import type { AppContext } from '../src/context.js';

const BOTS = ['bot-lead', 'bot-robin', 'bot-sage', 'bot-quill', 'bot-vale', 'bot-wren', 'bot-extra'] as const;

describe('huddles', () => {
  let db: Database.Database;
  let s: ReturnType<typeof createHuddleService>;
  let clock: Date;
  let human: Actor;
  let lead: Actor;
  let robin: Actor;
  let sage: Actor;
  const now = () => clock;
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  const pendingWakes = (conversationId: string) =>
    db.prepare("SELECT * FROM conversation_wakeups WHERE conversation_id=? AND status='pending'").all(conversationId) as ConversationWakeupRow[];

  beforeEach(() => {
    clock = new Date('2026-09-21T12:00:00.000Z');
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    for (let i = 1; i <= 3; i++)
      db.prepare('INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,?)').run(i, `person${i}@example.test`, `Person ${i}`, i === 1 ? 'owner' : 'member');
    for (const id of BOTS) {
      db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'claude',?,'team')").run(id, `${id} title`, `native-${id}`);
      db.prepare('INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,1)').run(id, id.replace('bot-', '').replace(/^./, (c) => c.toUpperCase()));
    }
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES('plain-chat',1,1,'Not a bot','claude','native-plain','team')").run();
    s = createHuddleService(db, { now, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    const owner = db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
    human = { user: owner };
    lead = { user: owner, conversationId: 'bot-lead' };
    robin = { user: owner, conversationId: 'bot-robin' };
    sage = { user: owner, conversationId: 'bot-sage' };
  });
  afterEach(() => db.close());

  const openDefault = (extra: Record<string, unknown> = {}, actor: Actor = lead) =>
    s.open(actor, {
      goal: 'Resolve fixture order 4242 replacement and refund',
      why: 'Replacement shipping, refund and customer reply depend on each other across three bots.',
      members: ['bot-robin', 'bot-sage'],
      request_key: 'open-4242',
      ...extra,
    });

  it('opens a huddle with the caller as lead, wakes the other members once with the goal, never the author', () => {
    const { huddle, created } = openDefault();
    expect(created).toBe(true);
    expect(huddle.lead.conversation_id).toBe('bot-lead');
    expect(huddle.owner?.conversation_id).toBe('bot-lead');
    expect(huddle.members.map((m) => m.conversation_id).sort()).toEqual(['bot-lead', 'bot-robin', 'bot-sage']);
    expect(huddle.messages).toHaveLength(1);
    expect(huddle.messages[0]!.kind).toBe('system');
    expect(huddle.messages[0]!.recipients.sort()).toEqual(['bot-robin', 'bot-sage']);
    expect(pendingWakes('bot-lead')).toHaveLength(0);
    for (const id of ['bot-robin', 'bot-sage']) {
      const wakes = pendingWakes(id);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.wake_key).toBe(`huddle:${huddle.id}`);
      expect(wakes[0]!.reason).toContain('Resolve fixture order 4242');
      expect(wakes[0]!.reason).toContain('read_huddle');
      expect(wakes[0]!.reason).toContain('never post just to acknowledge');
      // The wake runs as the bot chat's own user, never as the poster.
      expect(wakes[0]!.actor_user_id).toBe(1);
    }
  });

  it('keeps two-bot requests as direct messages: a bot cannot open a huddle with fewer than three bots', () => {
    expect(() => openDefault({ members: ['bot-robin'] })).toThrowError(/at least 3 bots/);
    expect(() => openDefault({ members: [] })).toThrowError(/at least 3 bots/);
  });

  it('caps a huddle at six bots and refuses unregistered or foreign chats', () => {
    expect(() => openDefault({ members: ['bot-robin', 'bot-sage', 'bot-quill', 'bot-vale', 'bot-wren', 'bot-extra'] })).toThrowError(/at most 6/);
    expect(() => openDefault({ members: ['bot-robin', 'plain-chat'] })).toThrowError(/not an active registered bot/);
    db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team-a','A',1),('team-b','B',1)").run();
    db.prepare("UPDATE conversations SET business_team_id='team-a' WHERE id IN ('bot-lead','bot-robin')").run();
    db.prepare("UPDATE conversations SET business_team_id='team-b' WHERE id='bot-sage'").run();
    expect(() => openDefault()).toThrowError(/another business/);
  });

  it('reuses the open huddle for the same goal instead of creating a duplicate, and is idempotent by request key', () => {
    const first = openDefault();
    const again = openDefault();
    expect(again.created).toBe(false);
    expect(again.huddle.id).toBe(first.huddle.id);
    // A different bot opening the same outcome joins the existing thread.
    const joined = s.open({ user: human.user, conversationId: 'bot-quill' }, {
      goal: 'RESOLVE fixture order 4242 — replacement and refund!',
      why: 'Same outcome, different phrasing, so it must join rather than fork the work.',
      members: ['bot-vale', 'bot-wren'],
      request_key: 'quill-open',
    });
    expect(joined.created).toBe(false);
    expect(joined.reused).toBe(true);
    expect(joined.huddle.id).toBe(first.huddle.id);
    expect(joined.huddle.members.filter((m) => !m.left_at)).toHaveLength(6);
    expect(joined.huddle.lead.conversation_id).toBe('bot-lead');
    expect(db.prepare('SELECT COUNT(*) AS n FROM huddles').get()).toEqual({ n: 1 });
    expect(dedupeKeyFor('Resolve fixture order 4242 replacement and refund')).toBe(dedupeKeyFor('RESOLVE fixture order 4242 — replacement and refund!'));
    // A dedupe key ties the huddle to the outcome regardless of wording.
    const keyed = s.open(lead, { goal: 'Something entirely different about order 4242', why: 'Same case key, same thread by design.', members: ['bot-robin', 'bot-sage'], dedupe_key: 'resolve fixture order 4242 replacement and refund', request_key: 'k2' });
    expect(keyed.huddle.id).toBe(first.huddle.id);
  });

  it('routes untargeted posts to the owner or lead, targeted posts only to mentions, and handoffs move ownership', () => {
    const { huddle } = openDefault();
    db.prepare("UPDATE conversation_wakeups SET status='delivered', delivered_at=datetime('now')").run();
    advance(WAKE_SPACING_MS + 1_000);
    // Robin replies without a target: only the lead (current owner) is woken.
    const reply = s.post(robin, huddle.id, { text: 'Replacement is in stock; shipping label ready.', request_key: 'r1' });
    expect(reply.message.recipients).toEqual(['bot-lead']);
    expect(pendingWakes('bot-sage')).toHaveLength(0);
    expect(pendingWakes('bot-lead')).toHaveLength(1);
    // Lead hands off to Sage: Sage owns the next step and is woken; lead is the author so not woken.
    const handoff = s.post(lead, huddle.id, { text: 'Sage, please process the refund now.', targets: ['bot-sage'], kind: 'handoff', request_key: 'h1' });
    expect(handoff.message.recipients).toEqual(['bot-sage']);
    expect(s.get(human, huddle.id).owner?.conversation_id).toBe('bot-sage');
    // Sage's untargeted update goes back to the lead, who stays accountable.
    const update = s.post(sage, huddle.id, { text: 'Refund issued, reference RF-1.', request_key: 's1' });
    expect(update.message.recipients).toEqual(['bot-lead']);
    // A targeted post only wakes the named member.
    const direct = s.post(lead, huddle.id, { text: 'Robin, confirm the tracking number.', targets: ['bot-robin'], request_key: 'd1' });
    expect(direct.message.recipients).toEqual(['bot-robin']);
    // A handoff by a non-lead also informs the lead.
    const sideHandoff = s.post(robin, huddle.id, { text: 'Sage, customer reply is yours.', targets: ['bot-sage'], kind: 'handoff', request_key: 'h2' });
    expect(sideHandoff.message.recipients.sort()).toEqual(['bot-lead', 'bot-sage']);
    // Status posts change the status line without waking the team.
    const status = s.post(sage, huddle.id, { text: 'Waiting on carrier pickup', kind: 'status', request_key: 'st1' });
    expect(status.message.recipients).toEqual(['bot-lead']);
    expect(s.get(human, huddle.id).status_note).toBe('Waiting on carrier pickup');
    // Authorship is preserved on every message.
    const view = s.get(human, huddle.id);
    expect(view.messages.map((m) => m.author.name)).toEqual(['Veneer', 'Robin', 'Lead', 'Sage', 'Lead', 'Robin', 'Sage']);
    // Human posts route to the owner, never fan out; the user is not the router.
    const humanPost = s.post(human, huddle.id, { text: 'Please keep the customer informed.', request_key: 'u1' });
    expect(humanPost.message.recipients).toEqual(['bot-sage']);
    expect(humanPost.message.author.user_id).toBe(1);
  });

  it('coalesces wakes: repeated posts refresh one pending wake per member and later wakes are spaced out', () => {
    const { huddle } = openDefault();
    const first = pendingWakes('bot-robin')[0]!;
    s.post(lead, huddle.id, { text: 'Robin, one', targets: ['bot-robin'], request_key: 'a' });
    s.post(lead, huddle.id, { text: 'Robin, two', targets: ['bot-robin'], request_key: 'b' });
    const wakes = pendingWakes('bot-robin');
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.id).toBe(first.id);
    expect(wakes[0]!.reason).toContain('3 new messages');
    expect(wakes[0]!.reason).toContain('Robin, two');
    // Deliver it, then a new post within the spacing window is scheduled later, not immediately.
    db.prepare("UPDATE conversation_wakeups SET status='delivered', delivered_at=datetime('now') WHERE id=?").run(first.id);
    advance(5_000);
    s.post(lead, huddle.id, { text: 'Robin, three', targets: ['bot-robin'], request_key: 'c' });
    const next = pendingWakes('bot-robin');
    expect(next).toHaveLength(1);
    expect(next[0]!.id).not.toBe(first.id);
    expect(new Date(next[0]!.scheduled_for).getTime() - new Date(first.scheduled_for).getTime()).toBeGreaterThanOrEqual(WAKE_SPACING_MS);
    expect(next[0]!.reason).toContain('1 new message ');
    expect(next[0]!.reason).not.toContain('Robin, two');
  });

  it('stops reply storms with per-bot posting limits and idempotent request keys', () => {
    const { huddle } = openDefault();
    for (let i = 0; i < BOT_POSTS_PER_10_MIN; i++) s.post(robin, huddle.id, { text: `update ${i}`, request_key: `u${i}` });
    expect(() => s.post(robin, huddle.id, { text: 'one more', request_key: 'over' })).toThrowError(/Posting limit reached/);
    // Retrying the same request key returns the same message instead of a duplicate.
    const dup = s.post(robin, huddle.id, { text: 'update 0', request_key: 'u0' });
    expect(dup.duplicate).toBe(true);
    advance(11 * 60_000);
    expect(s.post(robin, huddle.id, { text: 'later', request_key: 'later' }).duplicate).toBe(false);
  });

  it('tracks actions with owners and resumes dependent work automatically when a prerequisite finishes', () => {
    const { huddle } = openDefault();
    db.prepare("UPDATE conversation_wakeups SET status='delivered', delivered_at=datetime('now')").run();
    advance(WAKE_SPACING_MS + 1_000);
    let v = s.addAction(lead, huddle.id, { title: 'Ship replacement', owner: 'bot-robin' });
    const ship = v.actions.find((a) => a.title === 'Ship replacement')!;
    expect(pendingWakes('bot-robin')).toHaveLength(1);
    v = s.addAction(lead, huddle.id, { title: 'Email customer tracking', owner: 'bot-sage', depends_on: [ship.id] });
    const email = v.actions.find((a) => a.title === 'Email customer tracking')!;
    expect(email.blocked_by).toEqual([ship.id]);
    // Sage is not woken for a blocked action.
    expect(pendingWakes('bot-sage')).toHaveLength(0);
    // Only the owner or the lead can complete an action.
    expect(() => s.updateAction(sage, huddle.id, ship.id, { status: 'done' })).toThrowError(/Only the owner or the lead/);
    v = s.updateAction(robin, huddle.id, ship.id, { status: 'done', note: 'Tracking 1Z999' });
    expect(v.actions.find((a) => a.id === ship.id)?.status).toBe('done');
    // Completing it unblocks the dependent and wakes its owner with a system message.
    const unblocked = v.messages.find((m) => m.body.startsWith('Unblocked:'));
    expect(unblocked?.recipients).toEqual(['bot-sage']);
    expect(unblocked?.action_id).toBe(email.id);
    expect(pendingWakes('bot-sage')).toHaveLength(1);
    expect(pendingWakes('bot-sage')[0]!.reason).toContain('Actions you own: Email customer tracking');
  });

  it('closes only with verification and no open actions, keeps history, and supports intentional reopen', () => {
    const { huddle } = openDefault();
    const v = s.addAction(lead, huddle.id, { title: 'Ship replacement', owner: 'bot-robin' });
    const ship = v.actions[0]!;
    expect(() => s.close(robin, huddle.id, 'Robin thinks it is done')).toThrowError(/Only the huddle lead/);
    expect(() => s.close(lead, huddle.id, 'short')).toThrow();
    expect(() => s.close(lead, huddle.id, 'Everything verified complete.')).toThrowError(/Finish or cancel these actions/);
    s.updateAction(robin, huddle.id, ship.id, { status: 'done' });
    const closed = s.close(lead, huddle.id, 'Refund RF-1 confirmed in Shopify and customer acknowledged by email.');
    expect(closed.status).toBe('closed');
    expect(closed.close_verification).toContain('RF-1');
    expect(closed.messages.length).toBeGreaterThan(2);
    expect(pendingWakes('bot-robin')).toHaveLength(0);
    expect(() => s.post(robin, huddle.id, { text: 'late', request_key: 'late' })).toThrowError(/closed/);
    // Closed huddles stay readable and listable, and can be reopened by a member with a reason.
    expect(s.list(robin, 'closed')).toHaveLength(1);
    expect(s.list(robin, 'open')).toHaveLength(0);
    const reopened = s.reopen(sage, huddle.id, 'Customer says the refund never arrived.');
    expect(reopened.status).toBe('open');
    expect(reopened.reopened_at).not.toBeNull();
    expect(reopened.messages.at(-1)?.body).toContain('reopened');
    expect(pendingWakes('bot-lead')).toHaveLength(1);
    // A human manager can close and cancels leftovers explicitly.
    s.addAction(lead, huddle.id, { title: 'Leftover', owner: 'bot-sage' });
    const humanClosed = s.close(human, huddle.id, 'Owner verified the refund landed on the customer statement.');
    expect(humanClosed.status).toBe('closed');
    expect(humanClosed.actions.find((a) => a.title === 'Leftover')?.status).toBe('cancelled');
  });

  it('isolates identity and permissions: non-members cannot read or post, joining grants nothing, humans need bot access', () => {
    const { huddle } = openDefault();
    const outsider: Actor = { user: human.user, conversationId: 'bot-quill' };
    expect(() => s.get(outsider, huddle.id)).toThrowError(HuddleError);
    expect(() => s.post(outsider, huddle.id, { text: 'hi', request_key: 'x' })).toThrowError(/not found/);
    // A member cannot act as another member: authorship is the authenticated chat.
    const posted = s.post(robin, huddle.id, { text: 'from robin', request_key: 'r' });
    expect(posted.message.author.conversation_id).toBe('bot-robin');
    // Members cannot mention someone outside the huddle.
    expect(() => s.post(robin, huddle.id, { text: 'hey', targets: ['bot-quill'], request_key: 'q' })).toThrowError(/not an active member/);
    // Only the lead transfers the lead; ownership stays inside the roster.
    expect(() => s.patch(robin, huddle.id, { lead: 'bot-robin' })).toThrowError(/Only the huddle lead/);
    expect(() => s.patch(lead, huddle.id, { owner: 'bot-quill' })).toThrowError(/active member/);
    // A private bot chat of another user is invisible to a member who cannot view it.
    const other = db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow;
    db.prepare("UPDATE conversations SET visibility='private' WHERE id='bot-lead'").run();
    expect(s.list({ user: other }, 'all')).toHaveLength(0);
    expect(() => s.get({ user: other }, huddle.id)).toThrowError(/not found/);
    // A member who leaves keeps read access to history but can no longer post, and its wake is cancelled.
    s.patch(robin, huddle.id, { leave: true });
    expect(pendingWakes('bot-robin')).toHaveLength(0);
    expect(s.get(robin, huddle.id).my_role).toBe('left');
    expect(() => s.post(robin, huddle.id, { text: 'still here?', request_key: 'z' })).toThrowError(/no longer a member/);
    // Wakes never carry the poster's identity: they run as the recipient chat's own user.
    db.prepare("UPDATE conversations SET user_id=2 WHERE id='bot-sage'").run();
    db.prepare("UPDATE conversation_wakeups SET status='cancelled', cancelled_at=datetime('now')").run();
    db.prepare('UPDATE huddle_members SET pending_wakeup_id=NULL, last_wake_at=NULL').run();
    s.post(lead, huddle.id, { text: 'Sage, your turn', targets: ['bot-sage'], request_key: 'sg' });
    expect(pendingWakes('bot-sage')[0]!.actor_user_id).toBe(2);
  });

  it('recovers lost deliveries after a restart: reconcile folds delivered wakes and re-wakes members with undelivered messages', () => {
    const { huddle } = openDefault();
    const robinWake = pendingWakes('bot-robin')[0]!;
    // Simulate: Robin's wake delivered, Sage's wake lost (cancelled by an archive/restore cycle).
    db.prepare("UPDATE conversation_wakeups SET status='delivered', delivered_at=datetime('now') WHERE id=?").run(robinWake.id);
    db.prepare("UPDATE conversation_wakeups SET status='cancelled', cancelled_at=datetime('now') WHERE conversation_id='bot-sage'").run();
    advance(WAKE_SPACING_MS + 1_000);
    const scheduled = s.reconcile();
    expect(scheduled).toBe(1);
    expect(pendingWakes('bot-robin')).toHaveLength(0);
    expect(pendingWakes('bot-sage')).toHaveLength(1);
    const robinRow = db.prepare("SELECT delivered_seq, pending_wakeup_id FROM huddle_members WHERE huddle_id=? AND conversation_id='bot-robin'").get(huddle.id) as { delivered_seq: number; pending_wakeup_id: string | null };
    expect(robinRow).toEqual({ delivered_seq: 1, pending_wakeup_id: null });
    // A second reconcile is a no-op: nothing is duplicated.
    expect(s.reconcile()).toBe(0);
    expect(pendingWakes('bot-sage')).toHaveLength(1);
    // Archived member chats are not woken (and do not loop), but show up in the view.
    db.prepare("UPDATE conversations SET archived=1 WHERE id='bot-sage'").run();
    db.prepare("UPDATE conversation_wakeups SET status='cancelled', cancelled_at=datetime('now') WHERE conversation_id='bot-sage'").run();
    expect(s.reconcile()).toBe(0);
    expect(pendingWakes('bot-sage')).toHaveLength(0);
    expect(s.get(human, huddle.id).members.find((m) => m.conversation_id === 'bot-sage')?.archived).toBe(true);
    const reconciler = createHuddleReconciler({ service: s, tickMs: 60_000, log: { warn: vi.fn() } });
    reconciler.start();
    reconciler.stop();
  });

  it('delivers a huddle wake through the real scheduler and manager as the recipient bot turn, and read_huddle acknowledges it', async () => {
    const runs: { prompt: string; convId: string }[] = [];
    const adapter: ProviderAdapter = {
      id: 'claude',
      mintSessionId: () => '',
      readTranscript: async () => [],
      runTurn(spec, onEvent) {
        runs.push({ prompt: spec.prompt, convId: spec.conversationId });
        onEvent({ type: 'turn_done', turnId: spec.turnId });
        return { done: Promise.resolve(), kill: () => {}, respondToApproval: () => true };
      },
    };
    const manager = createConversationManager({
      db,
      steerAckWaitMs: 5,
      adapters: { claude: adapter },
      resolveWorkspace: () => ({ workspaceDir: '/tmp', assistantSlug: 'assistant', elevated: false, fullAccess: false }),
      log: { warn: vi.fn(), error: vi.fn() },
    });
    const scheduler = createConversationWakeupScheduler({ db, manager, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    try {
      const { huddle } = openDefault();
      // Wakes are scheduled a second out; the scheduler uses wall-clock time.
      db.prepare("UPDATE conversation_wakeups SET scheduled_for=datetime('now','-1 minute')").run();
      scheduler.tick();
      await new Promise((r) => setTimeout(r, 50));
      const woke = runs.map((r) => r.convId).sort();
      expect(woke).toEqual(['bot-robin', 'bot-sage']);
      expect(runs[0]!.prompt).toContain(`huddle_id ${huddle.id}`);
      expect(db.prepare("SELECT COUNT(*) AS n FROM conversation_wakeups WHERE status='delivered'").get()).toEqual({ n: 2 });
      // Reading as Robin acknowledges everything; the member has nothing unread afterwards.
      const read = s.read(robin, huddle.id);
      expect(read.my_unread).toBe(0);
      expect(read.members.find((m) => m.conversation_id === 'bot-robin')?.pending_wake).toBe(false);
      expect(s.reconcile()).toBe(0);
    } finally {
      scheduler.stop();
      manager.shutdown();
      await new Promise((r) => setImmediate(r));
    }
  });

  describe('REST routes', () => {
    let server: Server;
    let base: string;
    let asConversation: string | undefined;
    beforeEach(async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.user = human.user;
        req.agentConversationId = asConversation;
        next();
      });
      app.use('/api/huddles', createHuddlesRouter({ db } as unknown as AppContext));
      await new Promise<void>((r) => {
        server = app.listen(0, '127.0.0.1', r);
      });
      const address = server.address() as { port: number };
      base = `http://127.0.0.1:${address.port}`;
    });
    afterEach(async () => {
      await new Promise<void>((r) => server.close(() => r()));
    });
    const call = async (path: string, init?: RequestInit) => {
      const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json' } });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    it('exposes create, read, post, actions, close and reopen with the request identity as the actor', async () => {
      asConversation = 'bot-lead';
      const created = await call('/api/huddles', {
        method: 'POST',
        body: JSON.stringify({ goal: 'Fixture outcome for the REST test', why: 'Three bots share one deliverable here.', members: ['bot-robin', 'bot-sage'], request_key: 'rest-1' }),
      });
      expect(created.status).toBe(201);
      const id = created.body.huddle.id as string;
      expect((await call('/api/huddles', { method: 'POST', body: JSON.stringify({ goal: 'Fixture outcome for the REST test', why: 'Three bots share one deliverable here.', members: ['bot-robin', 'bot-sage'], request_key: 'rest-1' }) })).status).toBe(200);
      asConversation = 'bot-robin';
      const posted = await call(`/api/huddles/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Robin here', request_key: 'p1' }) });
      expect(posted.status).toBe(201);
      expect(posted.body.message.author.conversation_id).toBe('bot-robin');
      const read = await call(`/api/huddles/${id}?ack=1`);
      expect(read.status).toBe(200);
      expect(read.body.huddle.my_unread).toBe(0);
      expect(read.body.huddle.can_manage).toBe(false);
      asConversation = 'bot-quill';
      expect((await call(`/api/huddles/${id}`)).status).toBe(404);
      expect((await call(`/api/huddles/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'intruder', request_key: 'i' }) })).status).toBe(404);
      asConversation = undefined;
      const list = await call('/api/huddles?status=all');
      expect(list.body.huddles).toHaveLength(1);
      const action = await call(`/api/huddles/${id}/actions`, { method: 'POST', body: JSON.stringify({ title: 'Do the thing', owner: 'bot-sage' }) });
      expect(action.status).toBe(201);
      const actionId = action.body.huddle.actions[0].id as string;
      const badClose = await call(`/api/huddles/${id}/close`, { method: 'POST', body: JSON.stringify({ verification: 'x' }) });
      expect(badClose.status).toBe(400);
      expect((await call(`/api/huddles/${id}/actions/${actionId}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) })).status).toBe(200);
      const closed = await call(`/api/huddles/${id}/close`, { method: 'POST', body: JSON.stringify({ verification: 'Owner verified the fixture outcome end to end.' }) });
      expect(closed.status).toBe(200);
      expect(closed.body.huddle.status).toBe('closed');
      const reopened = await call(`/api/huddles/${id}/reopen`, { method: 'POST', body: JSON.stringify({ reason: 'Not actually done.' }) });
      expect(reopened.body.huddle.status).toBe('open');
      const candidates = await call(`/api/huddles/candidates?huddle=${id}`);
      expect(candidates.body.bots.map((b: { conversation_id: string }) => b.conversation_id)).not.toContain('bot-lead');
      const removed = await call(`/api/huddles/${id}/members/bot-sage`, { method: 'DELETE' });
      expect(removed.body.huddle.members.find((m: { conversation_id: string }) => m.conversation_id === 'bot-sage').left_at).not.toBeNull();
    });
  });
});
