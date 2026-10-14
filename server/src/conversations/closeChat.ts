import type Database from 'better-sqlite3';
import type { ConversationRow } from '../db/db.js';

/**
 * close_chat: a bot finishes its OWN one-issue chat by reporting and archiving
 * it. Archive only — history, audit and search documents stay. Every check
 * below reads durable rows, so a chat that still owes anything stays open.
 */

export type DeploymentStatus = 'live' | 'pending' | 'none';

export interface CloseChatDeployment {
  status: DeploymentStatus;
  notifiedConversationIds: string[];
}

export interface CloseChatBlocker {
  kind:
    | 'pending_wakeup'
    | 'active_build'
    | 'open_decision'
    | 'pending_question'
    | 'undelivered_message'
    | 'queued_message'
    | 'deployment_status_required'
    | 'deployment_not_reported';
  ids: string[];
  detail: string;
}

export interface ChatClosureRow {
  conversation_id: string;
  actor_user_id: number;
  report: string;
  report_to: string | null;
  report_thread_id: string | null;
  deployment_json: string | null;
  closed_at: string;
}

/** Why a chat can never be closed by this tool, or null when it is eligible. */
export function closeChatIneligibility(db: Database.Database, row: ConversationRow): string | null {
  if (db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(row.id)) {
    return 'This is a registered bot’s standing chat. Standing chats are never closed; hand each issue to its own chat instead.';
  }
  if (row.pin_order !== null && row.pin_order !== undefined) return 'This chat is pinned. Only its human can unpin or archive it.';
  if (row.channel === 'automation') return 'Automation chats are managed by their scheduled task, not close_chat.';
  if (row.side_chat_of) return 'Side chats and coordination lanes close with their parent chat.';
  return null;
}

// A decided answer that approves or directs work still owes a result; reject,
// defer and withdraw close the question.
const CLOSED_ANSWER_ACTIONS = new Set(['reject', 'defer', 'withdraw']);

