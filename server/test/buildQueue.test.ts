import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { ConversationRow } from '../src/db/db.js';
import { createBuildQueueCoordinator, type BuildQueueCoordinator } from '../src/buildQueue/coordinator.js';
import { PLATFORM_DEV_VALIDATION_GUIDANCE } from '../src/buildQueue/guidance.js';
import type { ConversationEvent, ConversationStatus, MessageOrigin } from '../src/runtime/events.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  db.prepare(
    "INSERT INTO projects (id, slug, name, instructions) VALUES ('project-a', 'alpha', 'Alpha', ''), ('project-b', 'beta', 'Beta', '')",
  ).run();
  const platformDev = db.prepare("SELECT id FROM assistants WHERE slug = 'platform-dev'").get() as { id: number };
  const assistant = db.prepare("SELECT id FROM assistants WHERE slug = 'assistant'").get() as { id: number };
  const insert = db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES (?, ?, 1, ?, 'claude', ?, 'web')`,
  );
  insert.run('build-1', platformDev.id, 'Build one', 'sid-1');
  insert.run('build-2', platformDev.id, 'Build two', 'sid-2');
  insert.run('ordinary', assistant.id, 'Ordinary', 'sid-3');
  const insertProject = db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, project_id, title, provider, native_session_id, channel)
     VALUES (?, ?, 1, ?, ?, 'claude', ?, 'web')`,
  );
  insertProject.run('project-a-1', assistant.id, 'project-a', 'Alpha one', 'sid-a1');
  insertProject.run('project-a-2', assistant.id, 'project-a', 'Alpha two', 'sid-a2');
  insertProject.run('project-b-1', assistant.id, 'project-b', 'Beta one', 'sid-b1');
  insertProject.run('project-platform', platformDev.id, 'project-a', 'Filed Platform Dev', 'sid-pd');
  return db;
}

function fakeManager(db: Database.Database) {
  const bus = new EventEmitter();
  const live = new Set<string>();
  const sent: { conversationId: string; text: string; origin?: MessageOrigin }[] = [];
  return {
    bus,
    live,
    sent,
    dispatchBuild(conv:ConversationRow,text:string,actorUserId:number,origin:MessageOrigin){this.postMessage(conv,text,actorUserId,origin);},
    postMessage(conv: ConversationRow, text: string, _actorUserId?: number, origin?: MessageOrigin) {
      sent.push({ conversationId: conv.id, text, ...(origin ? { origin } : {}) });
      live.add(conv.id);
      // Mirror the real manager: a chat that already has a turn in flight gets
      // the text queued behind it rather than a second pending turn.
      const pending = db
        .prepare('SELECT 1 FROM pending_turns WHERE conversation_id = ?')
        .get(conv.id);
      if (pending) {
        db.prepare('INSERT INTO queued_messages (conversation_id, prompt) VALUES (?, ?)').run(conv.id, text);
        return;
      }
      db.prepare('INSERT INTO pending_turns (conversation_id, prompt,origin_json) VALUES (?, ?,?)').run(conv.id,text,JSON.stringify(origin));
    },
    isLive(conversationId: string) {
      return live.has(conversationId);
    },
    queueSnapshot(conversationId: string) {
      return {
        messages: db
          .prepare('SELECT id FROM queued_messages WHERE conversation_id = ? ORDER BY sort_order, id')
          .all(conversationId),
      };
    },
    event(conversationId: string, event: ConversationEvent) {
      const d=db.prepare("SELECT d.* FROM build_dispatches d JOIN build_queue b ON b.dispatch_id=d.id WHERE b.conversation_id=? AND b.status='running'").get(conversationId) as {id:string;current_turn_id:string|null}|undefined;
      if(d && (event.type==='turn_done'||event.type==='error')){
        const turnId=d.current_turn_id??`fixture-${d.id}`;
        if(!d.current_turn_id){
          const origin={kind:'build_queue' as const,from:'Build queue',to:'platform-dev',buildDispatchId:d.id};
          db.prepare('INSERT INTO turn_origins(conversation_id,turn_id,prompt_text,event_at,origin_json) VALUES(?,?,?,?,?)').run(conversationId,turnId,'fixture',new Date().toISOString(),JSON.stringify(origin));
          bus.emit('event',conversationId,{type:'turn_started',turnId,role:'user',text:'fixture',at:new Date().toISOString(),origin});
        }
        event={...event,turnId};
      }
      bus.emit('event', conversationId, event);
    },
    status(conversationId: string, status: ConversationStatus) {
      if (status !== 'working' && status !== 'needs_you') live.delete(conversationId);
      bus.emit('status', conversationId, status);
    },
  };
}

