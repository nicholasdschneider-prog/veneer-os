import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { ConversationRow, UserRow } from '../src/db/db.js';
import type { AppContext } from '../src/context.js';
import { createTaskService, TASK_CAP_PER_OWNER } from '../src/tasks/service.js';
import { createTasksRouter } from '../src/tasks/routes.js';
import { createBotService, proposalSchema } from '../src/bots/service.js';
import { wakeTarget } from '../src/coordination/botLane.js';
import { coordinationLane } from '../src/coordination/store.js';
import { canSendToConversation, canViewConversation } from '../src/conversations/access.js';
import { BOT_TOOL_DEFINITIONS, callBotTool } from '../src/mcp/botTools.js';

const migrations = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const OWNER = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222', TEAM = 'team';

describe('shared Tasks capability', () => {
  let db: Database.Database;
  let user: UserRow;
  let tasks: ReturnType<typeof createTaskService>;
  const conv = (id: string) => db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow;
  const pendingWakes = (id: string) => db.prepare("SELECT wake_key,reason FROM conversation_wakeups WHERE conversation_id=? AND status='pending' ORDER BY created_at").all(id) as { wake_key: string; reason: string }[];
  const bot = () => ({ user, conversationId: OWNER });
  const inLane = (laneId: string) => ({ user, conversationId: OWNER, executionConversationId: laneId });
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(db, migrations);
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'nick@example.test','Nick','owner'),(2,'ali@example.test','Ali','member')").run();
    db.prepare('INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,1)').run(TEAM, 'ERVP');
    for (const [id, name] of [[OWNER, 'Clara'], [OTHER, 'Finn']] as const) {
      db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,?,'codex',?,'team',?)").run(id, name, `native-${id}`, TEAM);
      db.prepare('INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,?,1)').run(id, name);
    }
    user = db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
    tasks = createTaskService(db);
  });
  afterEach(() => db.close());

  it('splits a dump into tasks, matches repeats, starts two and queues the rest with a visible reason', () => {
    const r = tasks.intake(bot(), { items: [
      { title: 'Chargeback 4521 for Dean Marsh', case_key: 'cb-4521', brief: 'Dispute the $191.77 chargeback.' },
      { title: 'Chargeback 4530 for Pat Rivera', case_key: 'cb-4530' },
      { title: 'Chargeback 4533 for Lee Park', case_key: 'cb-4533' },
    ], source: 'human_dump' });
    expect(r.summary).toBe('3 tasks: 3 new, 0 matched; 2 started, 1 queued');
    expect(r.created.map((t) => t.status)).toEqual(['working', 'working', 'up_next']);
    expect(r.created[2]!.status_line).toContain(`already working ${TASK_CAP_PER_OWNER} tasks`);
    // Every task has its own chat, a lane of the owner, visible where the owner is and never a human send target.
    for (const t of r.created) {
      expect(coordinationLane(db, t.task_conversation_id!)?.owner_id).toBe(OWNER);
      expect(canViewConversation(user, conv(t.task_conversation_id!), db)).toBe(true);
      expect(canSendToConversation(user, conv(t.task_conversation_id!), db)).toBe(false);
      expect(tasks.taskOfLane(t.task_conversation_id!)?.id).toBe(t.id);
    }
    // Start wakes are scheduled on the owner and run in the task chat.
    const starts = pendingWakes(OWNER).filter((w) => w.wake_key.includes(':start:'));
    expect(starts).toHaveLength(2);
    const firstStart = starts.find((w) => w.wake_key.startsWith(`bot-task:${r.created[0]!.id}:`))!;
    expect(wakeTarget(db, conv(OWNER), 'w', firstStart.wake_key).id).toBe(r.created[0]!.task_conversation_id);
    expect(firstStart.reason).toContain('Dispute the $191.77 chargeback');
    // A repeat of the same case adds direction instead of a second task; a near-identical title matches too.
    const again = tasks.intake(bot(), { items: [{ title: 'Dean Marsh chargeback again', case_key: 'cb-4521', brief: 'He sent the receipt.' }, { title: 'chargeback 4530 for pat rivera' }] });
    expect(again.summary).toBe('2 tasks: 0 new, 2 matched; 0 started, 1 queued');
    expect(db.prepare('SELECT COUNT(*) AS n FROM bot_tasks').get()).toEqual({ n: 3 });
    expect(pendingWakes(OWNER).some((w) => w.wake_key.includes(':direction:') && w.reason.includes('He sent the receipt'))).toBe(true);
    // Another bot's tasks never match or count against this owner.
    const finn = tasks.intake({ user, conversationId: OTHER }, { items: [{ title: 'Chargeback 4521 for Dean Marsh', case_key: 'cb-4521' }] });
    expect(finn.summary).toBe('1 task: 1 new, 0 matched; 1 started, 0 queued');
  });

  it('queues a task behind a shared resource another task holds, and starts it when the holder finishes', () => {
    const first = tasks.create(bot(), { title: 'Return RMA 77 math', case_key: 'rma-77', resources: ['case_lease:orderops:finn'] });
    const second = tasks.create(bot(), { title: 'Return RMA 78 math', case_key: 'rma-78', resources: ['case_lease:orderops:finn'] });
    expect(first.task.status).toBe('working');
    expect(second.task.status).toBe('up_next');
    expect(second.task.status_line).toBe('Queued: waiting for case_lease:orderops:finn (held by task Return RMA 77 math)');
    const done = tasks.setStatus(inLane(first.task.task_conversation_id!), { status: 'done', status_line: 'Math delivered', completion: { verified_by_readback: true, readback: 'RMA 77 shows refund math attached', unknown_effects: false } });
    expect(done.closed).toBe(true);
    expect(done.task.closed_by).toBe('auto');
    expect(tasks.read(second.task.id)!.status).toBe('working');
  });

  it('refuses to close a task without verified completion, with an open question, or with an UNKNOWN effect', () => {
    const t = tasks.create(bot(), { title: 'Refund the cracked skylight', case_key: 'order-4521' });
    const lane = t.task.task_conversation_id!;
    const noProof = tasks.setStatus(inLane(lane), { status: 'done', status_line: 'Refund sent' });
    expect(noProof.closed).toBe(false);
    expect(noProof.task.status).toBe('ready_for_review');
    expect(noProof.not_closed_because).toContain('verified_by_readback');
    const unknown = tasks.setStatus(inLane(lane), { status: 'done', status_line: 'Refund sent', completion: { verified_by_readback: true, readback: 'Shopify refund r1', unknown_effects: true } });
    expect(unknown.task.status).toBe('ready_for_review');
    expect(unknown.not_closed_because).toContain('UNKNOWN');
    // A question raised from the task chat binds to the task and parks it; the answer wakes the task chat.
    const bots = createBotService(db);
    const d = bots.raise(bot(), { source_key: 'order-4521', proposal_key: 'refund', proposal: proposalSchema.parse({
      question: 'Refund the skylight line?', recommendation: 'Yes.', consequence: 'Refunds $191.77.', assignee_id: 1, blocked_action: 'Refund',
      choices: [{ id: 'yes', label: 'Refund $191.77', description: 'Matches the claim', action: 'approve', recommended: true }, { id: 'no', label: 'Decline the refund', description: 'Keep the charge', action: 'reject' }],
    }) });
    expect(tasks.linkDecision(d.id, lane)?.id).toBe(t.task.id);
    expect(tasks.read(t.task.id)).toMatchObject({ status: 'needs_input' });
    expect(tasks.read(t.task.id)!.status_line).toContain('Refund the skylight line?');
    const withCard = tasks.setStatus(inLane(lane), { status: 'done', status_line: 'Refund sent', completion: { verified_by_readback: true, readback: 'r1', unknown_effects: false } });
    expect(withCard.task.status).toBe('needs_input');
    expect(withCard.not_closed_because).toContain('question');
    bots.choose({ user }, d.id, 1, 'k1', 'yes', '', 'this_case');
    tasks.decisionAnswered(d.id);
    expect(tasks.read(t.task.id)!.status).toBe('working');
    const answer = pendingWakes(OWNER).find((w) => w.wake_key.startsWith('bot-decision:'))!;
    expect(wakeTarget(db, conv(OWNER), 'w', answer.wake_key).id).toBe(lane);
    expect(tasks.contextBlock(lane)).toContain('"Refund the cracked skylight"');
    expect(tasks.laneRules(lane)).toContain('own task chat');
    expect(tasks.laneRules(OWNER)).toBeNull();
  });

  it('records human discussion and marks, and asks working tasks to reconcile after a restart', () => {
    const t = tasks.create(bot(), { title: 'Five returns math', brief: 'Bring me the math on each.' });
    const lane = t.task.task_conversation_id!;
    const d = tasks.discuss({ user }, t.task.id, { text: 'Use the restocking fee table from last month.', request_key: 'r1' });
    expect(d.duplicate).toBe(false);
    expect(tasks.discuss({ user }, t.task.id, { text: 'Use the restocking fee table from last month.', request_key: 'r1' }).duplicate).toBe(true);
    const wake = pendingWakes(OWNER).find((w) => w.wake_key === `bot-task:${t.task.id}:discuss:${d.event_id}`)!;
    expect(wake.reason).toContain('Nick wrote on task');
    const withFile = tasks.discuss({ user }, t.task.id, { text: 'Here is the invoice.', request_key: 'r3', attachments: [{ name: 'invoice.pdf', reference: '/data/uploads/ab12/invoice.pdf' }] });
    expect(pendingWakes(OWNER).find((w) => w.wake_key === `bot-task:${t.task.id}:discuss:${withFile.event_id}`)!.reason).toContain('- /data/uploads/ab12/invoice.pdf (invoice.pdf)');
    expect(tasks.events(t.task.id).find((e) => e.id === withFile.event_id)!.payload).toMatchObject({ attachments: [{ name: 'invoice.pdf' }] });
    expect(tasks.contextBlock(lane)).toContain('discussion from Nick: Use the restocking fee table');
    const ali = db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow;
    expect(() => tasks.discuss({ user: ali }, t.task.id, { text: 'x', request_key: 'r2' })).toThrow(/not found/);
    // Restart: the working task is asked to reconcile once per boot, never retried blindly.
    expect(tasks.reconcileAfterRestart('boot-1')).toBe(1);
    expect(tasks.reconcileAfterRestart('boot-1')).toBe(0);
    expect(tasks.read(t.task.id)!.status_line).toBe('Reconciling after a restart');
    expect(pendingWakes(OWNER).find((w) => w.wake_key === `bot-task:${t.task.id}:reconcile:boot-1`)!.reason).toContain('UNKNOWN-outcome rules');
    // Human close is the final say.
    expect(tasks.mark({ user }, OWNER, { kind: 'task', id: t.task.id, mark: 'done' })).toMatchObject({ task: { status: 'done', closed_by: 'human' } });
    expect(tasks.mark({ user }, OWNER, { kind: 'thread', id: 'thread-1', mark: 'done' })).toEqual({ kind: 'thread', id: 'thread-1', mark: 'done' });
    expect(tasks.marks(OWNER).get('thread:thread-1')?.mark).toBe('done');
  });

  describe('board and tools over HTTP', () => {
    let server: Server, url: string;
    const laneStatus = new Map<string, 'working' | 'needs_you' | 'idle' | 'failed'>();
    beforeEach(async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const bot = String(req.headers['x-test-bot'] ?? ''); const execution = String(req.headers['x-test-execution'] ?? '');
        req.user = bot ? { ...user, botSession: true } as UserRow : user;
        if (bot) req.agentConversationId = bot;
        if (execution) req.agentExecutionConversationId = execution;
        next();
      });
      app.use('/api', createTasksRouter({ db, manager: { statusOf: async (id: string) => laneStatus.get(id) ?? 'idle' } } as unknown as AppContext));
      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => { await new Promise((resolve) => server.close(resolve)); });
    const callApi = (headers: Record<string, string>) => async (path: string, init?: RequestInit) => {
      const res = await fetch(url + path, { ...init, headers: { 'Content-Type': 'application/json', ...headers } });
      return (await res.json()) as Record<string, unknown>;
    };
    it('serves the tools to the bot and the grouped board with counts to the human', async () => {
      expect(BOT_TOOL_DEFINITIONS.map((t) => t.name)).toEqual(expect.arrayContaining(['create_task', 'intake_tasks', 'set_task_status']));
      const intake = await callBotTool({ name: 'intake_tasks', args: { items: [{ title: 'Chargeback 4521', case_key: 'cb-4521' }, { title: 'Chargeback 4530', case_key: 'cb-4530' }, { title: 'Chargeback 4533', case_key: 'cb-4533' }] }, callApi: callApi({ 'x-test-bot': OWNER }) });
      const payload = JSON.parse(intake!.content[0]!.text) as { summary: string; created: { id: string; task_conversation_id: string }[] };
      expect(payload.summary).toBe('3 tasks: 3 new, 0 matched; 2 started, 1 queued');
      const status = await callBotTool({ name: 'set_task_status', args: { status: 'ready_for_review', status_line: 'Evidence packet is ready for you to check.' }, callApi: callApi({ 'x-test-bot': OWNER, 'x-test-execution': payload.created[0]!.task_conversation_id }) });
      expect(JSON.parse(status!.content[0]!.text)).toMatchObject({ task: { status: 'ready_for_review' } });
      expect(JSON.parse((await callBotTool({ name: 'create_task', args: { title: 'x' }, callApi: callApi({ 'x-test-bot': 'nope' }) }))!.content[0]!.text)).toMatchObject({ error: expect.stringContaining('registered bot') });
      // Human board: another bot's chat handed off by this one shows up as a handoff row; marks move it to Completed.
      db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id,origin_conversation_id) VALUES('h1',1,1,'Vendor quote','claude','n-h1','team',?,?)").run(TEAM, OWNER);
      const board = await callApi({})(`/api/conversations/${OWNER}/tasks`) as unknown as { counts: Record<string, number>; needs_you: number; rows: { kind: string; group: string; title: string }[]; chat: { bot_name: string; registered: boolean } };
      expect(board.chat).toMatchObject({ bot_name: 'Clara', registered: true });
      expect(board.counts).toMatchObject({ ready_for_review: 1, needs_input: 0, working: 2, up_next: 0, completed: 1 }); // the review freed a slot, so the queued chargeback started; a finished handoff is Completed, never review work
      expect(board.needs_you).toBe(1);
      expect(board.rows.find((r) => r.kind === 'handoff')).toMatchObject({ title: 'Vendor quote', group: 'completed' });
      laneStatus.set('h1', 'needs_you');
      const after = await callApi({})(`/api/conversations/${OWNER}/tasks`) as unknown as { counts: Record<string, number>; rows: { kind: string; group: string }[] };
      expect(after.rows.find((r) => r.kind === 'handoff')).toMatchObject({ group: 'needs_input' });
      laneStatus.delete('h1');
      expect(await callApi({ 'x-test-bot': OWNER })(`/api/conversations/${OWNER}/tasks`)).toMatchObject({ error: expect.stringContaining('human') });
      // Finished bot-to-bot automation never counts as review work: 400 idle trigger threads add nothing to Active, a stuck one shows once.
      const insertConv = db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id,channel) VALUES(?,1,1,?,'claude',?,'team',?,'automation')");
      const insertThread = db.prepare('INSERT INTO coordination_threads(id,left_id,right_id) VALUES(?,?,?)');
      const insertLane = db.prepare('INSERT INTO coordination_lanes(conversation_id,thread_id,owner_id) VALUES(?,?,?)');
      for (let i = 0; i < 400; i++) {
        insertConv.run(`trig-${i}`, `CS · Half-hour queue trigger — run ${i}`, `n-trig-${i}`, TEAM);
        const [left, right] = [OWNER, `trig-${i}`].sort();
        insertThread.run(`thread-${i}`, left, right);
        db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,'Bot coordination','claude',?,'private',?)").run(`lane-${i}`, `n-lane-${i}`, TEAM);
        insertLane.run(`lane-${i}`, `thread-${i}`, OWNER);
      }
      laneStatus.set('lane-7', 'needs_you');
      const noisy = await callApi({})(`/api/conversations/${OWNER}/tasks`) as unknown as { counts: Record<string, number>; needs_you: number; rows: { kind: string; group: string; title: string; tag: string }[] };
      const threadRows = noisy.rows.filter((r) => r.kind === 'thread');
      expect(threadRows.filter((r) => r.group !== 'completed')).toEqual([expect.objectContaining({ group: 'needs_input', title: 'CS · Half-hour queue trigger — run 7', tag: 'automation' })]);
      expect(threadRows.filter((r) => r.group === 'completed').length).toBeLessThanOrEqual(20);
      expect(noisy.counts.ready_for_review).toBe(1); // only the task the bot flagged for review
      expect(noisy.needs_you).toBe(2);
      expect(noisy.rows.some((r) => r.title.includes('Assistant ↔ Assistant'))).toBe(false);
      const discuss = await callApi({})(`/api/conversations/${OWNER}/tasks/${payload.created[0]!.id}/discuss`, { method: 'POST', body: JSON.stringify({ text: 'Looks good, send it.', request_key: 'd1' }) });
      expect(discuss).toMatchObject({ duplicate: false });
      // The pane's one line: reading the note while it waits, replying while the task chat works,
      // and naming what holds it when two other tasks are working.
      const first = payload.created[0]!;
      const activity = async () => ((await callApi({})(`/api/conversations/${OWNER}/tasks/${first.id}`)) as { activity: unknown }).activity;
      expect(await activity()).toEqual({ state: 'waiting' });
      laneStatus.set(first.task_conversation_id, 'working');
      expect(await activity()).toEqual({ state: 'working' });
      laneStatus.delete(first.task_conversation_id);
      for (const t of payload.created.slice(1)) laneStatus.set(t.task_conversation_id, 'working');
      expect(await activity()).toEqual({ state: 'waiting', reason: 'tasks', others: 2 });
      db.prepare("UPDATE conversation_wakeups SET status='delivered' WHERE wake_key LIKE ?").run(`bot-task:${first.id}:%`);
      expect(await activity()).toEqual({ state: 'idle' });
    });
  });
});