export function closeChatBlockers(
  db: Database.Database,
  conversationId: string,
  options: { deployment?: CloseChatDeployment | null; reportTo?: string | null } = {},
): CloseChatBlocker[] {
  const blockers: CloseChatBlocker[] = [];
  const ids = (sql: string, ...params: unknown[]) =>
    (db.prepare(sql).all(...params) as { id: string | number }[]).map((r) => String(r.id));

  const wakeups = ids(
    "SELECT id FROM conversation_wakeups WHERE conversation_id=? AND status='pending' ORDER BY scheduled_for",
    conversationId,
  );
  if (wakeups.length) {
    blockers.push({ kind: 'pending_wakeup', ids: wakeups, detail: 'Cancel or let these wake-ups deliver first (list_wakeups, cancel_wakeup).' });
  }

  const builds = ids(
    "SELECT id FROM build_queue WHERE conversation_id=? AND status IN ('queued','running','failed','stopped') ORDER BY id",
    conversationId,
  );
  if (builds.length) {
    blockers.push({
      kind: 'active_build',
      ids: builds,
      detail: 'A queued, running, failed or stopped build still belongs to this chat. A build chat closes in a later turn, after its slot is released; resolve failed or stopped jobs with resolve_build_queue.',
    });
  }

  const decisions = (
    db
      .prepare(
        "SELECT id,state,answer_json FROM bot_decisions WHERE conversation_id=? AND state IN ('needs_input','decided','action_pending','running','blocked') ORDER BY created_at",
      )
      .all(conversationId) as { id: string; state: string; answer_json: string | null }[]
  )
    .filter((d) => {
      if (d.state !== 'decided') return true;
      try {
        const action = (JSON.parse(d.answer_json ?? '{}') as { action?: unknown }).action;
        return !CLOSED_ANSWER_ACTIONS.has(String(action));
      } catch {
        return true;
      }
    })
    .map((d) => d.id);
  if (decisions.length) {
    blockers.push({
      kind: 'open_decision',
      ids: decisions,
      detail: 'Withdraw moot questions, or record_decision_result (verified_completed, or blocked with a repair owner who is told) before closing.',
    });
  }

  const questions = ids(
    "SELECT request_id AS id FROM questions WHERE conversation_id=? AND status='pending' ORDER BY created_at",
    conversationId,
  );
  if (questions.length) {
    blockers.push({ kind: 'pending_question', ids: questions, detail: 'A question card is still waiting for the human.' });
  }

  const undelivered = [
    ...ids(
      `SELECT id FROM bot_message_drafts WHERE conversation_id=?
         AND (state IN ('queued','sending','uncertain','failed') OR (state='draft' AND authorized_by IS NOT NULL))
       ORDER BY created_at`,
      conversationId,
    ),
    ...ids(
      `SELECT d.id FROM bot_message_delegations d
        WHERE (d.owner_conversation_id=? OR d.executor_conversation_id=?)
          AND NOT EXISTS (SELECT 1 FROM bot_message_delegation_events e WHERE e.delegation_id=d.id AND e.kind IN ('sent','revoked'))
        ORDER BY d.created_at`,
      conversationId,
      conversationId,
    ),
  ];
  if (undelivered.length) {
    blockers.push({
      kind: 'undelivered_message',
      ids: undelivered,
      detail: 'An approved or in-flight message is not delivered. Send it once and record_message_delivery, check an uncertain send at the source, or retire/revoke it.',
    });
  }

  const queued = ids('SELECT id FROM queued_messages WHERE conversation_id=? ORDER BY id', conversationId);
  if (queued.length) {
    blockers.push({ kind: 'queued_message', ids: queued, detail: 'A message is still queued for this chat; answer it first.' });
  }

  // Pushed-but-undeployed work: build rows record that code was finished, not
  // that it went live, so the closing bot must say which it is. "pending"
  // requires a real message from this chat to every waiting party after the
  // latest build finished; the requester (origin chat) is always a waiting party.
  const doneBuilds = db
    .prepare(
      "SELECT id, finished_at FROM build_queue WHERE conversation_id=? AND status='done' ORDER BY COALESCE(finished_at, created_at) DESC",
    )
    .all(conversationId) as { id: number; finished_at: string | null }[];
  if (doneBuilds.length) {
    const deployment = options.deployment;
    const buildIds = doneBuilds.map((b) => String(b.id));
    if (!deployment) {
      blockers.push({
        kind: 'deployment_status_required',
        ids: buildIds,
        detail: 'This chat finished builds. Pass deployment.status: live (verified running), none (nothing to deploy), or pending (with notified_conversation_ids).',
      });
    } else if (deployment.status === 'pending') {
      const origin = (
        db.prepare('SELECT origin_conversation_id FROM conversations WHERE id=?').get(conversationId) as
          | { origin_conversation_id: string | null }
          | undefined
      )?.origin_conversation_id;
      const reportTo = options.reportTo ?? null;
      const waiting = new Set(deployment.notifiedConversationIds);
      if (origin && origin !== conversationId) waiting.add(origin);
      const latest = doneBuilds[0]!.finished_at;
      const untold = [...waiting].filter((target) => {
        // The final report itself goes to reportTo before archiving.
        if (target === reportTo) return false;
        return !db
          .prepare(
            `SELECT 1 FROM agent_message_receipts
              WHERE source_conversation_id=? AND target_conversation_id=?
                AND (? IS NULL OR julianday(created_at) >= julianday(?))`,
          )
          .get(conversationId, target, latest, latest);
      });
      if (waiting.size === 0) {
        blockers.push({
          kind: 'deployment_not_reported',
          ids: buildIds,
          detail: 'Deployment is pending but nobody waiting was named. Tell the requester or waiting bot (send_message) and list them in notified_conversation_ids, or send the report to them.',
        });
      } else if (untold.length) {
        blockers.push({
          kind: 'deployment_not_reported',
          ids: untold,
          detail: 'Deployment is pending and these waiting chats have no message from this chat since the build finished. Tell them with send_message, or make one of them report_to.',
        });
      }
    }
  }
  return blockers;
}

export function readChatClosure(db: Database.Database, conversationId: string): ChatClosureRow | undefined {
  return db.prepare('SELECT * FROM chat_closures WHERE conversation_id=?').get(conversationId) as ChatClosureRow | undefined;
}

/** Archive exactly like manual archive (unpinned, linked active todos done) and record the report. */
export function archiveClosedChat(
  db: Database.Database,
  closure: Omit<ChatClosureRow, 'closed_at'>,
): ChatClosureRow {
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO chat_closures(conversation_id,actor_user_id,report,report_to,report_thread_id,deployment_json)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(conversation_id) DO UPDATE SET actor_user_id=excluded.actor_user_id, report=excluded.report,
         report_to=excluded.report_to, report_thread_id=excluded.report_thread_id,
         deployment_json=excluded.deployment_json, closed_at=datetime('now')`,
    ).run(
      closure.conversation_id,
      closure.actor_user_id,
      closure.report,
      closure.report_to,
      closure.report_thread_id,
      closure.deployment_json,
    );
    db.prepare('UPDATE conversations SET archived = 1, pin_order = NULL WHERE id = ?').run(closure.conversation_id);
    db.prepare(
      `UPDATE todos SET state = 'done', updated_at = datetime('now')
        WHERE conversation_id = ? AND state = 'active'`,
    ).run(closure.conversation_id);
    return readChatClosure(db, closure.conversation_id)!;
  })();
}