describe('Platform Dev build queue', () => {
  let db: Database.Database;
  let coordinator: BuildQueueCoordinator | null;

  beforeEach(() => {
    db = openTestDb();
    coordinator = null;
  });

  afterEach(() => {
    coordinator?.stop();
    db.close();
  });

  it('preserves the requester at dispatch and refuses revoked access or cross-actor merges', () => {
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(2,'trainer@example.com','Trainer','member')").run();
    db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('training','Training',1)").run();
    db.prepare("INSERT INTO business_team_members(team_id,user_id,role) VALUES('training',2,'member')").run();
    db.prepare("UPDATE conversations SET business_team_id='training' WHERE id LIKE 'project-a-%'").run();
    for (const id of ['project-a-1','project-a-2']) {
      db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by,active) VALUES(?,?,1,1)").run(id,id);
      db.prepare("INSERT INTO business_bot_members(conversation_id,team_id,role) VALUES(?,'training','bot')").run(id);
    }
    const manager = fakeManager(db);
    const post = vi.spyOn(manager,'postMessage');
    manager.live.add('project-a-1');
    coordinator = createBuildQueueCoordinator({db,manager});
    const queued = coordinator.enqueue('project-a-1','Training','Correction',2);
    expect(queued).toMatchObject({ok:true,job:{user_id:2}});
    expect(coordinator.enqueue('project-a-1','Other actor','Do not merge',1)).toMatchObject({disposition:'existing',job:{brief:'Correction'}});
    manager.live.delete('project-a-1');
    coordinator.tick();
    expect(post.mock.calls[0]?.[2]).toBe(2);
    manager.live.add('project-a-2');
    const revoked = coordinator.enqueue('project-a-2','Training','Correction',2);
    expect(revoked.ok).toBe(true);
    db.prepare("UPDATE build_queue SET status='done' WHERE conversation_id='project-a-1'").run();
    db.prepare("DELETE FROM business_team_members WHERE user_id=2").run();
    manager.live.delete('project-a-2');
    coordinator.tick();
    expect(post).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status FROM build_queue WHERE conversation_id='project-a-2'").get()).toEqual({status:'failed'});
  });

  it('waits for the enqueueing planning turn, then dispatches FIFO one at a time', () => {
    const manager = fakeManager(db);
    manager.live.add('build-1');
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });

    const first = coordinator.enqueue('build-1', 'First feature', 'Implement the first feature.');
    const second = coordinator.enqueue('build-2', 'Second feature', 'Implement the second feature.');
    expect(first).toMatchObject({ ok: true, position: 1 });
    expect(second).toMatchObject({ ok: true, position: 2 });
    expect(manager.sent).toEqual([]);

    manager.status('build-1', 'idle');
    expect(manager.sent).toHaveLength(1);
    expect(manager.sent[0]).toMatchObject({ conversationId: 'build-1' });
    expect(manager.sent[0]!.text).toContain('Implement the first feature.');
    expect(manager.sent[0]!.text).toContain('Use any implementation plan prepared in the preceding queue turn');
    expect(manager.sent[0]!.text).toContain('Briefly refresh the relevant source');
    expect(manager.sent[0]!.text).toContain(PLATFORM_DEV_VALIDATION_GUIDANCE);
    expect(manager.sent[0]!.origin).toMatchObject({
      kind: 'build_queue',
      from: 'Build queue',
      to: 'platform-dev',
    });
    expect(db.prepare("SELECT title FROM build_queue WHERE status = 'running'").get()).toMatchObject({
      title: 'First feature',
    });

    manager.event('build-1', { type: 'turn_done', turnId: 'turn-1' });
    expect(manager.sent).toHaveLength(1); // the worker is still live until its idle status
    db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'build-1'").run();
    manager.status('build-1', 'idle');
    expect(manager.sent).toHaveLength(2);
    expect(manager.sent[1]).toMatchObject({ conversationId: 'build-2' });
    expect(db.prepare("SELECT status FROM build_queue WHERE title = 'First feature'").get()).toMatchObject({ status: 'done' });
  });

  it('records a plain user Stop as stopped instead of Blocked and keeps later work paused', () => {
    const manager = fakeManager(db);
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    const stopped = coordinator.enqueue('build-1', 'Paused feature', 'Build this when resumed.');
    coordinator.enqueue('build-2', 'Later feature', 'Do this afterward.');

    manager.event('build-1', {
      type: 'turn_done',
      turnId: 'turn-stopped',
      outcome: 'interrupted_by_user',
    });
    db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'build-1'").run();
    manager.status('build-1', 'idle');

    expect(db.prepare("SELECT status, error FROM build_queue WHERE conversation_id = 'build-1'").get()).toEqual({
      status: 'stopped',
      error: null,
    });
    expect(manager.sent.map((item) => item.conversationId)).toEqual(['build-1']);
    expect(coordinator.resolve(stopped.ok ? stopped.job.id : 0, 'retry')).toMatchObject({
      ok: true,
      job: { status: 'queued' },
    });
  });

  it('does not revive stopped builds for unrelated follow-ups; explicit retry is required',()=>{
    const manager=fakeManager(db);coordinator=createBuildQueueCoordinator({db,manager});
    const r=coordinator.enqueue('build-1','Fixture','Fixture');
    manager.event('build-1',{type:'turn_done',turnId:'stop',outcome:'interrupted_by_user'});
    manager.bus.emit('event','build-1',{type:'turn_started',turnId:'unrelated',role:'user',text:'Other work',at:new Date().toISOString()});
    manager.bus.emit('event','build-1',{type:'turn_done',turnId:'unrelated',outcome:'completed'});
    expect(db.prepare('SELECT status FROM build_queue').get()).toEqual({status:'stopped'});
    expect(coordinator.resolve(r.ok?r.job.id:0,'retry').ok).toBe(true);
  });

  it('requeues a failed turn once with the provider error, then pauses on a second failure', () => {
    const manager = fakeManager(db);
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    coordinator.enqueue('build-1', 'Broken feature', 'Exercise the provider failure path.');

    manager.event('build-1', { type: 'error', message: 'provider connection failed', fatal: true });
    manager.event('build-1', { type: 'error', message: 'secondary cleanup error', fatal: false });
    manager.event('build-1', { type: 'turn_done', turnId: 'turn-failed', outcome: 'failed' });

    expect(
      db.prepare("SELECT status, error, attempts FROM build_queue WHERE conversation_id = 'build-1'").get(),
    ).toEqual({
      status: 'queued',
      error: 'provider connection failed',
      attempts: 1,
    });

    db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'build-1'").run();
    manager.status('build-1', 'idle');
    expect(manager.sent).toHaveLength(2);
    expect(manager.sent[1]!.text).toContain(
      'A previous attempt at this build did not finish: provider connection failed',
    );
    expect(manager.sent[1]!.text).toContain('may contain partial changes');

    manager.event('build-1', { type: 'error', message: 'provider connection failed again', fatal: true });
    manager.event('build-1', { type: 'turn_done', turnId: 'turn-failed-2', outcome: 'failed' });
    expect(db.prepare("SELECT status, error FROM build_queue WHERE conversation_id = 'build-1'").get()).toEqual({
      status: 'failed',
      error: 'provider connection failed again',
    });
  });

  it('releases the queue when a turn recovers from an error and completes', () => {
    const manager = fakeManager(db);
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    coordinator.enqueue('build-1', 'Recovered feature', 'Survive a runner restart.');
    coordinator.enqueue('build-2', 'Later feature', 'Run after the recovered build.');

    manager.event('build-1', { type: 'error', message: 'Something went wrong', fatal: false });
    manager.event('build-1', { type: 'turn_done', turnId: 'turn-recovered', outcome: 'completed' });

    expect(db.prepare("SELECT status, error FROM build_queue WHERE conversation_id = 'build-1'").get()).toEqual({
      status: 'done',
      error: null,
    });
    db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'build-1'").run();
    manager.status('build-1', 'idle');
    expect(manager.sent.map((item) => item.conversationId)).toEqual(['build-1', 'build-2']);
  });

  it('retries a timed-out build once ahead of waiting work, then blocks the queue', () => {
    const manager = fakeManager(db);
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    coordinator.enqueue('build-1', 'Slow feature', 'Exercise the timeout path.');
    coordinator.enqueue('build-2', 'Waiting feature', 'Run after the slow one.');

    manager.event('build-1', { type: 'error', message: 'Turn timed out after 45 minutes and was stopped.', fatal: false });
    manager.event('build-1', { type: 'turn_done', turnId: 'turn-timeout', outcome: 'timed_out' });
    expect(
      db.prepare("SELECT status, error, attempts FROM build_queue WHERE conversation_id = 'build-1'").get(),
    ).toEqual({
      status: 'queued',
      error: 'Turn timed out after 45 minutes and was stopped.',
      attempts: 1,
    });

    // The retry keeps the head of the queue; waiting work must not jump it.
    db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'build-1'").run();
    manager.status('build-1', 'idle');
    expect(manager.sent.map((item) => item.conversationId)).toEqual(['build-1', 'build-1']);
    expect(manager.sent[1]!.text).toContain('Turn timed out after 45 minutes and was stopped.');

    manager.event('build-1', { type: 'turn_done', turnId: 'turn-timeout-2', outcome: 'timed_out' });
    expect(db.prepare("SELECT status FROM build_queue WHERE conversation_id = 'build-1'").get()).toEqual({
      status: 'failed',
    });
    db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'build-1'").run();
    manager.status('build-1', 'idle');
    expect(db.prepare("SELECT status FROM build_queue WHERE conversation_id = 'build-2'").get()).toEqual({
      status: 'queued',
    });
  });

  it('keeps one active slot per conversation and merges distinct waiting work', () => {
    const manager = fakeManager(db);
    manager.live.add('build-1');
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });

    const first = coordinator.enqueue('build-1', 'First feature', 'Implement the first feature.');
    const merged = coordinator.enqueue('build-1', 'Follow-up feature', 'Also implement the follow-up.');
    const retry = coordinator.enqueue('build-1', 'Follow-up feature', 'Also implement the follow-up.');

    expect(first).toMatchObject({ ok: true, position: 1, disposition: 'enqueued' });
    expect(merged).toMatchObject({ ok: true, position: 1, disposition: 'merged', job: { id: first.ok ? first.job.id : 0 } });
    expect(retry).toMatchObject({ ok: true, position: 1, disposition: 'existing' });
    expect(coordinator.list()).toHaveLength(1);
    expect(coordinator.list()[0]!.brief).toContain('Additional queued request: Follow-up feature');
    expect(coordinator.list()[0]!.brief.match(/Also implement the follow-up\./g)).toHaveLength(1);
    expect(() =>
      db.prepare("INSERT INTO build_queue (user_id, conversation_id, title, brief) VALUES (1, 'build-1', 'Duplicate', 'x')").run(),
    ).toThrow();
  });

  it('serializes one project while dispatching a different project concurrently', () => {
    const manager = fakeManager(db);
    manager.live.add('project-a-1');
    manager.live.add('project-a-2');
    manager.live.add('project-b-1');
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });

    expect(coordinator.enqueue('project-a-1', 'Alpha first', 'Build Alpha first.')).toMatchObject({
      ok: true,
      position: 1,
      job: { scope_key: 'project:project-a' },
    });
    expect(coordinator.enqueue('project-a-2', 'Alpha second', 'Build Alpha second.')).toMatchObject({
      ok: true,
      position: 2,
    });
    expect(coordinator.enqueue('project-b-1', 'Beta first', 'Build Beta first.')).toMatchObject({
      ok: true,
      position: 1,
      job: { scope_key: 'project:project-b' },
    });

    manager.status('project-b-1', 'idle');
    expect(manager.sent.map((item) => item.conversationId)).toEqual(['project-b-1']);
    manager.status('project-a-1', 'idle');
    expect(manager.sent.map((item) => item.conversationId)).toEqual(['project-b-1', 'project-a-1']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM build_queue WHERE status = 'running'").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT status FROM build_queue WHERE conversation_id = 'project-a-2'").get()).toEqual({
      status: 'queued',
    });
  });

  it('keeps a failed project from blocking another workspace', () => {
    const manager = fakeManager(db);
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    const alpha = coordinator.enqueue('project-a-1', 'Broken Alpha', 'Try Alpha.');
    coordinator.enqueue('project-a-2', 'Waiting Alpha', 'Wait in Alpha.');
    coordinator.enqueue('project-b-1', 'Healthy Beta', 'Run Beta.');

    manager.event('project-a-1', { type: 'error', message: 'alpha failed', fatal: true });
    manager.event('project-a-1', { type: 'turn_done', turnId: 'turn-alpha' });
    db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'project-a-1'").run();
    manager.status('project-a-1', 'failed');
    // First failure auto-retries; fail the retry too to exhaust the allowance.
    manager.event('project-a-1', { type: 'error', message: 'alpha failed again', fatal: true });
    manager.event('project-a-1', { type: 'turn_done', turnId: 'turn-alpha-2' });
    db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'project-a-1'").run();
    manager.status('project-a-1', 'failed');

    expect(db.prepare("SELECT status FROM build_queue WHERE conversation_id = 'project-a-1'").get()).toEqual({
      status: 'failed',
    });
    expect(db.prepare("SELECT status FROM build_queue WHERE conversation_id = 'project-b-1'").get()).toEqual({
      status: 'running',
    });
    expect(db.prepare("SELECT status FROM build_queue WHERE conversation_id = 'project-a-2'").get()).toEqual({
      status: 'queued',
    });
    expect(coordinator.resolve(alpha.ok ? alpha.job.id : 0, 'skip')).toMatchObject({ ok: true });
    expect(db.prepare("SELECT status FROM build_queue WHERE conversation_id = 'project-a-2'").get()).toEqual({
      status: 'running',
    });
  });

  it('pauses after an error and starts the next job only after the failed head is skipped', () => {
    const manager = fakeManager(db);
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    const first = coordinator.enqueue('build-1', 'Broken feature', 'Try the risky build.');
    coordinator.enqueue('build-2', 'Waiting feature', 'Build this second.');
    expect(first.ok).toBe(true);

    manager.event('build-1', { type: 'error', message: 'tests failed', fatal: true });
    manager.event('build-1', { type: 'turn_done', turnId: 'turn-1' });
    db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'build-1'").run();
    manager.status('build-1', 'failed');
    // The automatic retry redispatches the head, not the waiting job.
    expect(manager.sent.map((item) => item.conversationId)).toEqual(['build-1', 'build-1']);
    manager.event('build-1', { type: 'error', message: 'tests failed again', fatal: true });
    manager.event('build-1', { type: 'turn_done', turnId: 'turn-2' });
    db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'build-1'").run();
    manager.status('build-1', 'failed');
    // Third send is the failure notice: the chat would otherwise wait forever
    // on a queue wake that a blocked job never produces.
    expect(manager.sent).toHaveLength(3);
    expect(manager.sent[2]).toMatchObject({ conversationId: 'build-1' });
    expect(db.prepare("SELECT status, error FROM build_queue WHERE title = 'Broken feature'").get()).toMatchObject({
      status: 'failed',
      error: 'tests failed again',
    });

    const jobId = first.ok ? first.job.id : 0;
    expect(coordinator.resolve(jobId, 'skip')).toMatchObject({ ok: true, job: { status: 'skipped' } });
    expect(manager.sent).toHaveLength(4);
    expect(manager.sent[3]).toMatchObject({ conversationId: 'build-2' });
  });

  it('can retry a failed build in its original chat with a fresh retry allowance', () => {
    const manager = fakeManager(db);
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    const result = coordinator.enqueue('build-1', 'Retry me', 'Build it.');
    expect(result.ok).toBe(true);
    for (const turn of ['turn-1', 'turn-2']) {
      manager.event('build-1', { type: 'error', message: 'temporary failure', fatal: true });
      manager.event('build-1', { type: 'turn_done', turnId: turn });
      db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'build-1'").run();
      manager.status('build-1', 'failed');
    }
    expect(db.prepare("SELECT status FROM build_queue WHERE conversation_id = 'build-1'").get()).toEqual({
      status: 'failed',
    });

    const jobId = result.ok ? result.job.id : 0;
    expect(coordinator.resolve(jobId, 'retry')).toMatchObject({ ok: true, job: { status: 'queued', attempts: 0 } });
    // Two dispatches, then the failure notice, then the manual retry's dispatch.
    expect(manager.sent).toHaveLength(4);
    expect(manager.sent[3]).toMatchObject({ conversationId: 'build-1' });
  });

  it('revives a failed build when its conversation enqueues again', () => {
    const manager = fakeManager(db);
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    const first = coordinator.enqueue('build-1', 'Fragile feature', 'Build it.');
    expect(first.ok).toBe(true);
    for (const turn of ['turn-1', 'turn-2']) {
      manager.event('build-1', { type: 'error', message: 'boom', fatal: true });
      manager.event('build-1', { type: 'turn_done', turnId: turn });
      db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'build-1'").run();
      manager.status('build-1', 'failed');
    }
    expect(db.prepare("SELECT status FROM build_queue WHERE conversation_id = 'build-1'").get()).toEqual({
      status: 'failed',
    });

    manager.live.add('build-1');
    const revived = coordinator.enqueue('build-1', 'Fragile feature', 'Build it.');
    expect(revived).toMatchObject({
      ok: true,
      disposition: 'requeued',
      job: { id: first.ok ? first.job.id : 0, status: 'queued', error: null, attempts: 0 },
    });
    expect(coordinator.list()).toHaveLength(1);
  });

  it('revives a stopped build and merges new details into its brief', () => {
    const manager = fakeManager(db);
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    const first = coordinator.enqueue('build-1', 'Paused feature', 'Build this when resumed.');
    expect(first.ok).toBe(true);
    manager.event('build-1', { type: 'turn_done', turnId: 'turn-stopped', outcome: 'interrupted_by_user' });
    expect(db.prepare("SELECT status FROM build_queue WHERE conversation_id = 'build-1'").get()).toEqual({
      status: 'stopped',
    });

    manager.live.add('build-1');
    const revived = coordinator.enqueue('build-1', 'Extra bit', 'Also do the extra bit.');
    expect(revived).toMatchObject({ ok: true, disposition: 'requeued', job: { status: 'queued' } });
    expect(coordinator.list()).toHaveLength(1);
    expect(coordinator.list()[0]!.brief).toContain('Additional queued request: Extra bit');
  });

  it('accepts project agents and rejects an unfiled non-Platform-Dev conversation', () => {
    const manager = fakeManager(db);
    manager.live.add('project-a-1');
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    expect(coordinator.enqueue('project-a-1', 'Project build', 'Build it.')).toMatchObject({
      ok: true,
      position: 1,
      job: { scope_key: 'project:project-a' },
    });
    expect(coordinator.enqueue('ordinary', 'Nope', 'Do not run.')).toEqual({
      ok: false,
      error: 'not_queueable',
    });
  });

  it('uses the project queue for a project-filed Platform Dev chat', () => {
    const manager = fakeManager(db);
    manager.live.add('build-1');
    manager.live.add('project-platform');
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });

    expect(coordinator.enqueue('build-1', 'Source first', 'Build source first.')).toMatchObject({
      ok: true,
      position: 1,
      job: { scope_key: 'source' },
    });
    expect(coordinator.enqueue('project-platform', 'Project first', 'Build the project.')).toMatchObject({
      ok: true,
      position: 1,
      job: { scope_key: 'project:project-a' },
    });

    manager.status('project-platform', 'idle');
    expect(manager.sent.find((item) => item.conversationId === 'project-platform')?.text)
      .not.toContain(PLATFORM_DEV_VALIDATION_GUIDANCE);
  });

  it('marks a phantom running job failed at startup but preserves a resumable one', () => {
    const manager = fakeManager(db);
    db.prepare(
      "INSERT INTO build_queue (user_id, conversation_id, title, brief, status) VALUES (1, 'build-1', 'Phantom', 'x', 'running')",
    ).run();
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    coordinator.start();
    expect(db.prepare("SELECT status FROM build_queue WHERE title = 'Phantom'").get()).toMatchObject({ status: 'failed' });

    coordinator.stop();
    coordinator = null;
    db.prepare("UPDATE build_queue SET status = 'skipped' WHERE title = 'Phantom'").run();
    db.prepare(
      "INSERT INTO build_queue (user_id, conversation_id, title, brief, status) VALUES (1, 'build-2', 'Resumable', 'x', 'running')",
    ).run();
    db.prepare("INSERT INTO pending_turns (conversation_id, prompt) VALUES ('build-2', 'resume')").run();
    manager.live.add('build-2');
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    coordinator.start();
    expect(db.prepare("SELECT status FROM build_queue WHERE title = 'Resumable'").get()).toMatchObject({ status: 'running' });
  });

  it('tells the owning chat when its build is left blocked after a spent retry', () => {
    const manager = fakeManager(db);
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    coordinator.enqueue('build-1', 'Doomed feature', 'Fail twice.');

    manager.event('build-1', { type: 'error', message: 'first failure', fatal: true });
    manager.event('build-1', { type: 'turn_done', turnId: 'turn-1', outcome: 'failed' });
    db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'build-1'").run();
    manager.status('build-1', 'idle');
    manager.event('build-1', { type: 'error', message: 'second failure', fatal: true });
    manager.event('build-1', { type: 'turn_done', turnId: 'turn-2', outcome: 'failed' });

    const notice = manager.sent.at(-1)!;
    expect(notice.conversationId).toBe('build-1');
    expect(notice.text).toContain('second failure');
    expect(notice.text).toContain('paused at the head');
    expect(notice.text).toContain('resolve_build_queue');
  });

  it('notifies a phantom job at startup so its chat is not stranded', () => {
    const manager = fakeManager(db);
    db.prepare(
      "INSERT INTO build_queue (user_id, conversation_id, title, brief, status) VALUES (1, 'build-1', 'Phantom', 'x', 'running')",
    ).run();
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    coordinator.start();

    expect(manager.sent).toHaveLength(1);
    expect(manager.sent[0]).toMatchObject({ conversationId: 'build-1' });
    expect(manager.sent[0]!.text).toContain('Runner stopped before the queued build was recorded');
  });

  it('keeps dispatching other workspaces when a chat cannot be reached at all', () => {
    const manager = fakeManager(db);
    const unreachable = 'build-1';
    const realPost = manager.postMessage.bind(manager);
    manager.postMessage = (conv: ConversationRow, text: string) => {
      // Both the dispatch and the follow-up failure notice blow up for this chat.
      if (conv.id === unreachable) throw new Error('conversation is unreachable');
      realPost(conv, text);
    };
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    coordinator.enqueue('build-1', 'Unreachable build', 'Dispatch throws.');
    coordinator.enqueue('project-a-1', 'Other workspace', 'Must still run.');

    expect(db.prepare("SELECT status, error FROM build_queue WHERE title = 'Unreachable build'").get()).toMatchObject({
      status: 'failed',
      error: 'conversation is unreachable',
    });
    // A throwing notification must not escape into the tick loop.
    expect(manager.sent.map((item) => item.conversationId)).toEqual(['project-a-1']);
  });

  it('does not post a failure notice when the chat is gone', () => {
    const manager = fakeManager(db);
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    coordinator.enqueue('build-1', 'Orphan feature', 'Lose the chat mid-build.');
    const dispatched = manager.sent.length;

    db.prepare("UPDATE conversations SET archived = 1 WHERE id = 'build-1'").run();
    manager.event('build-1', { type: 'error', message: 'first failure', fatal: true });
    manager.event('build-1', { type: 'turn_done', turnId: 'turn-1', outcome: 'failed' });
    db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'build-1'").run();
    manager.status('build-1', 'idle');
    manager.event('build-1', { type: 'error', message: 'second failure', fatal: true });
    manager.event('build-1', { type: 'turn_done', turnId: 'turn-2', outcome: 'failed' });

    expect(db.prepare("SELECT status FROM build_queue WHERE title = 'Orphan feature'").get()).toMatchObject({
      status: 'failed',
    });
    expect(manager.sent).toHaveLength(dispatched);
  });

  it('stays silent on a user Stop so the chat the user just stopped is not restarted', () => {
    const manager = fakeManager(db);
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    coordinator.enqueue('build-1', 'Stopped feature', 'The user hits Stop.');
    const dispatched = manager.sent.length;

    manager.event('build-1', { type: 'turn_done', turnId: 'turn-1', outcome: 'interrupted_by_user' });

    expect(db.prepare("SELECT status FROM build_queue WHERE title = 'Stopped feature'").get()).toMatchObject({
      status: 'stopped',
    });
    expect(manager.sent).toHaveLength(dispatched);
  });

  it('records nothing when a chat with a running build enqueues more work', () => {
    const manager = fakeManager(db);
    coordinator = createBuildQueueCoordinator({ db, manager, tickMs: 60_000 });
    coordinator.enqueue('build-1', 'Active build', 'The brief that is running.');
    db.prepare("DELETE FROM pending_turns WHERE conversation_id = 'build-1'").run();
    manager.status('build-1', 'idle');
    expect(db.prepare("SELECT status FROM build_queue WHERE title = 'Active build'").get()).toMatchObject({
      status: 'running',
    });

    const second = coordinator.enqueue('build-1', 'Follow-up build', 'Must not be silently swallowed.');
    expect(second).toMatchObject({ ok: true, disposition: 'existing' });
    // Refusing is deliberate: the running agent already holds its brief, so an
    // append would never reach it. The caller has to re-file after the build.
    const row = db.prepare("SELECT title, brief FROM build_queue WHERE conversation_id = 'build-1'").get() as {
      title: string;
      brief: string;
    };
    expect(row.title).toBe('Active build');
    expect(row.brief).not.toContain('Must not be silently swallowed');
    expect(db.prepare("SELECT COUNT(*) AS n FROM build_queue WHERE conversation_id = 'build-1'").get()).toMatchObject({
      n: 1,
    });
  });
});
