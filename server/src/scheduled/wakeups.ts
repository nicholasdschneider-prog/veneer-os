import crypto from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { ConversationRow, ConversationWakeupRow } from '../db/db.js';
import type { PostMessageResult } from '../runtime/conversationManager.js';

const PENDING = 'pending';

export interface WakeupManager {
  deliverWakeup(conv: ConversationRow, text: string, wakeupId: string, actorUserId?: number | null): PostMessageResult;
}

export interface ScheduleWakeupInput {
  conversationId: string;
  actorUserId: number;
  key: string;
  reason: string;
  scheduledFor: Date;
}

export type ScheduleWakeupResult =
  | { ok: true; wakeup: ConversationWakeupRow; replacedWakeupId: string | null }
  | { ok: false; error: 'conversation_not_found' | 'conversation_archived' | 'invalid_time' };

export type CancelWakeupResult =
  | { ok: true; wakeup: ConversationWakeupRow }
  | { ok: false; error: 'not_found' | 'not_pending' };

export type RescheduleWakeupResult =
  | { ok: true; wakeup: ConversationWakeupRow }
  | { ok: false; error: 'not_found' | 'not_pending' | 'invalid_time' };

export type FireWakeupResult =
  | { ok: true; wakeup: ConversationWakeupRow }
  | {
      ok: false;
      error: 'not_found' | 'not_pending' | 'conversation_not_found' | 'conversation_archived' | 'delivery_failed';
    };

export interface ConversationWakeupScheduler {
  start(): void;
  stop(): void;
  tick(): void;
  schedule(input: ScheduleWakeupInput): ScheduleWakeupResult;
  list(conversationId: string): ConversationWakeupRow[];
  listPending(conversationId: string): ConversationWakeupRow[];
  cancel(conversationId: string, wakeupId: string): CancelWakeupResult;
  reschedule(conversationId: string, wakeupId: string, scheduledFor: Date): RescheduleWakeupResult;
  fire(conversationId: string, wakeupId: string): FireWakeupResult;
}

/** Matches the route-level bounds so every entry point rejects the same times. */
const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;

export function wakeupPrompt(row: ConversationWakeupRow): string {
  return (
    'Hey, can you pick this back up for me?\n\n' +
    `${row.reason}\n\n` +
    'Please check what changed while you were away before you continue.'
  );
}

