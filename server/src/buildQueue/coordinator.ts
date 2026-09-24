import { recoverBuild } from './recovery.js';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { BuildQueueRow, ConversationRow } from '../db/db.js';
import type { ConversationEvent, ConversationStatus, MessageOrigin } from '../runtime/events.js';
import { canManageConversation, canTrainBusinessBot } from '../conversations/access.js';
import { PLATFORM_DEV_VALIDATION_GUIDANCE } from './guidance.js';

interface QueueManager {
  bus: EventEmitter;
  dispatchBuild(conv: ConversationRow, text: string, actorUserId: number, origin: MessageOrigin): unknown;
  postMessage(conv: ConversationRow, text: string, actorUserId?: number, origin?: MessageOrigin): void;
  isLive(conversationId: string): boolean;
  queueSnapshot(conversationId: string): { messages: unknown[] };
}

export type EnqueueBuildResult =
  | { ok: true; job: BuildQueueRow; position: number; disposition: 'enqueued' | 'merged' | 'existing' | 'requeued' }
  | { ok: false; error: 'not_found' | 'not_queueable' };

export type ResolveBuildResult =
  | { ok: true; job: BuildQueueRow }
  | { ok: false; error: 'not_found' | 'invalid_status' };

export interface BuildQueueCoordinator {
  start(): void;
  stop(): void;
  tick(): void;
  enqueue(conversationId: string, title: string, brief: string, actorUserId?: number): EnqueueBuildResult;
  list(): BuildQueueRow[];
  recover(input:unknown, actorId:number, actorConversation:string|null): unknown;
  resolve(jobId: number, action: 'retry' | 'skip'): ResolveBuildResult;
}

const ACTIVE = "('queued','running','failed','stopped')";

