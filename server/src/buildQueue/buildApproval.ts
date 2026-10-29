import crypto from 'node:crypto';
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

interface ApprovingTurn { actorUserId: number; startedAt: string }

/** The live turn in this chat when an approver started it themselves (their
 * own message, or their reply on a result). Wake-ups, bot messages, routines,
 * spare runs, automation chats and queued build turns never qualify. */
function approvingTurn(db: Database.Database, executionConversationId: string | undefined): ApprovingTurn | null {
  if (!executionConversationId) return null;
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(executionConversationId) as ConversationRow | undefined;
  if (!conv || conv.channel === 'automation') return null;
  const turn = db
    .prepare("SELECT actor_user_id, origin_json, created_at FROM pending_turns WHERE conversation_id = ? AND status = 'pending'")
    .get(conv.id) as { actor_user_id: number | null; origin_json: string | null; created_at: string } | undefined;
  if (!turn) return null;
  let origin: { kind?: string; spareRunId?: string } | null = null;
  try {
    origin = turn.origin_json ? (JSON.parse(turn.origin_json) as { kind?: string; spareRunId?: string }) : null;
  } catch {
    return null;
  }
  if (origin && (origin.kind !== 'result_reply' || origin.spareRunId)) return null;
  // Scheduled tasks and routines post as their owner without an origin.
  if (db.prepare("SELECT 1 FROM scheduled_task_runs WHERE conversation_id = ? AND status IN ('queued','running')").get(conv.id)) return null;
  if (turn.actor_user_id === null || !buildApproverIds(db).includes(turn.actor_user_id)) return null;
  return { actorUserId: turn.actor_user_id, startedAt: turn.created_at };
}

function isBuildQueueTurn(db: Database.Database, executionConversationId: string | undefined): boolean {
  if (!executionConversationId) return false;
  const turn = db
    .prepare("SELECT origin_json FROM pending_turns WHERE conversation_id = ? AND status = 'pending'")
    .get(executionConversationId) as { origin_json: string | null } | undefined;
  try {
    return !!turn?.origin_json && (JSON.parse(turn.origin_json) as { kind?: string }).kind === 'build_queue';
  } catch {
    return false;
  }
}

