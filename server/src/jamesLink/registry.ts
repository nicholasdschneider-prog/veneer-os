import type Database from 'better-sqlite3';

/**
 * James link thread registry. Every chat is a thread with an owner guess
 * (started_by), a status, and a turn counter stamped on every message in both
 * directions. James's API replies must name the turn they answer; a reply
 * whose expected turn is behind is rejected as stale.
 */

export const STARTED_BY = ['james', 'nick', 'bot'] as const;
export type StartedBy = (typeof STARTED_BY)[number];
export const THREAD_STATUSES = ['open', 'waiting_on_james', 'waiting_on_veneer', 'done', 'archived'] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];
export type Author = 'james' | 'human' | 'bot' | 'veneer';

/** Every message James posts through the link carries this marker first. */
export const JAMES_MARKER = '[James link';
export const EXCERPT_MAX = 4000;

export interface ThreadRow {
  conversation_id: string;
  title: string | null;
  started_by: StartedBy;
  started_by_source: string;
  followed: number;
  status: ThreadStatus;
  turn: number;
  last_activity: string;
  question_since: string | null;
  question_pushed_at: string | null;
  quiet_pushed_at: string | null;
  done_at: string | null;
  archived_at: string | null;
  conversation_archived: number;
}

export const iso = (ms = Date.now()) => new Date(ms).toISOString();

const JAMES_START = /^\s*(?:\*\*)?(?:from james\b|james for nick\b|james here\b|james:)/i;
const JAMES_MENTION = /\bjames\b/i;

/** Best guess at who opened a thread from its first message. */
export function guessStartedBy(firstText: string | null | undefined, botOrigin: boolean): StartedBy {
  const text = (firstText ?? '').slice(0, 300);
  if (JAMES_START.test(text) || /\b(?:from james|james asked|james for nick|james wants)\b/i.test(text)) return 'james';
  if (botOrigin) return 'bot';
  // Platform-generated prompts (wakes, build queue, scheduled runs) open with a bracketed tag.
  if (/^\s*\[(?:build queue|scheduled|wake|automation|routine|handoff)/i.test(text)) return 'bot';
  return 'nick';
}

/** A message that mentions James early means James follows the thread. */
export function mentionsJames(text: string | null | undefined): boolean {
  return JAMES_MENTION.test((text ?? '').slice(0, 400));
}

/** Whether a Veneer reply ends by asking something (the last two paragraphs carry a question mark). */
export function asksQuestion(markdown: string): boolean {
  const stripped = markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .trim();
  const tail = stripped.split(/\n\s*\n/).slice(-2).join('\n');
  return /\?/.test(tail);
}

export function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > EXCERPT_MAX ? `${trimmed.slice(0, EXCERPT_MAX - 1)}…` : trimmed;
}

const THREAD_SELECT = `
  SELECT t.*, c.title AS title, c.archived AS conversation_archived
    FROM james_threads t JOIN conversations c ON c.id = t.conversation_id`;

export function getThread(db: Database.Database, conversationId: string): ThreadRow | undefined {
  return db.prepare(`${THREAD_SELECT} WHERE t.conversation_id = ?`).get(conversationId) as ThreadRow | undefined;
}

/** Resolve a full id or an unambiguous 8+ character prefix. */
export function resolveThreadId(db: Database.Database, idOrPrefix: string): string | null {
  const value = idOrPrefix.trim().toLowerCase();
  if (!/^[0-9a-f-]{8,36}$/.test(value)) return null;
  const rows = db
    .prepare('SELECT id FROM conversations WHERE id = ? OR id LIKE ? LIMIT 2')
    .all(value, `${value}%`) as { id: string }[];
  const exact = rows.find((r) => r.id === value);
  if (exact) return exact.id;
  return rows.length === 1 ? rows[0]!.id : null;
}

/** Create the registry row for a chat that has none yet. */
export function ensureThread(
  db: Database.Database,
  conversationId: string,
  firstText?: string | null,
  botOrigin = false,
): ThreadRow | undefined {
  const conv = db
    .prepare('SELECT id, origin_conversation_id, channel, archived, last_active_at FROM conversations WHERE id = ?')
    .get(conversationId) as
    | { id: string; origin_conversation_id: string | null; channel: string; archived: number; last_active_at: string }
    | undefined;
  if (!conv) return undefined;
  const startedBy = guessStartedBy(firstText, botOrigin || !!conv.origin_conversation_id || conv.channel === 'automation');
  db.prepare(
    `INSERT OR IGNORE INTO james_threads (conversation_id, started_by, started_by_source, followed, status, last_activity)
     VALUES (?, ?, 'live', ?, ?, ?)`,
  ).run(conversationId, startedBy, mentionsJames(firstText) ? 1 : 0, conv.archived ? 'archived' : 'open', iso());
  return getThread(db, conversationId);
}

export interface StampInput {
  conversationId: string;
  direction: 'to_veneer' | 'from_veneer';
  author: Author;
  via: string;
  sourceRef: string;
  text: string;
  /** For to_veneer: the first text, used to guess started_by when the row is new. */
  botOrigin?: boolean;
  /** Required turn for James API posts; a mismatch throws StaleTurnError. */
  expectedTurn?: number;
}