export function createBuildQueueCoordinator({
  db,
  manager,
  tickMs = 15_000,
  log = console,
}: {
  db: Database.Database;
  manager: QueueManager;
  tickMs?: number;
  log?: Pick<Console, 'warn' | 'error'>;
}): BuildQueueCoordinator {
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;

  const conversation = db.prepare(
    `SELECT c.*, a.slug AS assistant_slug
     FROM conversations c JOIN assistants a ON a.id = c.assistant_id
     WHERE c.id = ? AND c.archived = 0`,
  );
  const jobById = db.prepare('SELECT * FROM build_queue WHERE id = ?');
  const dispatchableJobs = db.prepare(
    `SELECT candidate.*
     FROM build_queue candidate
     WHERE candidate.status = 'queued'
       AND candidate.id = (
         SELECT MIN(head.id) FROM build_queue head
         WHERE head.scope_key = candidate.scope_key AND head.status = 'queued'
       )
       AND NOT EXISTS (
         SELECT 1 FROM build_queue blocker
         WHERE blocker.scope_key = candidate.scope_key
           AND blocker.status IN ('running', 'failed', 'stopped')
       )
     ORDER BY candidate.id`,
  );
  const activeByConversation = db.prepare(
    `SELECT * FROM build_queue
     WHERE conversation_id = ? AND status IN ${ACTIVE}
     ORDER BY id LIMIT 1`,
  );
  const runningByConversation = db.prepare(
    "SELECT * FROM build_queue WHERE conversation_id = ? AND status = 'running' LIMIT 1",
  );

  function scopeFor(conv: ConversationRow & { assistant_slug: string }): string | null {
    if (conv.project_id) return `project:${conv.project_id}`;
    return conv.assistant_slug === 'platform-dev' ? 'source' : null;
  }

  function messageOriginFor(conv: ConversationRow & { assistant_slug: string }): MessageOrigin {
    return { kind: 'build_queue', from: 'Build queue', to: conv.assistant_slug };
  }

  function positionFor(job: BuildQueueRow): number {
    return (
      db.prepare(
        `SELECT COUNT(*) AS n FROM build_queue
         WHERE scope_key = ? AND status IN ${ACTIVE} AND id <= ?`,
      ).get(job.scope_key, job.id) as { n: number }
    ).n;
  }

  // A terminal job leaves its chat waiting on a queue wake that will never
  // arrive, and blocks its whole scope behind it. Tell the owner so someone can
  // resolve it. Never throws: the dispatch path calls this precisely because
  // postMessage already failed once, and an escape here would kill the tick
  // loop for every workspace.
  function notifyFailure(jobId: number, fallbackError: string): void {
    try {
      const job = jobById.get(jobId) as BuildQueueRow | undefined;
      if (!job) return;
      const conv = conversation.get(job.conversation_id) as
        | (ConversationRow & { assistant_slug: string })
        | undefined;
      // No chat left to tell; the job stays visible in the queue UI.
      if (!conv) return;
      const reason = job.error ?? fallbackError;
      manager.postMessage(
        conv,
        `[Build queue #${job.id}: ${job.title}]\n\n` +
          `This build stopped before it finished: ${reason}\n\n` +
          `It is now paused at the head of this workspace's queue, so no other build here can start until it is resolved. ` +
          `The checkout may contain partial changes from the attempt - review git status and the current state of the relevant files first, ` +
          `and do not repeat work that already landed. Then call resolve_build_queue with retry to run this build again, ` +
          `or skip to drop it and release the queue. Report what you found either way.`,
        conv.user_id,
        messageOriginFor(conv),
      );
    } catch (err) {
      log.error(`[build-queue] could not notify #${jobId} of its failure: ${(err as Error).message}`);
    }
  }

  function promptFor(job: BuildQueueRow, conv: ConversationRow & { assistant_slug: string }): string {
    const finish = job.scope_key === 'source' && conv.assistant_slug === 'platform-dev'
      ? `Complete the implementation, commit it, then validate and restart following the Platform Dev instructions. ${PLATFORM_DEV_VALIDATION_GUIDANCE}`
      : 'Complete the implementation, run appropriate validation, and follow the project instructions.';
    const recovery = job.error
      ? `A previous attempt at this build did not finish: ${job.error}. ` +
        `The checkout may contain partial changes from that attempt - review git status and the current state ` +
        `of the relevant files before continuing, and do not repeat work that already landed.\n\n`
      : '';
    return (
      `[Build queue #${job.id}: ${job.title}]\n\n` +
      `Your place in this workspace's build queue is up. Start building now.\n\n` +
      recovery +
      `${job.brief}\n\n` +
      `Use any implementation plan prepared in the preceding queue turn instead of repeating broad investigation. ` +
      `Briefly refresh the relevant source before editing because earlier queued work may have changed it, and adjust the plan as needed. ` +
      `If you delegate work to subagents, run them synchronously (run_in_background: false) and keep this turn alive until the build is fully complete - ` +
      `ending this turn releases this workspace's build lock, so background subagents would let the next queued build start on top of your unfinished work. ` +
      `${finish} ` +
      `Do not enqueue this job again.`
    );
  }

  function tick(): void {
    if (ticking) return;
    ticking = true;
    try {
      const candidates = dispatchableJobs.all() as BuildQueueRow[];
      for (const job of candidates) {
        // enqueue_build is called from inside the planning turn. A live head
        // waits, but must not prevent a different workspace from dispatching.
        if (manager.isLive(job.conversation_id)) continue;

        const conv = conversation.get(job.conversation_id) as
          | (ConversationRow & { assistant_slug: string })
          | undefined;
        if (!conv || scopeFor(conv) !== job.scope_key || !(canManageConversation({ id: job.user_id }, conv, db) || canTrainBusinessBot({ id: job.user_id }, conv, db))) {
          db.prepare(
            "UPDATE build_queue SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?",
          ).run('The originating chat or workspace is no longer available', job.id);
          continue;
        }

        db.prepare("DELETE FROM pending_turns WHERE conversation_id=? AND status='failed' AND json_extract(origin_json,'$.buildDispatchId') IN(SELECT id FROM build_dispatches WHERE job_id=?)").run(job.conversation_id,job.id);
        const claimed = db.prepare(
          `UPDATE build_queue
           SET status = 'running', started_at = datetime('now'), error = NULL
           WHERE id = ? AND status = 'queued'
             AND NOT EXISTS (
               SELECT 1 FROM build_queue blocker
               WHERE blocker.scope_key = ? AND blocker.status IN ('running', 'failed', 'stopped')
             )`,
        ).run(job.id, job.scope_key);
        if (claimed.changes === 0) continue;

        try {
          const dispatchId=crypto.randomUUID();
          db.transaction(()=>{
            db.prepare('INSERT INTO build_dispatches(id,job_id,conversation_id) VALUES(?,?,?)').run(dispatchId,job.id,conv.id);
            db.prepare('UPDATE build_queue SET dispatch_id=? WHERE id=?').run(dispatchId,job.id);
            db.prepare("INSERT INTO build_dispatch_audit(job_id,dispatch_id,kind,payload_json) VALUES(?,?,'dispatched','{}')").run(job.id,dispatchId);
          }).immediate();
          manager.dispatchBuild(conv, promptFor(job, conv), job.user_id, {...messageOriginFor(conv),buildDispatchId:dispatchId});
        } catch (err) {
          db.prepare(
            "UPDATE build_queue SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?",
          ).run((err as Error).message, job.id);
          log.error(`[build-queue] could not dispatch #${job.id}: ${(err as Error).message}`);
          notifyFailure(job.id, (err as Error).message);
        }
      }
    } catch (err) {
      log.error(`[build-queue] tick failed: ${(err as Error).message}`);
    } finally {
      ticking = false;
    }
  }

  // A failed or timed-out turn gets one automatic retry before the job pauses
  // its scope queue. The error is kept on the requeued row so the retry
  // dispatch can brief the agent on what broke; the claim clears it.
  function failOrRetry(jobId: number, fallbackError: string): void {
    const latest = jobById.get(jobId) as BuildQueueRow | undefined;
    if (!latest || latest.status !== 'running') return;
    if (latest.attempts < 1) {
      db.prepare(
        `UPDATE build_queue
         SET status = 'queued', attempts = attempts + 1, started_at = NULL, error = COALESCE(error, ?)
         WHERE id = ? AND status = 'running'`,
      ).run(fallbackError, jobId);
      return;
    }
    const failed = db.prepare(
      `UPDATE build_queue
       SET status = 'failed', error = COALESCE(error, ?), finished_at = datetime('now')
       WHERE id = ? AND status = 'running'`,
    ).run(fallbackError, jobId);
    if (failed.changes > 0) notifyFailure(jobId, fallbackError);
  }

  function onEvent(conversationId: string, event: ConversationEvent): void {
    if (event.type === 'turn_started') {
      const dispatchId=event.origin?.buildDispatchId;
      if (!dispatchId) return;
      db.transaction(()=>{
        const matched=db.prepare("SELECT b.id FROM build_queue b JOIN build_dispatches d ON d.id=b.dispatch_id WHERE d.id=? AND b.conversation_id=? AND b.status='running'").get(dispatchId,conversationId) as {id:number}|undefined;
        if(!matched)return;
        // Event origin is emitted by the manager and persisted before this callback.
        const origin=db.prepare("SELECT id FROM turn_origins WHERE conversation_id=? AND turn_id=? AND json_extract(origin_json,'$.buildDispatchId')=?").get(conversationId,event.turnId,dispatchId);
        if(!origin)return;
        const originId=(origin as {id:number}).id;
        const bound=db.prepare('SELECT current_origin_id FROM build_dispatches WHERE id=?').get(dispatchId) as {current_origin_id:number|null};
        if(bound.current_origin_id!==null && bound.current_origin_id>=originId)return;
        db.prepare('UPDATE build_dispatches SET current_turn_id=?,current_origin_id=? WHERE id=?').run(event.turnId,originId,dispatchId);
        db.prepare("INSERT INTO build_dispatch_audit(job_id,dispatch_id,kind,turn_id,payload_json) VALUES(?,?,'turn_bound',?,'{}')").run(matched.id,dispatchId,event.turnId);
      }).immediate();
      return;
    }
    if(event.type==='error' && event.turnId){db.prepare("UPDATE build_queue SET error=COALESCE(error,?) WHERE status='running' AND conversation_id=? AND dispatch_id IN(SELECT id FROM build_dispatches WHERE current_turn_id=?)").run(event.message,conversationId,event.turnId);return;}
    if(event.type!=='turn_done')return; // diagnostics/status without turn identity never change a build
    const job=db.prepare("SELECT b.* FROM build_queue b JOIN build_dispatches d ON d.id=b.dispatch_id WHERE b.conversation_id=? AND b.status='running' AND d.current_turn_id=?").get(conversationId,event.turnId) as BuildQueueRow|undefined;
    if(!job)return;
    db.prepare("INSERT INTO build_dispatch_audit(job_id,dispatch_id,kind,turn_id,payload_json) SELECT id,dispatch_id,'turn_done',?,? FROM build_queue WHERE id=?").run(event.turnId,JSON.stringify({outcome:event.outcome??'completed'}),job.id);
    if (event.type !== 'turn_done') return;
    const latest = jobById.get(job.id) as BuildQueueRow;
    const outcome = event.outcome ?? (latest.error ? 'failed' : 'completed');
    if (outcome === 'interrupted_by_user') {
      db.prepare(
        `UPDATE build_queue
         SET status = 'stopped', error = NULL, finished_at = datetime('now')
         WHERE id = ? AND status = 'running'`,
      ).run(job.id);
      return;
    }
    if (outcome === 'timed_out' || outcome === 'failed') {
      failOrRetry(job.id, outcome === 'timed_out' ? 'Agent turn timed out' : 'Agent run failed');
      return;
    }
    // A provider can surface recoverable diagnostics before ultimately
    // completing the turn. The terminal outcome is authoritative: keep those
    // diagnostics in the transcript, but do not leave the workspace blocked.
    db.prepare(
      `UPDATE build_queue
       SET status = 'done', error = NULL, finished_at = datetime('now')
       WHERE id = ? AND status = 'running'`,
    ).run(job.id);
  }

  function onStatus(conversationId: string, status: ConversationStatus): void {
    if (status === 'idle' || status === 'failed') tick();
  }

  const serializedEvent = (id:string,event:ConversationEvent) => db.transaction(()=>onEvent(id,event)).immediate();
  manager.bus.on('event', serializedEvent);
  manager.bus.on('status', onStatus);

  return {
    start() {
      if (timer) return;
      // A running job with no resumable message/turn is a phantom left by a
      // crash in the tiny dispatch window. Pause visibly instead of duplicating it.
      const phantomFilter =
        `status = 'running'
           AND NOT EXISTS (SELECT 1 FROM pending_turns p WHERE p.conversation_id = build_queue.conversation_id AND p.status='pending' AND (build_queue.dispatch_id IS NULL OR json_extract(p.origin_json,'$.buildDispatchId')=build_queue.dispatch_id))
           AND NOT EXISTS (SELECT 1 FROM queued_messages q WHERE q.conversation_id = build_queue.conversation_id AND (build_queue.dispatch_id IS NULL OR json_extract(q.origin_json,'$.buildDispatchId')=build_queue.dispatch_id))`;
      // Capture the ids first; after the UPDATE they no longer match the filter.
      const phantoms = db.prepare(`SELECT id FROM build_queue WHERE ${phantomFilter}`).all() as { id: number }[];
      db.prepare(
        `UPDATE build_queue
         SET status = 'failed', error = COALESCE(error, 'Runner stopped before the queued build was recorded'),
             finished_at = datetime('now')
         WHERE ${phantomFilter}`,
      ).run();
      for (const phantom of phantoms) {
        notifyFailure(phantom.id, 'Runner stopped before the queued build was recorded');
      }
      tick();
      timer = setInterval(tick, tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      manager.bus.off('event', serializedEvent);
      manager.bus.off('status', onStatus);
    },
    tick,
    enqueue(conversationId, title, brief, actorUserId) {
      const conv = conversation.get(conversationId) as
        | (ConversationRow & { assistant_slug: string })
        | undefined;
      if (!conv) return { ok: false, error: 'not_found' };
      const actor = { id: actorUserId ?? conv.user_id };
      if (!(canManageConversation(actor, conv, db) || canTrainBusinessBot(actor, conv, db))) return { ok: false, error: 'not_found' };
      const scopeKey = scopeFor(conv);
      if (!scopeKey) return { ok: false, error: 'not_queueable' };

      const existing = activeByConversation.get(conv.id) as BuildQueueRow | undefined;
      if (existing) {
        // Never append a teammate's brief to a job that will run as another user.
        if (existing.user_id !== actor.id) return { ok: true, job: existing, position: positionFor(existing), disposition: 'existing' };
        // A failed/stopped job would otherwise deadlock: it blocks its scope,
        // yet its agent's turn is already dead. Re-enqueueing from the same
        // conversation revives it in place instead of refusing.
        // A running job deliberately refuses rather than merging: its agent
        // already holds the dispatched brief, so an append would never reach it
        // and would vanish when the job completes. The caller is told plainly
        // that nothing was recorded so it can re-file after this build ends.
        const revivable = existing.status === 'failed' || existing.status === 'stopped';
        let disposition: 'merged' | 'existing' | 'requeued' = revivable ? 'requeued' : 'existing';
        const addition = `\n\nAdditional queued request: ${title}\n\n${brief}`;
        if (
          (existing.status === 'queued' || revivable) &&
          !(existing.title === title && existing.brief === brief) &&
          !existing.brief.includes(addition)
        ) {
          db.prepare('UPDATE build_queue SET brief = brief || ? WHERE id = ?').run(addition, existing.id);
          if (!revivable) disposition = 'merged';
        }
        if (revivable) {
          db.prepare(
            `UPDATE build_queue
             SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL, attempts = 0
             WHERE id = ? AND status IN ('failed', 'stopped')`,
          ).run(existing.id);
          tick();
        }
        const job = jobById.get(existing.id) as BuildQueueRow;
        const position = positionFor(job);
        return { ok: true, job, position, disposition };
      }

      const info = db.prepare(
        `INSERT INTO build_queue (user_id, conversation_id, scope_key, title, brief)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(actor.id, conv.id, scopeKey, title, brief);
      const job = jobById.get(Number(info.lastInsertRowid)) as BuildQueueRow;
      const position = positionFor(job);
      tick();
      return { ok: true, job, position, disposition: 'enqueued' };
    },
    list() {
      return db.prepare(
        `SELECT * FROM build_queue
         WHERE status IN ${ACTIVE}
         ORDER BY scope_key, id`,
      ).all() as BuildQueueRow[];
    },
    recover(input, actorId, actorConversation) { const result=recoverBuild(db,input,actorId,actorConversation,id=>manager.isLive(id)); if((input as {mode?:string}).mode==='recover_done') tick(); return result; },
    resolve(jobId, action) {
      const job = jobById.get(jobId) as BuildQueueRow | undefined;
      if (!job) return { ok: false, error: 'not_found' };
      if (action === 'retry') {
        if (job.status !== 'failed' && job.status !== 'stopped') return { ok: false, error: 'invalid_status' };
        db.prepare(
          "UPDATE build_queue SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL, attempts = 0 WHERE id = ?",
        ).run(job.id);
      } else {
        if (job.status !== 'queued' && job.status !== 'failed' && job.status !== 'stopped') {
          return { ok: false, error: 'invalid_status' };
        }
        db.prepare(
          "UPDATE build_queue SET status = 'skipped', finished_at = datetime('now') WHERE id = ?",
        ).run(job.id);
      }
      const updated = jobById.get(job.id) as BuildQueueRow;
      tick();
      return { ok: true, job: updated };
    },
  };
}