export function createConversationWakeupScheduler({
  db,
  manager,
  bus,
  tickMs = 2_000,
  now = () => new Date(),
  log = console,
}: {
  db: Database.Database;
  manager: WakeupManager;
  /** Optional so tests can drive the scheduler without a runtime bus. */
  bus?: Pick<EventEmitter, 'emit'>;
  tickMs?: number;
  now?: () => Date;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}): ConversationWakeupScheduler {
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;

  const conversationById = db.prepare('SELECT * FROM conversations WHERE id = ?');
  const wakeupById = db.prepare('SELECT * FROM conversation_wakeups WHERE id = ? AND conversation_id = ?');
  const pendingByKey = db.prepare(
    "SELECT * FROM conversation_wakeups WHERE conversation_id = ? AND wake_key = ? AND status = 'pending'",
  );

  function readWakeup(id: string, conversationId: string): ConversationWakeupRow {
    return wakeupById.get(id, conversationId) as ConversationWakeupRow;
  }

  function listPending(conversationId: string): ConversationWakeupRow[] {
    return db
      .prepare(
        `SELECT * FROM conversation_wakeups
         WHERE conversation_id = ? AND status = 'pending'
         ORDER BY scheduled_for, created_at
         LIMIT 100`,
      )
      .all(conversationId) as ConversationWakeupRow[];
  }

  /** Every mutation republishes the whole pending set: the UI needs no deltas. */
  function emitPending(conversationId: string): void {
    if (!bus) return;
    try {
      bus.emit('wakeups', conversationId, listPending(conversationId));
    } catch (err) {
      log.warn(`[wakeup] bus emit failed for ${conversationId}: ${(err as Error).message}`);
    }
  }

  function schedule(input: ScheduleWakeupInput): ScheduleWakeupResult {
    const conv = conversationById.get(input.conversationId) as ConversationRow | undefined;
    if (!conv) return { ok: false, error: 'conversation_not_found' };
    if (conv.archived) return { ok: false, error: 'conversation_archived' };
    if (!Number.isFinite(input.scheduledFor.getTime()) || input.scheduledFor.getTime() <= now().getTime()) {
      return { ok: false, error: 'invalid_time' };
    }

    const id = crypto.randomUUID();
    const scheduledFor = input.scheduledFor.toISOString();
    const result = db.transaction(() => {
      const existing = pendingByKey.get(input.conversationId, input.key) as ConversationWakeupRow | undefined;
      if (existing) {
        db.prepare(
          `UPDATE conversation_wakeups
           SET status = 'cancelled', cancelled_at = datetime('now')
           WHERE id = ? AND status = 'pending'`,
        ).run(existing.id);
      }
      db.prepare(
        `INSERT INTO conversation_wakeups
         (id, conversation_id, actor_user_id, wake_key, reason, scheduled_for)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, input.conversationId, input.actorUserId, input.key, input.reason, scheduledFor);
      return existing?.id ?? null;
    })();
    const wakeup = readWakeup(id, input.conversationId);
    log.info(
      `[wakeup] scheduled ${wakeup.id} conversation=${wakeup.conversation_id} key=${wakeup.wake_key} for=${wakeup.scheduled_for}` +
        (result ? ` replaced=${result}` : ''),
    );
    emitPending(input.conversationId);
    return { ok: true, wakeup, replacedWakeupId: result };
  }

  function list(conversationId: string): ConversationWakeupRow[] {
    return db
      .prepare(
        `SELECT * FROM conversation_wakeups
         WHERE conversation_id = ?
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, scheduled_for, created_at DESC
         LIMIT 100`,
      )
      .all(conversationId) as ConversationWakeupRow[];
  }

  function cancel(conversationId: string, wakeupId: string): CancelWakeupResult {
    const row = wakeupById.get(wakeupId, conversationId) as ConversationWakeupRow | undefined;
    if (!row) return { ok: false, error: 'not_found' };
    if (row.status !== PENDING) return { ok: false, error: 'not_pending' };
    const changed = db.prepare(
      `UPDATE conversation_wakeups
       SET status = 'cancelled', cancelled_at = datetime('now')
       WHERE id = ? AND conversation_id = ? AND status = 'pending'`,
    ).run(wakeupId, conversationId);
    if (changed.changes === 0) return { ok: false, error: 'not_pending' };
    const wakeup = readWakeup(wakeupId, conversationId);
    log.info(`[wakeup] cancelled ${wakeup.id} conversation=${wakeup.conversation_id}`);
    emitPending(conversationId);
    return { ok: true, wakeup };
  }

  function reschedule(conversationId: string, wakeupId: string, scheduledFor: Date): RescheduleWakeupResult {
    const row = wakeupById.get(wakeupId, conversationId) as ConversationWakeupRow | undefined;
    if (!row) return { ok: false, error: 'not_found' };
    if (row.status !== PENDING) return { ok: false, error: 'not_pending' };
    const delta = scheduledFor.getTime() - now().getTime();
    if (!Number.isFinite(scheduledFor.getTime()) || delta < MIN_DELAY_MS || delta > MAX_DELAY_MS) {
      return { ok: false, error: 'invalid_time' };
    }
    const changed = db
      .prepare(
        `UPDATE conversation_wakeups
         SET scheduled_for = ?
         WHERE id = ? AND conversation_id = ? AND status = 'pending'`,
      )
      .run(scheduledFor.toISOString(), wakeupId, conversationId);
    if (changed.changes === 0) return { ok: false, error: 'not_pending' };
    const wakeup = readWakeup(wakeupId, conversationId);
    log.info(`[wakeup] rescheduled ${wakeup.id} conversation=${wakeup.conversation_id} for=${wakeup.scheduled_for}`);
    emitPending(conversationId);
    return { ok: true, wakeup };
  }

  /**
   * Delivers one due/forced wake. Returns false when the row was left pending
   * on purpose (delivery threw) so the next tick can retry the same key.
   */
  function deliver(row: ConversationWakeupRow, conv: ConversationRow): boolean {
    const deliveredAt = now();
    try {
      const posted = manager.deliverWakeup(conv, wakeupPrompt(row), row.id, row.actor_user_id);
      db.prepare(
        `UPDATE conversation_wakeups
         SET status = 'delivered', delivered_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(deliveredAt.toISOString(), row.id);
      log.info(
        `[wakeup] delivered ${row.id} conversation=${row.conversation_id} disposition=${posted.disposition}` +
          ` scheduled=${row.scheduled_for} at=${deliveredAt.toISOString()}`,
      );
      emitPending(row.conversation_id);
      return true;
    } catch (err) {
      // Leave the row pending. The next tick retries with the same durable
      // delivery key; a crash after enqueue but before this update cannot
      // create a second message.
      log.error(`[wakeup] delivery failed ${row.id}: ${(err as Error).message}`);
      return false;
    }
  }

  function fire(conversationId: string, wakeupId: string): FireWakeupResult {
    const row = wakeupById.get(wakeupId, conversationId) as ConversationWakeupRow | undefined;
    if (!row) return { ok: false, error: 'not_found' };
    if (row.status !== PENDING) return { ok: false, error: 'not_pending' };
    const conv = conversationById.get(conversationId) as ConversationRow | undefined;
    if (!conv) return { ok: false, error: 'conversation_not_found' };
    if (conv.archived) return { ok: false, error: 'conversation_archived' };
    if (!deliver(row, conv)) return { ok: false, error: 'delivery_failed' };
    return { ok: true, wakeup: readWakeup(wakeupId, conversationId) };
  }

  function tick(): void {
    if (ticking) return;
    ticking = true;
    try {
      const due = db
        .prepare(
          `SELECT * FROM conversation_wakeups
           WHERE status = 'pending' AND datetime(scheduled_for) <= datetime(?)
           ORDER BY scheduled_for
           LIMIT 50`,
        )
        .all(now().toISOString()) as ConversationWakeupRow[];
      for (const row of due) {
        const conv = conversationById.get(row.conversation_id) as ConversationRow | undefined;
        if (!conv || conv.archived) {
          db.prepare(
            `UPDATE conversation_wakeups
             SET status = 'cancelled', cancelled_at = datetime('now')
             WHERE id = ? AND status = 'pending'`,
          ).run(row.id);
          log.warn(
            `[wakeup] cancelled undeliverable ${row.id} conversation=${row.conversation_id}` +
              (conv?.archived ? ' reason=archived' : ' reason=deleted'),
          );
          emitPending(row.conversation_id);
          continue;
        }

        deliver(row, conv);
      }
    } catch (err) {
      log.error(`[wakeup] tick failed: ${(err as Error).message}`);
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    schedule,
    list,
    listPending,
    cancel,
    reschedule,
    fire,
  };
}