export class StaleTurnError extends Error {
  constructor(readonly currentTurn: number, readonly expectedTurn: number) {
    super(`Stale turn: expected ${expectedTurn}, thread is at turn ${currentTurn}.`);
    this.name = 'StaleTurnError';
  }
}

export interface StampResult {
  thread: ThreadRow;
  turn: number;
  inserted: boolean;
  asked: boolean;
}

/**
 * Stamp one message onto its thread: next turn, ledger row, status and
 * activity. Idempotent by (direction, sourceRef). Runs in one transaction so a
 * concurrent stale reply cannot slip in between the check and the increment.
 */
export function stampMessage(db: Database.Database, input: StampInput, nowMs = Date.now()): StampResult | undefined {
  return db.transaction((): StampResult | undefined => {
    let thread = getThread(db, input.conversationId)
      ?? ensureThread(db, input.conversationId, input.direction === 'to_veneer' ? input.text : null, input.botOrigin);
    if (!thread) return undefined;
    if (input.expectedTurn !== undefined && input.expectedTurn !== thread.turn) {
      throw new StaleTurnError(thread.turn, input.expectedTurn);
    }
    const existing = db
      .prepare('SELECT turn FROM james_thread_messages WHERE conversation_id = ? AND direction = ? AND source_ref = ?')
      .get(input.conversationId, input.direction, input.sourceRef) as { turn: number } | undefined;
    if (existing) return { thread, turn: existing.turn, inserted: false, asked: false };
    const turn = thread.turn + 1;
    const now = iso(nowMs);
    db.prepare(
      `INSERT INTO james_thread_messages (conversation_id, turn, direction, author, via, source_ref, excerpt, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.conversationId, turn, input.direction, input.author, input.via, input.sourceRef, excerpt(input.text), now);
    const asked = input.direction === 'from_veneer' && asksQuestion(input.text);
    let status: ThreadStatus = thread.status;
    if (input.direction === 'to_veneer') {
      // Any new message reopens a closed thread; archived stays archived unless the chat itself was restored.
      if (status !== 'archived' || thread.conversation_archived === 0) status = 'waiting_on_veneer';
    } else if (status !== 'archived' && status !== 'done') {
      status = asked ? 'waiting_on_james' : 'open';
    }
    const followed = thread.followed || (input.author === 'james' || mentionsJames(input.direction === 'to_veneer' ? input.text : '') ? 1 : 0);
    db.prepare(
      `UPDATE james_threads
          SET turn = ?, last_activity = ?, status = ?, followed = ?,
              question_since = CASE WHEN ? = 'to_veneer' THEN NULL WHEN ? = 1 THEN ? ELSE NULL END,
              question_pushed_at = CASE WHEN ? = 1 THEN NULL ELSE question_pushed_at END,
              done_at = CASE WHEN ? = 'done' THEN done_at ELSE NULL END,
              archived_at = CASE WHEN ? = 'archived' THEN archived_at ELSE NULL END,
              updated_at = ?
        WHERE conversation_id = ?`,
    ).run(
      turn, now, status, followed,
      input.direction, asked ? 1 : 0, now,
      asked ? 1 : 0,
      status, status, now, input.conversationId,
    );
    thread = getThread(db, input.conversationId)!;
    return { thread, turn, inserted: true, asked };
  })();
}

export function isJamesThread(thread: Pick<ThreadRow, 'started_by' | 'followed'>): boolean {
  return thread.started_by === 'james' || thread.followed === 1;
}

export function setStatus(db: Database.Database, conversationId: string, status: 'done' | 'archived' | 'open', nowMs = Date.now()) {
  const now = iso(nowMs);
  db.transaction(() => {
    db.prepare(
      `UPDATE james_threads
          SET status = ?,
              done_at = CASE WHEN ? = 'done' THEN ? WHEN ? = 'archived' THEN done_at ELSE NULL END,
              archived_at = CASE WHEN ? = 'archived' THEN ? ELSE NULL END,
              question_since = NULL,
              updated_at = ?
        WHERE conversation_id = ?`,
    ).run(status, status, now, status, status, now, now, conversationId);
    if (status === 'archived') {
      // Same effect as the chat menu's Archive; nothing is deleted.
      db.prepare('UPDATE conversations SET archived = 1, pin_order = NULL WHERE id = ?').run(conversationId);
      db.prepare(
        "UPDATE todos SET state = 'done', updated_at = datetime('now') WHERE conversation_id = ? AND state = 'active'",
      ).run(conversationId);
    } else if (status === 'open') {
      db.prepare(
        "UPDATE conversations SET archived = 0, last_user_activity_at = datetime('now') WHERE id = ? AND archived = 1",
      ).run(conversationId);
    }
  })();
}

export function setFollowed(db: Database.Database, conversationId: string, followed: boolean) {
  db.prepare('UPDATE james_threads SET followed = ?, updated_at = ? WHERE conversation_id = ?').run(
    followed ? 1 : 0, iso(), conversationId,
  );
}

export interface ListFilter {
  startedBy?: StartedBy;
  statuses?: ThreadStatus[];
  followed?: boolean;
  /** started_by=james OR followed. */
  james?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

export function listThreads(db: Database.Database, filter: ListFilter): { total: number; threads: ThreadRow[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.startedBy) { where.push('t.started_by = ?'); params.push(filter.startedBy); }
  if (filter.statuses?.length) {
    where.push(`t.status IN (${filter.statuses.map(() => '?').join(',')})`);
    params.push(...filter.statuses);
  } else {
    where.push("t.status <> 'archived'");
  }
  if (filter.followed !== undefined) { where.push('t.followed = ?'); params.push(filter.followed ? 1 : 0); }
  if (filter.james) where.push("(t.started_by = 'james' OR t.followed = 1)");
  if (filter.q) { where.push('(c.title LIKE ? OR t.conversation_id LIKE ?)'); params.push(`%${filter.q}%`, `${filter.q}%`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM james_threads t JOIN conversations c ON c.id = t.conversation_id ${clause}`).get(...params) as { n: number }).n;
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  const threads = db
    .prepare(`${THREAD_SELECT} ${clause} ORDER BY t.last_activity DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as ThreadRow[];
  return { total, threads };
}

export function recentMessages(db: Database.Database, conversationId: string, limit = 20) {
  return (db
    .prepare(
      `SELECT turn, direction, author, via, excerpt, at FROM james_thread_messages
        WHERE conversation_id = ? ORDER BY turn DESC LIMIT ?`,
    )
    .all(conversationId, limit) as Array<{ turn: number; direction: string; author: string; via: string; excerpt: string; at: string }>)
    .reverse();
}

export function getState(db: Database.Database, key: string): string | null {
  return (db.prepare('SELECT value FROM james_link_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}
export function setState(db: Database.Database, key: string, value: string | null) {
  if (value === null) db.prepare('DELETE FROM james_link_state WHERE key = ?').run(key);
  else db.prepare('INSERT INTO james_link_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/**
 * One-time backfill of every existing chat: started_by from the first indexed
 * human message, followed from any early mention of James, turn from the
 * indexed message count. Existing rows are left alone. Quiet pushes start from
 * now so the backfill does not flood James with old threads.
 */
export function backfillThreads(db: Database.Database, nowMs = Date.now()): number {
  const rows = db
    .prepare(
      `SELECT c.id, c.archived, c.channel, c.origin_conversation_id,
              strftime('%Y-%m-%dT%H:%M:%fZ', c.last_active_at) AS last_active,
              (SELECT d.body FROM bot_search_documents d
                 WHERE d.conversation_id = c.id AND d.kind = 'user' ORDER BY d.at, d.rowid LIMIT 1) AS first_text,
              (SELECT d.body FROM bot_search_documents d
                 WHERE d.conversation_id = c.id AND d.kind = 'assistant' ORDER BY d.at DESC, d.rowid DESC LIMIT 1) AS last_reply,
              (SELECT d.kind FROM bot_search_documents d
                 WHERE d.conversation_id = c.id AND d.kind IN ('user', 'assistant') ORDER BY d.at DESC, d.rowid DESC LIMIT 1) AS last_kind,
              (SELECT COUNT(*) FROM bot_search_documents d
                 WHERE d.conversation_id = c.id AND d.kind IN ('user', 'assistant')) AS turns,
              EXISTS (SELECT 1 FROM bot_search_documents d
                 WHERE d.conversation_id = c.id AND d.kind = 'user' AND substr(d.body, 1, 400) LIKE '%james%') AS mentions
         FROM conversations c
        WHERE NOT EXISTS (SELECT 1 FROM james_threads t WHERE t.conversation_id = c.id)`,
    )
    .all() as Array<{
      id: string; archived: number; channel: string; origin_conversation_id: string | null; last_active: string | null;
      first_text: string | null; last_reply: string | null; last_kind: string | null; turns: number; mentions: number;
    }>;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO james_threads
       (conversation_id, started_by, started_by_source, followed, status, turn, last_activity, quiet_pushed_at, archived_at)
     VALUES (?, ?, 'backfill', ?, ?, ?, ?, ?, ?)`,
  );
  const now = iso(nowMs);
  db.transaction(() => {
    for (const row of rows) {
      const startedBy = guessStartedBy(row.first_text, !!row.origin_conversation_id || row.channel === 'automation');
      const followed = row.mentions ? 1 : 0;
      const last = row.last_active ?? now;
      let status: ThreadStatus = 'open';
      if (row.archived) status = 'archived';
      else if (row.last_kind === 'user') status = 'waiting_on_veneer';
      else if (row.last_reply && asksQuestion(row.last_reply)) status = 'waiting_on_james';
      insert.run(row.id, startedBy, followed, status, row.turns, last, now, row.archived ? last : null);
    }
  })();
  return rows.length;
}