/** May the turn now running in this chat start code work? Fails closed. */
export function turnMayStartBuild(db: Database.Database, executionConversationId: string | undefined): boolean {
  // A queued build was approved when it was enqueued; its own turn may continue it.
  if (isBuildQueueTurn(db, executionConversationId)) return true;
  return approvingTurn(db, executionConversationId) !== null;
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

/** A build pass carries an approver's yes from the chat where it was given to
 * the one chat that will queue the build. */
export const BUILD_PASS_HOURS = 24;
const BUILD_PASS_NOTE_MAX = 2000;

export interface BuildPassRow {
  id: string;
  source_conversation_id: string;
  source_turn_at: string | null;
  approver_user_id: number;
  target_conversation_id: string;
  request_key: string | null;
  scope_note: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by_job_id: number | null;
}

type PassRequest = { user?: { id: number }; agentConversationId?: string; agentExecutionConversationId?: string };

/** Only an approver's own turn mints a pass; a queued build's turn does not. */
export function requestMayMintBuildPass(db: Database.Database, req: PassRequest): boolean {
  return !!req.agentConversationId && approvingTurn(db, req.agentExecutionConversationId ?? req.agentConversationId) !== null;
}

/** Mint a pass for `targetConversationId`. Only an approver's own turn may
 * mint; anything else gets BUILD_REFUSAL. A retry with the same request key
 * returns the first pass. */
export function mintBuildPass(
  db: Database.Database,
  req: PassRequest,
  input: { targetConversationId: string; note: string; requestKey?: string | null },
): BuildPassRow {
  const note = input.note.trim();
  if (!note || note.length > BUILD_PASS_NOTE_MAX) throw new Error(`build_approval_note must say what was approved (1-${BUILD_PASS_NOTE_MAX} characters)`);
  const sourceId = req.agentConversationId;
  if (!sourceId) throw new Error('A build pass is sent from a chat by its bot; a person queues the build directly');
  const turn = approvingTurn(db, req.agentExecutionConversationId ?? sourceId);
  if (!turn) throw new Error(BUILD_REFUSAL);
  const requestKey = input.requestKey?.trim() || null;
  if (requestKey) {
    const existing = db
      .prepare('SELECT * FROM build_passes WHERE source_conversation_id = ? AND request_key = ?')
      .get(sourceId, requestKey) as BuildPassRow | undefined;
    if (existing) {
      if (existing.target_conversation_id !== input.targetConversationId || existing.scope_note !== note)
        throw new Error('request_key already carried a different build pass; use a new key for a different approval');
      return existing;
    }
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO build_passes (id, source_conversation_id, source_turn_at, approver_user_id, target_conversation_id, request_key, scope_note, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`,
  ).run(id, sourceId, turn.startedAt, turn.actorUserId, input.targetConversationId, requestKey, note, `+${BUILD_PASS_HOURS} hours`);
  return db.prepare('SELECT * FROM build_passes WHERE id = ?').get(id) as BuildPassRow;
}

/** The unused, unexpired pass this chat holds: the named one, or its only one. */
export function heldBuildPass(db: Database.Database, conversationId: string, passId?: string | null): BuildPassRow | undefined {
  const rows = db
    .prepare(
      `SELECT * FROM build_passes
        WHERE target_conversation_id = ? AND used_at IS NULL AND expires_at > datetime('now')
        ORDER BY created_at, rowid`,
    )
    .all(conversationId) as BuildPassRow[];
  if (passId) return rows.find((row) => row.id === passId);
  return rows.length === 1 ? rows[0] : undefined;
}

/** Move a held pass to the chat that will actually queue the build (a handoff
 * or a message to the build owner). Single owner at a time; expiry unchanged. */
export function forwardBuildPass(db: Database.Database, fromConversationId: string, toConversationId: string, passId?: string | null): BuildPassRow {
  // A retried send finds the pass already moved.
  const already = passId ? heldBuildPass(db, toConversationId, passId) : undefined;
  if (already) return already;
  const pass = heldBuildPass(db, fromConversationId, passId);
  if (!pass) throw new Error(BUILD_REFUSAL);
  const moved = db
    .prepare("UPDATE build_passes SET target_conversation_id = ? WHERE id = ? AND target_conversation_id = ? AND used_at IS NULL AND expires_at > datetime('now')")
    .run(toConversationId, pass.id, fromConversationId);
  if (moved.changes !== 1) throw new Error(BUILD_REFUSAL);
  return { ...pass, target_conversation_id: toConversationId };
}

/** Claim a pass for one enqueue. Returns undefined when this chat holds none. */
export function claimBuildPass(db: Database.Database, conversationId: string, passId?: string | null): BuildPassRow | undefined {
  const pass = heldBuildPass(db, conversationId, passId);
  if (!pass) return undefined;
  const claimed = db
    .prepare("UPDATE build_passes SET used_at = datetime('now') WHERE id = ? AND target_conversation_id = ? AND used_at IS NULL AND expires_at > datetime('now')")
    .run(pass.id, conversationId);
  return claimed.changes === 1 ? pass : undefined;
}

export function settleBuildPass(db: Database.Database, passId: string, jobId: number | null): void {
  if (jobId === null) db.prepare('UPDATE build_passes SET used_at = NULL WHERE id = ? AND used_by_job_id IS NULL').run(passId);
  else db.prepare('UPDATE build_passes SET used_by_job_id = ? WHERE id = ?').run(jobId, passId);
}

export function approverName(db: Database.Database, userId: number): string {
  const row = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as { display_name: string | null } | undefined;
  return row?.display_name?.trim() || 'The owner';
}

/** The line the receiving chat sees, so it knows it may queue this one build. */
export function buildPassNotice(db: Database.Database, pass: BuildPassRow): string {
  return `[Build pass ${pass.id}: ${approverName(db, pass.approver_user_id)} approved this build: "${pass.scope_note}". ` +
    `Call enqueue_build with build_pass "${pass.id}" for this one build; it works once and expires ${pass.expires_at} UTC.]`;
}
