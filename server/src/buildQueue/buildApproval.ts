import type Database from 'better-sqlite3';
import type { ConversationRow } from '../db/db.js';

/** Who may start code work. Nick approves builds for now (October 14, 2026);
 * James's link posts as the owner, so his turns count too. Widen the list by
 * setting `build_approver_user_ids` to a JSON array of user ids. */
export const BUILD_APPROVERS_SETTING = 'build_approver_user_ids';
/** Registered bots whose standing chats do technical work. */
export const TECHNICAL_BOTS_SETTING = 'build_technical_bot_names';

export const BUILD_REFUSAL =
  'Builds start only when Nick asks for one (or James on his behalf). If you are stuck, raise_decision with one sentence: ' +
  'what you were trying to do, what stopped you, and the simplest non-code option you see (skill update, config, manual step). ' +
  'Otherwise work around it with the tools and skills you have. Do not ask again after a no.';

function setting<T>(db: Database.Database, key: string): T | undefined {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return undefined;
  }
}

export function buildApproverIds(db: Database.Database): number[] {
  const configured = setting<unknown>(db, BUILD_APPROVERS_SETTING);
  if (Array.isArray(configured) && configured.every((id) => Number.isSafeInteger(id))) return configured as number[];
  return (db.prepare("SELECT id FROM users WHERE role = 'owner' AND status = 'active'").all() as { id: number }[]).map((u) => u.id);
}

export function isTechnicalConversation(db: Database.Database, conversationId: string): boolean {
  const row = db
    .prepare(
      `SELECT a.slug, b.name FROM conversations c
         JOIN assistants a ON a.id = c.assistant_id
         LEFT JOIN bot_registrations b ON b.conversation_id = c.id AND b.active = 1
        WHERE c.id = ?`,
    )
    .get(conversationId) as { slug: string; name: string | null } | undefined;
  if (!row) return false;
  if (row.slug === 'platform-dev') return true;
  const names = setting<unknown>(db, TECHNICAL_BOTS_SETTING);
  const technical = Array.isArray(names) ? names.map(String) : ['Boris'];
  return !!row.name && technical.some((n) => n.toLowerCase() === row.name!.toLowerCase());
}

/** May the turn now running in this chat start code work? Fails closed. */
export function turnMayStartBuild(db: Database.Database, executionConversationId: string | undefined): boolean {
  if (!executionConversationId) return false;
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(executionConversationId) as ConversationRow | undefined;
  if (!conv || conv.channel === 'automation') return false;
  const turn = db
    .prepare("SELECT actor_user_id, origin_json FROM pending_turns WHERE conversation_id = ? AND status = 'pending'")
    .get(conv.id) as { actor_user_id: number | null; origin_json: string | null } | undefined;
  if (!turn) return false;
  let origin: { kind?: string; spareRunId?: string } | null = null;
  try {
    origin = turn.origin_json ? (JSON.parse(turn.origin_json) as { kind?: string; spareRunId?: string }) : null;
  } catch {
    return false;
  }
  // A queued build was approved when it was enqueued; its own turn may continue it.
  if (origin?.kind === 'build_queue') return true;
  if (origin && (origin.kind !== 'result_reply' || origin.spareRunId)) return false;
  // Scheduled tasks and routines post as their owner without an origin.
  if (db.prepare("SELECT 1 FROM scheduled_task_runs WHERE conversation_id = ? AND status IN ('queued','running')").get(conv.id)) return false;
  return turn.actor_user_id !== null && buildApproverIds(db).includes(turn.actor_user_id);
}

/** Request-level check: a person calling directly, or an agent whose current turn qualifies. */
export function requestMayStartBuild(
  db: Database.Database,
  req: { user?: { id: number }; agentConversationId?: string; agentExecutionConversationId?: string },
): boolean {
  if (!req.agentConversationId) return !!req.user && buildApproverIds(db).includes(req.user.id);
  return turnMayStartBuild(db, req.agentExecutionConversationId ?? req.agentConversationId);
}

/** A bot may answer a technical chat that wrote to it in the last week; only
 * opening a new request to Boris or Platform Dev needs Nick's turn. */
export function isReplyToTechnical(db: Database.Database, sourceId: string, targetId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM agent_message_receipts
        WHERE source_conversation_id = ? AND target_conversation_id = ? AND created_at > datetime('now', '-7 days') LIMIT 1`,
    )
    .get(targetId, sourceId);
}
