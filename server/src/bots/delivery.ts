import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ConversationRow,
  ConversationWakeupRow,
  UserRow,
} from '../db/db.js';
import { createBotService, type Decision } from './service.js';
/** Uses the existing wake dispatcher and its durable receipt, never a second executor. */
export function botWakeAllowed(
  db: Database.Database,
  w: ConversationWakeupRow,
  c: ConversationRow,
): boolean {
  if (!w.wake_key.startsWith('bot-decision:')) return true;
  const e = db
    .prepare('SELECT * FROM bot_decision_events WHERE id=?')
    .get(w.id) as
    | { decision_id: string; version: number; actor_id: number }
    | undefined;
  if (!e) return false;
  const d = db
    .prepare('SELECT * FROM bot_decisions WHERE id=?')
    .get(e.decision_id) as Decision | undefined;
  const active = db
    .prepare(
      'SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1',
    )
    .get(c.id);
  if (!d || !active || d.version !== e.version || d.conversation_id !== c.id)
    return false;
  const service = createBotService(db);
  try {
    for (const id of new Set([c.user_id, d.assignee_id, e.actor_id])) {
      const user = db
        .prepare("SELECT * FROM users WHERE id=? AND status='active'")
        .get(id) as UserRow | undefined;
      if (!user) return false;
      service.read({ user }, d.id);
      service.thread({ user }, d.id);
    }
    return true;
  } catch {
    return false;
  }
}
export function botWakeDelivered(
  db: Database.Database,
  w: ConversationWakeupRow,
) {
  if (!w.wake_key.startsWith('bot-decision:')) return;
  const e = db
    .prepare("SELECT * FROM bot_decision_events WHERE id=? AND kind='answered'")
    .get(w.id) as
    | { decision_id: string; version: number; actor_id: number }
    | undefined;
  if (!e) return;
  const result = db
    .prepare(
      "UPDATE bot_decisions SET state='action_pending',updated_at=datetime('now') WHERE id=? AND version=? AND state='decided' AND json_extract(answer_json,'$.action')='approve'",
    )
    .run(e.decision_id, e.version);
  if (result.changes)
    db.prepare(
      `INSERT OR IGNORE INTO bot_decision_events(id,decision_id,version,kind,actor_id,payload_json,request_key) VALUES(?,?,?,'action_pending',?,?,?)`,
    ).run(
      crypto.randomUUID(),
      e.decision_id,
      e.version,
      e.actor_id,
      JSON.stringify({
        evidence: 'Queued durably to the existing bot conversation',
      }),
      `delivery:${w.id}`,
    );
}
export function botWakeCancelled(
  db: Database.Database,
  w: ConversationWakeupRow,
) {
  if (!w.wake_key.startsWith('bot-decision:')) return;
  const e = db
    .prepare("SELECT * FROM bot_decision_events WHERE id=? AND kind='answered'")
    .get(w.id) as
    | { decision_id: string; version: number; actor_id: number }
    | undefined;
  if (!e) return;
  const payload = {
    state: 'blocked',
    evidence:
      'Resume was not delivered: bot registration, chat availability, or current access changed. Review and revise the proposal before retrying.',
  };
  const result = db
    .prepare(
      "UPDATE bot_decisions SET state='blocked',result_json=?,updated_at=datetime('now') WHERE id=? AND version=? AND state='decided'",
    )
    .run(JSON.stringify(payload), e.decision_id, e.version);
  if (result.changes)
    db.prepare(
      `INSERT OR IGNORE INTO bot_decision_events(id,decision_id,version,kind,actor_id,payload_json,request_key) VALUES(?,?,?,'delivery_blocked',?,?,?)`,
    ).run(
      crypto.randomUUID(),
      e.decision_id,
      e.version,
      e.actor_id,
      JSON.stringify(payload),
      `delivery-blocked:${w.id}`,
    );
}

/** Only human discussion events qualify; answers and ordinary wakeups never steer. */
export function botDiscussionWake(db: Database.Database, wakeupId: string): ConversationWakeupRow | undefined {
  return db.prepare(`SELECT w.* FROM conversation_wakeups w JOIN bot_decision_events e ON e.id=w.id
    WHERE w.id=? AND w.wake_key='bot-decision:' || w.id AND e.kind='message'
    AND e.actor_conversation_id IS NULL`).get(wakeupId) as ConversationWakeupRow | undefined;
}

export function recordDiscussionDelivery(db: Database.Database, wakeupId: string, stage: string, reason?: string) {
  db.prepare(`INSERT OR IGNORE INTO bot_decision_events
    (id,decision_id,version,kind,actor_id,payload_json,request_key)
    SELECT ?,decision_id,version,'discussion_delivery',actor_id,?,? FROM bot_decision_events
    WHERE id=? AND kind='message' AND actor_conversation_id IS NULL`).run(
    crypto.randomUUID(), JSON.stringify({ message_id: wakeupId, stage, ...(reason ? { reason } : {}) }),
    `discussion-delivery:${wakeupId}:${stage}`, wakeupId,
  );
}

/** New deliveries only: never sweep/re-steer older already-delivered incident messages. */
export function queuedDiscussionWake(db: Database.Database, conversationId: string, messageId: number): ConversationWakeupRow | undefined {
  return db.prepare(`SELECT w.* FROM hub_inbound_messages h JOIN conversation_wakeups w ON h.idempotency_key='wakeup:' || w.id
    JOIN bot_decision_events e ON e.request_key='discussion-delivery:' || w.id || ':queued'
    WHERE h.conversation_id=? AND h.message_id=? AND h.source_kind='wakeup' AND e.kind='discussion_delivery'`).get(conversationId, messageId) as ConversationWakeupRow | undefined;
}
