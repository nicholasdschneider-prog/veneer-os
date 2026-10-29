import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createTaskService } from '../src/tasks/service.js';
import { createTaskSourceSweep, RECHECKS_PER_HOUR, sourceLines, sourceStatusLine, SWEEP_EVERY_MS, type OrderOpsTicket } from '../src/tasks/sourceStatus.js';

const migrations = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const OWNER = '11111111-1111-4111-8111-111111111111', TEAM = 'team';

describe('live OrderOps status on tasks', () => {
  let db: Database.Database;
  let clock: number;
  let tickets: Record<string, OrderOpsTicket | Error>;
  let reads: string[];
  const tasks = () => createTaskService(db);
  const sweep = () => createTaskSourceSweep(db, { tasks: tasks(), now: () => clock, log: { warn: () => {} }, findConversation: async (code) => { reads.push(code); const t = tickets[code]; if (t instanceof Error) throw t; return t ?? null; } });
  const task = (id: string, over: { status?: string; case_key?: string; source?: string } = {}) => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,'task chat','codex',?,'private',?)").run(`lane-${id}`, `n-${id}`, TEAM);
    db.prepare("INSERT INTO bot_tasks(id,owner_conversation_id,title,status,status_line,case_key,source,task_conversation_id) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, OWNER, `Task ${id}`, over.status ?? 'ready_for_review', 'Inherited from Avery; Tess needs to confirm what is still open', over.case_key ?? id.toUpperCase().padEnd(6, 'X'), over.source ?? 'import', `lane-${id}`);
  };
  const row = (id: string) => db.prepare('SELECT status,status_line,closed_by FROM bot_tasks WHERE id=?').get(id) as { status: string; status_line: string; closed_by: string | null };
  const rechecks = () => (db.prepare("SELECT wake_key FROM conversation_wakeups WHERE wake_key LIKE 'bot-task:%:recheck'").all() as { wake_key: string }[]).map((w) => w.wake_key);
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(db, migrations);
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'nick@example.test','Nick','owner')").run();
    db.prepare('INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,1)').run(TEAM, 'ERVP');
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,'Tess','codex','n','team',?)").run(OWNER, TEAM);
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,'Tess',1)").run(OWNER);
    clock = Date.parse('2026-10-29T18:00:00Z');
    tickets = {}; reads = [];
  });
  afterEach(() => db.close());

  it('says the ticket status in one plain line', () => {
    const now = Date.parse('2026-10-29T18:00:00Z');
    expect(sourceStatusLine({ status: 'complete', closed_at: '2026-10-09T16:00:00Z', last_message_at: null, last_direction: null }, now)).toBe('OrderOps: closed Oct 9');
    expect(sourceStatusLine({ status: 'waiting_on_customer', closed_at: null, last_message_at: '2026-10-09T16:00:00Z', last_direction: 'outbound' }, now)).toBe('OrderOps: waiting on the customer since Oct 9');
    expect(sourceStatusLine({ status: 'waiting_on_us', closed_at: null, last_message_at: '2026-10-27T18:00:00Z', last_direction: 'inbound' }, now)).toBe('OrderOps: customer wrote 2 days ago, waiting on us');
    expect(sourceStatusLine({ status: 'waiting_on_us', closed_at: null, last_message_at: '2026-10-20T18:00:00Z', last_direction: 'outbound' }, now)).toBe('OrderOps: waiting on us since Oct 20');
    expect(sourceStatusLine({ status: 'new', closed_at: null, last_message_at: null, last_direction: null }, now)).toBe('OrderOps: new ticket, not answered yet');
  });

  it('closes a task whose ticket OrderOps shows complete, unless a question is open on it or the bot is working it', async () => {
    task('aaa111'); task('bbb222'); task('ccc333', { status: 'working' });
    for (const c of ['AAA111', 'BBB222', 'CCC333']) tickets[c] = { status: 'complete', closedAt: '2026-10-12T16:08:51Z' };
    db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id,task_id) VALUES('d1',?,'s','p','{}',1,'bbb222')").run(OWNER);
    const s = sweep();
    for (let i = 0; i < 3; i++) await s.tick(true);
    expect(row('aaa111')).toMatchObject({ status: 'done', status_line: 'Closed in OrderOps Oct 12', closed_by: 'auto' });
    expect(row('bbb222').status).toBe('ready_for_review');
    expect(row('ccc333').status).toBe('working');
    expect(sourceLines(db, ['aaa111', 'bbb222']).get('bbb222')).toBe('OrderOps: closed Oct 12');
    expect(tasks().events('aaa111', 10).find((e) => e.kind === 'status')?.payload).toMatchObject({ to: 'done', source: 'orderops' });
  });

  it('reads one ticket per interval, skips order numbers, keeps fresh statuses, and backs off when OrderOps is busy', async () => {
    task('aaa111'); task('ord1', { case_key: '100122604' }); task('bbb222');
    tickets.AAA111 = { status: 'waiting_on_us' }; tickets.BBB222 = new Error('OrderOps returned 429');
    const s = sweep();
    await s.tick(); await s.tick();
    expect(reads).toEqual(['AAA111']);
    clock += SWEEP_EVERY_MS; await s.tick();
    expect(reads).toEqual(['AAA111', 'BBB222']);
    clock += SWEEP_EVERY_MS; await s.tick(); // paused for a minute after the 429
    expect(reads).toHaveLength(2);
    tickets.BBB222 = { status: 'new' };
    clock += 60_000; await s.tick();
    expect(reads).toEqual(['AAA111', 'BBB222', 'BBB222']);
    clock += SWEEP_EVERY_MS; await s.tick(); // both fresh now, the order number is never read
    expect(reads).toHaveLength(3);
  });

  it('asks the bot once to re-check an inherited open task it never started, at most six an hour', async () => {
    for (let i = 0; i < 8; i++) { task(`t${i}abcd`); tickets[`T${i}ABCD`] = { status: 'waiting_on_us' }; }
    task('startd'); tickets.STARTD = { status: 'waiting_on_us' };
    db.prepare("INSERT INTO turn_origins(conversation_id,turn_id,prompt_text,event_at,origin_json) VALUES('lane-startd','x','p','2026-10-28','{}')").run();
    task('human1', { source: 'human_dump' }); tickets.HUMAN1 = { status: 'waiting_on_us' };
    const s = sweep();
    for (let i = 0; i < 10; i++) await s.tick(true);
    expect(rechecks()).toHaveLength(RECHECKS_PER_HOUR);
    expect(rechecks().some((k) => k.includes('startd') || k.includes('human1'))).toBe(false);
    clock += 3_600_000;
    for (let i = 0; i < 10; i++) await s.tick(true);
    expect(rechecks()).toHaveLength(8); // the remaining two, each task once
  });
});
