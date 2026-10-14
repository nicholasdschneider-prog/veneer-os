import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ConversationEvent } from '../runtime/events.js';
import { MailNotSentError, type Mailer } from './mail.js';
import { createJamesConversation, UnknownProjectError } from './create.js';
import { pruneIdempotency } from './idempotency.js';
import {
  JAMES_MARKER, ensureThread, excerpt, getState, getThread, iso, isJamesThread, listThreads, resolveThreadId, setState, setStatus,
  stampMessage, StaleTurnError, type ThreadRow,
} from './registry.js';
import {
  CONTRACT_CHECK_SOURCE, ensureSpoolDirs, importSpool, maybeActivate, readActive, spoolSelfCheck, writeNativeReady, writeReceipt,
} from './spool.js';

/**
 * Push side of the James link. Thread events become push reasons; only
 * actionable ones (a question waiting on James, a decision needing Nick, the
 * outcome of work James asked for, notify_james, James's test push) are POSTed,
 * batched to at most one webhook POST per thread per 15 minutes. Everything
 * else (quiet threads, progress replies in followed threads, email status
 * changes) is recorded as suppressed and summarized in the 8:30 AM ET daily
 * digest. A push whose two POSTs fail is held for the daily digest email;
 * the only email outside it is a notify_james whose caller states an urgent
 * money or customer matter Nick needs today.
 *
 * Daily email: once the ERVP cutover has written $DATA_DIR/james-digest/ACTIVE
 * (contract out/build823/digest-contract.md), one digest goes every ET date at
 * or after 8:30, even when empty, with the James heartbeat, held pushes, the
 * imported ERVP items and the webhook state. Before cutover, an email goes only
 * on a day when something was held back.
 */

export const PUSH_GAP_MS = 15 * 60_000;
export const QUESTION_NUDGE_MS = 15 * 60_000;
export const QUIET_DAY_MS = 2 * 3_600_000;
export const QUIET_NIGHT_MS = 12 * 3_600_000;
export const AUTO_ARCHIVE_MS = 7 * 24 * 3_600_000;
/** Quiet pushes only for threads active in the last week, so old threads never storm. */
const QUIET_HORIZON_MS = 7 * 24 * 3_600_000;
/** The digest goes to the first address; the second only after the first certainly failed. */
export const ALERT_EMAILS = ['nicks@mail.grokbot.com', 'nick@elkhartrvparts.com'] as const;
/** About how much item text a digest carries in full; past it, items are listed by subject, source and key. */
export const DIGEST_BODY_BUDGET = 60_000;
/** A digest still 'sending' this long after its claim (the process died mid-send) is unknown, never re-sent. */
const DIGEST_STUCK_MS = 15 * 60_000;
/** notify_james matters that may bypass the daily digest when the webhook fails. */
export const URGENT_FOR_NICK = ['money', 'customer'] as const;
export type UrgentForNick = (typeof URGENT_FOR_NICK)[number];
/** Why a thread event is POSTed; null means recorded as suppressed. */
export type Actionable = 'waiting_on_james' | 'needs_nick' | 'answers_james' | 'james_thread';
/** Per-event excerpt cap inside the digest, so a day of deferred pushes stays readable. */
const DIGEST_EXCERPT_MAX = 600;
const DIGEST_MAX_PUSHES = 150;
export const EMAIL_COMMAND_SENDERS = ['nicks@mail.grokbot.com', 'nick@elkhartrvparts.com'];
const MAX_LIST = 50;

/** The caller's explicit statement that a notify_james is an urgent matter Nick needs today. */
export interface UrgentNotice {
  kind: UrgentForNick;
  needsNickToday: true;
  reason: string;
  evidence: string | string[];
  neededOn: string;
}

type SendOutcome = { outcome: 'sent'; messageId: string } | { outcome: 'failed'; error: string } | { outcome: 'unknown'; error: string };

export interface JamesLinkDeps {
  db: Database.Database;
  /** Doppler values at use time; never logged. */
  getSecret(name: string): string | null;
  fetch: typeof fetch;
  mailer: Mailer;
  now(): number;
  publicOrigin: string | null;
  /** Post James's text into the chat as an ordinary human message. */
  postToChat(conversationId: string, text: string): Promise<{ disposition?: string }>;
  statusOf(conversationId: string): Promise<string>;
  sleep?(ms: number): Promise<void>;
  log?(message: string): void;
  /** $DATA_DIR/james-digest; null disables the ERVP spool and the cutover digest. */
  spoolDir?: string | null;
  /** Source commit recorded in NATIVE_READY. */
  commit?: string | null;
}

export type PushReason = 'reply' | 'question_unanswered' | 'quiet' | 'heartbeat' | 'status_changed' | 'test' | 'notify';

/** How long a human's "tell James" direction stays usable for notify_james. */
export const NOTIFY_AUTHORITY_MS = 24 * 3_600_000;

export type NotifyResult =
  | { ok: true; replay: boolean; idempotency_key: string; thread_id: string; authority_turn: number; ledger_turn: number | null; push_id: number | null; status: string; attempts: number; emailed_to: string | null; last_error: string | null }
  | { ok: false; status: number; error: string; detail?: string };

export function etClock(ms: number): { date: string; hour: number; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

export function quietThresholdMs(ms: number): number {
  const { hour } = etClock(ms);
  return hour >= 7 && hour < 21 ? QUIET_DAY_MS : QUIET_NIGHT_MS;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** First line of a reply, ignoring quoted history. */
export function parseEmailCommand(subject: string, text: string): { command: 'CLOSE' | 'ARCHIVE'; threadRef: string | null } | null {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('>')) ?? '';
  const match = first.match(/^(CLOSE|ARCHIVE)\b(.*)$/);
  if (!match) return null;
  const ref = match[2]!.match(UUID)?.[0] ?? subject.match(UUID)?.[0] ?? match[2]!.trim().match(/^[0-9a-f]{8,}/i)?.[0] ?? null;
  return { command: match[1] as 'CLOSE' | 'ARCHIVE', threadRef: ref };
}

export class JamesLink {
  private flushing: Promise<void> | null = null;
  private lastText = new Map<string, { turnId: string; markdown: string }>();
  private ticks = 0;
  private spoolReady = false;

  constructor(private readonly deps: JamesLinkDeps) {}

  private get db() { return this.deps.db; }
  private log(message: string) { this.deps.log?.(`[james-link] ${message}`); }

  threadUrl(id: string) {
    return this.deps.publicOrigin ? `${this.deps.publicOrigin.replace(/\/$/, '')}/#/chat/${encodeURIComponent(id)}` : null;
  }

  summary(t: ThreadRow) {
    return {
      thread_id: t.conversation_id,
      title: t.title ?? '(untitled)',
      started_by: t.started_by,
      followed: t.followed === 1,
      status: t.status,
      turn: t.turn,
      last_activity: t.last_activity,
      url: this.threadUrl(t.conversation_id),
    };
  }

  // ── Inbound events from the runner bus ────────────────────────────────────
  onEvent(conversationId: string, event: ConversationEvent) {
    try {
      if (event.type === 'turn_started') {
        if (event.text.startsWith(JAMES_MARKER)) {
          // Stamped by the API when James posted it; this turn is the answer to him.
          this.db.prepare('UPDATE james_threads SET james_answer_turn_id = ? WHERE conversation_id = ? AND james_pending_since IS NOT NULL')
            .run(event.turnId, conversationId);
          return;
        }
        const origin = event.origin;
        const author = /^\s*(?:\*\*)?(?:from james\b|james for nick\b)/i.test(event.text)
          ? 'james'
          : origin && origin.kind !== 'result_reply' ? 'bot' : 'human';
        stampMessage(this.db, {
          conversationId, direction: 'to_veneer', author, via: origin?.kind ?? event.via,
          sourceRef: `turn:${event.turnId}`, text: event.text, botOrigin: author === 'bot',
        }, this.deps.now());
      } else if (event.type === 'text_final') {
        this.lastText.set(conversationId, { turnId: event.turnId, markdown: event.markdown });
      } else if (event.type === 'turn_done') {
        const last = this.lastText.get(conversationId);
        this.lastText.delete(conversationId);
        // The turn answering James in a chat he does not follow (a bot's standing chat) is pushed once.
        const answersJames = this.db.prepare(
          'UPDATE james_threads SET james_pending_since = NULL, james_answer_turn_id = NULL WHERE conversation_id = ? AND james_answer_turn_id = ?',
        ).run(conversationId, event.turnId).changes > 0;
        if (!last || last.turnId !== event.turnId || !last.markdown.trim()) return;
        const stamped = stampMessage(this.db, {
          conversationId, direction: 'from_veneer', author: 'veneer', via: 'agent',
          sourceRef: `turn:${event.turnId}`, text: last.markdown,
        }, this.deps.now());
        if (!stamped?.inserted || !(isJamesThread(stamped.thread) || answersJames)) return;
        const needsNick = this.newDecisionsNeedingNick(conversationId);
        const actionable: Actionable | null = stamped.asked || getThread(this.db, conversationId)?.status === 'waiting_on_james' ? 'waiting_on_james'
          : needsNick.length ? 'needs_nick'
            : answersJames ? 'answers_james'
              : stamped.thread.started_by === 'james' ? 'james_thread' : null;
        // Progress and status-only replies in a followed thread are recorded, not POSTed.
        this.enqueue(conversationId, 'reply', stamped.turn, {
          author: 'veneer', asks_question: stamped.asked, excerpt: excerpt(last.markdown), answers_james: answersJames, actionable,
          ...(needsNick.length ? { needs_nick: needsNick } : {}),
        }, { suppressed: !actionable });
        if (actionable) void this.flush();
      }
    } catch (err) {
      this.log(`event handling failed for ${conversationId}: ${(err as Error).message}`);
    }
  }

  /** A suppressed event is recorded for the digest with push_id 0 and is never POSTed. */
  enqueue(conversationId: string | null, reason: PushReason, turn: number | null, detail: Record<string, unknown> = {}, opts: { suppressed?: boolean } = {}) {
    this.db.prepare('INSERT INTO james_push_events (conversation_id, reason, turn, detail_json, push_id, disposition, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(conversationId, reason, turn, JSON.stringify(detail), opts.suppressed ? 0 : null, opts.suppressed ? 'suppressed' : null, iso(this.deps.now()));
  }

  /** Decisions in this chat waiting on Nick that no POSTed reply has carried yet. */
  private newDecisionsNeedingNick(conversationId: string): string[] {
    const open = this.db.prepare("SELECT id FROM bot_decisions WHERE conversation_id = ? AND state = 'needs_input' ORDER BY created_at, id")
      .all(conversationId) as { id: string }[];
    const carried = this.db.prepare(
      `SELECT 1 FROM james_push_events e, json_each(e.detail_json, '$.needs_nick') j
        WHERE e.conversation_id = ? AND e.reason = 'reply' AND e.disposition IS NULL AND j.value = ? LIMIT 1`,
    );
    return open.map((d) => d.id).filter((id) => !carried.get(conversationId, id));
  }

  // ── James's actions ───────────────────────────────────────────────────────
  async postReply(idOrPrefix: string, expectedTurn: number | undefined, text: string, via = 'james_api') {
    const id = resolveThreadId(this.db, idOrPrefix);
    const thread = id ? getThread(this.db, id) : undefined;
    if (!id || !thread) return { ok: false as const, status: 404, error: 'thread_not_found' };
    if (thread.status === 'archived' || thread.conversation_archived) {
      return { ok: false as const, status: 409, error: 'thread_archived', current_turn: thread.turn };
    }
    const ref = `${via}:${crypto.randomUUID()}`;
    let stamped;
    try {
      stamped = stampMessage(this.db, {
        conversationId: id, direction: 'to_veneer', author: 'james', via, sourceRef: ref, text, expectedTurn,
      }, this.deps.now())!;
    } catch (err) {
      if (err instanceof StaleTurnError) {
        return { ok: false as const, status: 409, error: 'stale_turn', current_turn: err.currentTurn, expected_turn: expectedTurn };
      }
      throw err;
    }
    const body = `${JAMES_MARKER} · thread ${id} · turn ${stamped.turn}]\nFrom James (direct, no Nick relay): ${text}`;
    try {
      this.db.prepare('UPDATE james_threads SET james_pending_since = ?, james_answer_turn_id = NULL WHERE conversation_id = ?')
        .run(iso(this.deps.now()), id);
      const posted = await this.deps.postToChat(id, body);
      return { ok: true as const, thread_id: id, turn: stamped.turn, thread: this.summary(getThread(this.db, id)!), disposition: posted.disposition ?? 'posted' };
    } catch (err) {
      // Undo the stamp so James can retry at the same turn.
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM james_thread_messages WHERE conversation_id = ? AND source_ref = ?').run(id, ref);
        this.db.prepare('UPDATE james_threads SET turn = turn - 1 WHERE conversation_id = ? AND turn = ?').run(id, stamped.turn);
      })();
      return { ok: false as const, status: 502, error: 'post_failed', detail: (err as Error).message, current_turn: stamped.turn - 1 };
    }
  }

  /** Start a new thread under James's name; he follows it for pushes. */
  async createThread(input: { projectId: string | null; title: string; text: string }) {
    let id: string;
    try {
      id = createJamesConversation(this.db, { projectId: input.projectId, title: input.title });
    } catch (err) {
      if (err instanceof UnknownProjectError) return { ok: false as const, status: 400, error: 'unknown_project' };
      throw err;
    }
    ensureThread(this.db, id, `From James: ${input.text}`);
    this.db.prepare(
      "UPDATE james_threads SET started_by = 'james', started_by_source = 'james', followed = 1, quiet_pushed_at = NULL WHERE conversation_id = ?",
    ).run(id);
    const posted = await this.postReply(id, 0, input.text);
    if (!posted.ok) return posted;
    return { ...posted, status_code: 201 as const };
  }

  bots() {
    return (this.db.prepare(
      `SELECT r.name, r.conversation_id, p.name AS project, b.name AS business_team
         FROM bot_registrations r
         JOIN conversations c ON c.id = r.conversation_id
         LEFT JOIN projects p ON p.id = c.project_id
         LEFT JOIN business_teams b ON b.id = c.business_team_id
        WHERE r.active = 1 AND c.archived = 0
        ORDER BY r.name COLLATE NOCASE`,
    ).all() as { name: string; conversation_id: string; project: string | null; business_team: string | null }[]).map((bot) => {
      const thread = getThread(this.db, bot.conversation_id) ?? ensureThread(this.db, bot.conversation_id);
      return { name: bot.name, project: bot.project, business_team: bot.business_team, ...(thread ? this.summary(thread) : { thread_id: bot.conversation_id }) };
    });
  }

  resolveBot(ref: string): string | null {
    const value = decodeURIComponent(ref).trim();
    const byName = this.db.prepare(
      `SELECT r.conversation_id FROM bot_registrations r JOIN conversations c ON c.id = r.conversation_id
        WHERE r.active = 1 AND c.archived = 0 AND (r.name = ? COLLATE NOCASE OR r.conversation_id = ?)`,
    ).all(value, value) as { conversation_id: string }[];
    if (byName.length === 1) return byName[0]!.conversation_id;
    const id = resolveThreadId(this.db, value);
    return id && this.db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id = ? AND active = 1').get(id) ? id : null;
  }

  async changeStatus(idOrPrefix: string, action: 'close' | 'archive' | 'reopen', expectedTurn?: number) {
    const id = resolveThreadId(this.db, idOrPrefix);
    const thread = id ? getThread(this.db, id) : undefined;
    if (!id || !thread) return { ok: false as const, status: 404, error: 'thread_not_found' };
    if (expectedTurn !== undefined && expectedTurn !== thread.turn) {
      return { ok: false as const, status: 409, error: 'stale_turn', current_turn: thread.turn, expected_turn: expectedTurn };
    }
    if (action === 'archive') {
      const live = await this.deps.statusOf(id).catch(() => 'idle');
      if (live === 'working') return { ok: false as const, status: 409, error: 'thread_working', detail: 'Veneer is mid-reply; close it now and archive after the reply lands.' };
    }
    setStatus(this.db, id, action === 'close' ? 'done' : action === 'archive' ? 'archived' : 'open', this.deps.now());
    return { ok: true as const, thread: this.summary(getThread(this.db, id)!) };
  }

  // ── Periodic work ─────────────────────────────────────────────────────────
  async tick() {
    const now = this.deps.now();
    this.ticks += 1;
    this.syncNewConversations();
    this.queueQuestionNudges(now);
    this.queueQuietThreads(now);
    this.queueHeartbeat(now);
    await this.autoArchive(now);
    if (this.ticks % 60 === 1) pruneIdempotency(this.db, now);
    if (this.ticks % 2 === 1) await this.pollEmailCommands().catch((err: Error) => this.log(`email poll failed: ${err.message}`));
    this.runSpool(now);
    await this.flush();
    if (this.spoolDir && readActive(this.spoolDir)) await this.maybeSendActiveDigest(now);
    else await this.maybeSendDigestEmail(now);
  }

  private get spoolDir() { return this.deps.spoolDir ?? null; }

  /**
   * ERVP spool: the self-check and NATIVE_READY once per process, then the
   * importer every tick, then the cutover gate. Failures are logged and retried
   * next tick; nothing here sends anything.
   */
  runSpool(now: number) {
    const dir = this.spoolDir;
    if (!dir) return;
    const nowIso = iso(now);
    try {
      if (!this.spoolReady) {
        ensureSpoolDirs(dir);
        const check = spoolSelfCheck(this.db, nowIso);
        if (!check.ok) { this.log(`digest spool self-check failed: ${check.error}`); return; }
        writeNativeReady(dir, this.deps.commit ?? null, nowIso);
        this.spoolReady = true;
      }
      const counts = importSpool(this.db, dir, nowIso);
      if (counts.ingested || counts.rejected) this.log(`digest spool: ingested ${counts.ingested}, rejected ${counts.rejected}, duplicate ${counts.duplicate}`);
      const et = etClock(now);
      const firstDate = et.hour * 60 + et.minute < 8 * 60 + 30 ? et.date : etClock(now + 24 * 3_600_000).date;
      const gate = maybeActivate(dir, this.spoolReady, firstDate, nowIso);
      if (gate.activated) this.log(`digest cutover: ACTIVE written, first digest ${firstDate}`);
    } catch (err) {
      this.log(`digest spool failed: ${(err as Error).message}`);
    }
  }

  /** Chats created since the last tick get a row even before their first event. */
  private syncNewConversations() {
    const missing = this.db.prepare(
      `SELECT c.id FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM james_threads t WHERE t.conversation_id = c.id) LIMIT 200`,
    ).all() as { id: string }[];
    const now = iso(this.deps.now());
    for (const { id } of missing) {
      const first = this.db.prepare(
        "SELECT body FROM bot_search_documents WHERE conversation_id = ? AND kind = 'user' ORDER BY at, rowid LIMIT 1",
      ).get(id) as { body: string } | undefined;
      ensureThread(this.db, id, first?.body ?? null);
      this.db.prepare('UPDATE james_threads SET quiet_pushed_at = COALESCE(quiet_pushed_at, ?) WHERE conversation_id = ?').run(now, id);
    }
  }

  private jamesThreads(where: string, ...params: unknown[]): ThreadRow[] {
    return this.db.prepare(
      `SELECT t.*, c.title AS title, c.archived AS conversation_archived
         FROM james_threads t JOIN conversations c ON c.id = t.conversation_id
        WHERE (t.started_by = 'james' OR t.followed = 1) AND ${where}`,
    ).all(...params) as ThreadRow[];
  }

  private queueQuestionNudges(now: number) {
    const due = this.jamesThreads(
      "t.status = 'waiting_on_james' AND t.question_since IS NOT NULL AND t.question_since <= ? AND (t.question_pushed_at IS NULL OR t.question_pushed_at < t.question_since)",
      iso(now - QUESTION_NUDGE_MS),
    );
    for (const t of due) {
      this.enqueue(t.conversation_id, 'question_unanswered', t.turn, { waiting_since: t.question_since });
      this.db.prepare('UPDATE james_threads SET question_pushed_at = ? WHERE conversation_id = ?').run(iso(now), t.conversation_id);
    }
  }

  private queueQuietThreads(now: number) {
    const threshold = quietThresholdMs(now);
    const due = this.jamesThreads(
      "t.status IN ('open', 'waiting_on_james', 'waiting_on_veneer') AND t.last_activity <= ? AND t.last_activity >= ? AND (t.quiet_pushed_at IS NULL OR t.quiet_pushed_at < t.last_activity)",
      iso(now - threshold), iso(now - QUIET_HORIZON_MS),
    );
    for (const t of due) {
      // Quiet is status only: recorded for the digest, not POSTed.
      this.enqueue(t.conversation_id, 'quiet', t.turn, { quiet_since: t.last_activity, quiet_hours: threshold / 3_600_000 }, { suppressed: true });
      this.db.prepare('UPDATE james_threads SET quiet_pushed_at = ? WHERE conversation_id = ?').run(iso(now), t.conversation_id);
    }
  }

  private queueHeartbeat(now: number) {
    const et = etClock(now);
    const minutes = et.hour * 60 + et.minute;
    if (minutes < 8 * 60 + 30 || minutes >= 12 * 60) return;
    if (getState(this.db, 'heartbeat_date') === et.date) return;
    setState(this.db, 'heartbeat_date', et.date);
    this.enqueue(null, 'heartbeat', null, { date: et.date });
  }

  private async autoArchive(now: number) {
    const due = this.db.prepare(
      `SELECT conversation_id FROM james_threads
        WHERE status = 'done' AND last_activity <= ? AND COALESCE(done_at, last_activity) <= ?`,
    ).all(iso(now - AUTO_ARCHIVE_MS), iso(now - AUTO_ARCHIVE_MS)) as { conversation_id: string }[];
    for (const { conversation_id: id } of due) {
      if ((await this.deps.statusOf(id).catch(() => 'idle')) === 'working') continue;
      setStatus(this.db, id, 'archived', now);
      this.log(`auto-archived ${id} after 7 quiet days as done`);
    }
  }

  async pollEmailCommands() {
    const senders = EMAIL_COMMAND_SENDERS.map((s) => `from:${s}`).join(' OR ');
    const messages = await this.deps.mailer.search(`in:inbox newer_than:3d subject:VENEER (${senders})`, 25);
    for (const msg of messages) {
      if (this.db.prepare('SELECT 1 FROM james_email_commands WHERE message_id = ?').get(msg.messageId)) continue;
      const sender = (msg.sender.match(/<([^>]+)>/)?.[1] ?? msg.sender).trim().toLowerCase();
      const parsed = EMAIL_COMMAND_SENDERS.includes(sender) ? parseEmailCommand(msg.subject, msg.text) : null;
      let result = 'ignored';
      let id: string | null = null;
      if (parsed) {
        id = parsed.threadRef ? resolveThreadId(this.db, parsed.threadRef) : null;
        if (!id) result = 'thread_not_found';
        else {
          const changed = await this.changeStatus(id, parsed.command === 'CLOSE' ? 'close' : 'archive');
          result = changed.ok ? (parsed.command === 'CLOSE' ? 'closed' : 'archived') : changed.error;
          // James made this change himself; it is recorded, not POSTed back to him.
          if (changed.ok) this.enqueue(id, 'status_changed', changed.thread.turn, { status: changed.thread.status, via: 'email', email_message_id: msg.messageId }, { suppressed: true });
        }
        // No confirmation email: native sends nothing outside the digest. The result is in james_email_commands and the thread status.
      }
      this.db.prepare('INSERT OR IGNORE INTO james_email_commands (message_id, conversation_id, command, sender, result) VALUES (?, ?, ?, ?, ?)')
        .run(msg.messageId, id, parsed?.command ?? null, sender, result);
    }
  }

  // ── Bot-to-James notification (notify_james) ─────────────────────────────
  /** Readback of a notify_james key for the calling chat only. */
  notification(conversationId: string, key: string): NotifyResult {
    const row = this.db.prepare('SELECT * FROM james_notifications WHERE idempotency_key = ?').get(key) as
      { conversation_id: string; authority_turn: number; ledger_turn: number | null; push_id: number | null } | undefined;
    if (!row || row.conversation_id !== conversationId) return { ok: false, status: 404, error: 'notification_not_found' };
    const push = row.push_id === null ? undefined : this.db.prepare('SELECT status, attempts, emailed_to, last_error FROM james_pushes WHERE id = ?').get(row.push_id) as
      { status: string; attempts: number; emailed_to: string | null; last_error: string | null } | undefined;
    return {
      ok: true, replay: true, idempotency_key: key, thread_id: conversationId, authority_turn: row.authority_turn, ledger_turn: row.ledger_turn, push_id: row.push_id,
      status: push?.status ?? 'not_started', attempts: push?.attempts ?? 0, emailed_to: push?.emailed_to ?? null, last_error: push?.last_error ?? null,
    };
  }

  /**
   * Tell James something from a chat that he does not follow (a bot's standing
   * chat), once, because that chat's own human said to. The cited turn must be
   * a recent human message in this same chat that names James. Delivery is
   * immediate through the webhook; if it fails the push waits for the daily
   * digest email, unless the caller stated an urgent money or customer matter
   * Nick needs today (kind, reason, evidence, needed_on), which is emailed at
   * once. James is not made a follower. A repeated key returns the first result.
   */
  async notifyJames(input: { conversationId: string; text: string; authorityTurn?: number; idempotencyKey: string; urgent?: UrgentNotice }): Promise<NotifyResult> {
    const { conversationId, idempotencyKey: key } = input;
    const text = input.text.trim();
    const textHash = crypto.createHash('sha256').update(text).digest('hex');
    const existing = this.db.prepare('SELECT conversation_id, text_hash FROM james_notifications WHERE idempotency_key = ?').get(key) as
      { conversation_id: string; text_hash: string } | undefined;
    if (existing) {
      if (existing.conversation_id !== conversationId || existing.text_hash !== textHash) {
        return { ok: false, status: 409, error: 'idempotency_conflict', detail: 'This idempotency_key was already used with a different message or chat.' };
      }
      return this.notification(conversationId, key);
    }
    // Without an explicit turn, the latest recent human message in this chat that names James.
    const authorityTurn = input.authorityTurn ?? (this.db.prepare(
      `SELECT turn, excerpt FROM james_thread_messages
        WHERE conversation_id = ? AND direction = 'to_veneer' AND author = 'human' AND at >= ?
        ORDER BY turn DESC LIMIT 50`,
    ).all(conversationId, iso(this.deps.now() - NOTIFY_AUTHORITY_MS)) as { turn: number; excerpt: string }[])
      .find((row) => /\bjames\b/i.test(row.excerpt))?.turn;
    if (authorityTurn === undefined) {
      return { ok: false, status: 403, error: 'authority_not_found', detail: 'No human message in this chat from the last 24 hours names James.' };
    }
    const authority = this.db.prepare(
      'SELECT direction, author, excerpt, at FROM james_thread_messages WHERE conversation_id = ? AND turn = ?',
    ).get(conversationId, authorityTurn) as { direction: string; author: string; excerpt: string; at: string } | undefined;
    if (!authority) return { ok: false, status: 403, error: 'authority_not_found', detail: `Turn ${authorityTurn} is not a message in this chat.` };
    if (authority.direction !== 'to_veneer' || authority.author !== 'human') {
      return { ok: false, status: 403, error: 'authority_not_human', detail: `Turn ${authorityTurn} was written by ${authority.author}; only a human message in this chat can direct telling James.` };
    }
    if (Date.parse(authority.at) < this.deps.now() - NOTIFY_AUTHORITY_MS) {
      return { ok: false, status: 403, error: 'authority_stale', detail: `Turn ${authorityTurn} is older than 24 hours.` };
    }
    if (!/\bjames\b/i.test(authority.excerpt)) {
      return { ok: false, status: 403, error: 'authority_does_not_name_james', detail: `Turn ${authorityTurn} does not mention James.` };
    }
    const now = iso(this.deps.now());
    // Claim the key before any external effect, so a concurrent retry cannot send twice.
    const claimed = this.db.prepare(
      'INSERT OR IGNORE INTO james_notifications (idempotency_key, conversation_id, text_hash, authority_turn, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(key, conversationId, textHash, authorityTurn, now).changes > 0;
    if (!claimed) return this.notifyJames(input);
    const followedBefore = getThread(this.db, conversationId)?.followed ?? 0;
    const stamped = stampMessage(this.db, {
      conversationId, direction: 'from_veneer', author: 'veneer', via: 'notify_james', sourceRef: `notify:${key}`, text,
    }, this.deps.now());
    if (!stamped) return { ok: false, status: 404, error: 'thread_not_found' };
    // Never widen following as a side effect.
    this.db.prepare('UPDATE james_threads SET followed = ? WHERE conversation_id = ?').run(followedBefore, conversationId);
    const event = { reason: 'notify' as const, turn: stamped.turn, created_at: now,
      detail_json: JSON.stringify({
        author: 'veneer', excerpt: excerpt(text), authority_turn: authorityTurn, idempotency_key: key,
        ...(input.urgent ? {
          urgent_for_nick: input.urgent.kind, needs_nick_today: true, urgent_reason: input.urgent.reason,
          urgent_evidence: input.urgent.evidence, needed_on: input.urgent.neededOn,
        } : {}),
      }) };
    const payload = this.threadPayload(conversationId, [event])!;
    const pushId = Number(this.db.prepare(
      "INSERT INTO james_pushes (conversation_id, kind, payload_json, status, created_at) VALUES (?, 'thread', '{}', 'sending', ?)",
    ).run(conversationId, now).lastInsertRowid);
    payload.push_id = pushId;
    this.db.transaction(() => {
      this.db.prepare('UPDATE james_pushes SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), pushId);
      this.db.prepare('INSERT INTO james_push_events (conversation_id, reason, turn, detail_json, push_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(conversationId, 'notify', stamped.turn, event.detail_json, pushId, now);
      this.db.prepare('UPDATE james_notifications SET ledger_turn = ?, push_id = ? WHERE idempotency_key = ?').run(stamped.turn, pushId, key);
    })();
    await this.deliver(pushId, payload, { immediateEmail: !!input.urgent });
    const result = this.notification(conversationId, key);
    return result.ok ? { ...result, replay: false } : result;
  }

  // ── Delivery ──────────────────────────────────────────────────────────────
  flush(options: { force?: boolean; simulateWebhookFailure?: boolean } = {}): Promise<void> {
    const run = async () => {
      if (this.flushing) await this.flushing.catch(() => undefined);
      const job = this.flushOnce(options);
      this.flushing = job;
      try { await job; } finally { if (this.flushing === job) this.flushing = null; }
    };
    return run();
  }

  private async flushOnce(options: { force?: boolean; simulateWebhookFailure?: boolean }) {
    const pending = this.db.prepare(
      'SELECT DISTINCT conversation_id FROM james_push_events WHERE push_id IS NULL',
    ).all() as { conversation_id: string | null }[];
    const now = this.deps.now();
    for (const { conversation_id: id } of pending) {
      const last = this.db.prepare(
        "SELECT MAX(created_at) AS at FROM james_pushes WHERE conversation_id IS ? AND kind <> 'escalation'",
      ).get(id) as { at: string | null };
      const forced = options.force || !!this.db.prepare(
        "SELECT 1 FROM james_push_events WHERE push_id IS NULL AND conversation_id IS ? AND reason IN ('test', 'heartbeat')",
      ).get(id);
      if (!forced && last.at && Date.parse(last.at) > now - PUSH_GAP_MS) continue;
      const events = this.db.prepare(
        'SELECT id, reason, turn, detail_json, created_at FROM james_push_events WHERE push_id IS NULL AND conversation_id IS ? ORDER BY id',
      ).all(id) as { id: number; reason: PushReason; turn: number | null; detail_json: string; created_at: string }[];
      if (!events.length) continue;
      const since = getState(this.db, 'digest_since') ?? iso(now - 24 * 3_600_000);
      const payload = id === null ? this.heartbeatPayload(now, since) : this.threadPayload(id, events);
      if (!payload) {
        this.db.prepare(`UPDATE james_push_events SET push_id = 0 WHERE id IN (${events.map(() => '?').join(',')})`).run(...events.map((e) => e.id));
        continue;
      }
      const pushId = Number(this.db.prepare(
        "INSERT INTO james_pushes (conversation_id, kind, payload_json, status, created_at) VALUES (?, ?, '{}', 'sending', ?)",
      ).run(id, id === null ? 'heartbeat' : 'thread', iso(now)).lastInsertRowid);
      payload.push_id = pushId;
      this.db.prepare('UPDATE james_pushes SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), pushId);
      this.db.prepare(`UPDATE james_push_events SET push_id = ? WHERE id IN (${events.map(() => '?').join(',')})`).run(pushId, ...events.map((e) => e.id));
      if (id === null) setState(this.db, 'digest_since', String(payload.sent_at));
      await this.deliver(pushId, payload, {
        simulateFailure: options.simulateWebhookFailure || events.some((e) => e.reason === 'test' && JSON.parse(e.detail_json).simulate_webhook_failure === true),
      });
    }
  }

  private threadPayload(id: string, events: { reason: PushReason; turn: number | null; detail_json: string; created_at: string }[]) {
    const thread = getThread(this.db, id);
    if (!thread) return null;
    const origin = this.deps.publicOrigin?.replace(/\/$/, '') ?? '';
    return {
      type: 'veneer.thread_update',
      version: 1,
      push_id: 0,
      sent_at: iso(this.deps.now()),
      reasons: [...new Set(events.map((e) => e.reason))],
      thread: this.summary(thread),
      events: events.map((e) => ({ reason: e.reason, turn: e.turn, at: e.created_at, ...JSON.parse(e.detail_json) })),
      reply_with: {
        method: 'POST',
        url: `${origin}/api/james/threads/${id}/reply`,
        body: { expected_turn: thread.turn, text: '<your reply>' },
        close: `${origin}/api/james/threads/${id}/close`,
        archive: `${origin}/api/james/threads/${id}/archive`,
      },
    } as Record<string, unknown> & { push_id: number };
  }

  /** The daily 8:30 AM ET heartbeat, which is also the digest of what was suppressed or undelivered since the last one. */
  heartbeatPayload(now: number, since = iso(now - 24 * 3_600_000)) {
    const pick = (status: string) => listThreads(this.db, { james: true, statuses: [status as never], limit: MAX_LIST });
    const waitingJames = pick('waiting_on_james');
    const waitingVeneer = pick('waiting_on_veneer');
    const open = pick('open');
    const done = pick('done');
    const allOpen = listThreads(this.db, { limit: 1 });
    return {
      type: 'veneer.heartbeat',
      version: 1,
      push_id: 0,
      sent_at: iso(now),
      date: etClock(now).date,
      counts: {
        james_waiting_on_james: waitingJames.total,
        james_waiting_on_veneer: waitingVeneer.total,
        james_open: open.total,
        james_done: done.total,
        all_unarchived_threads: allOpen.total,
      },
      waiting_on_james: waitingJames.threads.map((t) => this.summary(t)),
      waiting_on_veneer: waitingVeneer.threads.map((t) => this.summary(t)),
      open: open.threads.map((t) => this.summary(t)),
      since,
      suppressed: this.suppressedSince(since),
      undelivered: this.undeliveredPushes().map((p) => ({
        push_id: p.id, thread_id: p.conversation_id, title: p.title, kind: p.kind, reasons: p.reasons, created_at: p.created_at, status: p.status, last_error: p.last_error,
      })),
    } as Record<string, unknown> & { push_id: number };
  }

  /** Events recorded but not POSTed since the last digest: counts by reason and the threads they came from. */
  suppressedSince(since: string) {
    const byReason = Object.fromEntries((this.db.prepare(
      "SELECT reason, COUNT(*) AS n FROM james_push_events WHERE disposition = 'suppressed' AND created_at > ? GROUP BY reason ORDER BY reason",
    ).all(since) as { reason: string; n: number }[]).map((r) => [r.reason, r.n]));
    const threads = this.db.prepare(
      `SELECT e.conversation_id AS thread_id, COALESCE(c.title, '(untitled)') AS title, COUNT(*) AS events, MAX(e.turn) AS last_turn,
              GROUP_CONCAT(DISTINCT e.reason) AS reasons
         FROM james_push_events e LEFT JOIN conversations c ON c.id = e.conversation_id
        WHERE e.disposition = 'suppressed' AND e.created_at > ?
        GROUP BY e.conversation_id ORDER BY events DESC, thread_id LIMIT ?`,
    ).all(since, MAX_LIST) as { thread_id: string; title: string; events: number; last_turn: number | null; reasons: string }[];
    return {
      total: Object.values(byReason).reduce((a, b) => a + b, 0),
      by_reason: byReason,
      threads: threads.map((t) => ({ ...t, reasons: t.reasons.split(','), url: this.threadUrl(t.thread_id) })),
    };
  }

  /** Pushes held for the digest email (webhook failed), oldest first. */
  private undeliveredPushes() {
    return (this.db.prepare(
      `SELECT p.id, p.conversation_id, COALESCE(c.title, '(untitled)') AS title, p.kind, p.status, p.payload_json, p.last_error, p.created_at
         FROM james_pushes p LEFT JOIN conversations c ON c.id = p.conversation_id
        WHERE p.status = 'deferred_digest' AND p.digest_date IS NULL ORDER BY p.id`,
    ).all() as { id: number; conversation_id: string | null; title: string; kind: string; status: string; payload_json: string; last_error: string | null; created_at: string }[])
      .map((p) => {
        const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
        return { ...p, payload, reasons: (payload.reasons as string[] | undefined) ?? [p.kind] };
      });
  }

  private async postWebhook(body: string, pushId: number, simulateFailure: boolean): Promise<void> {
    if (simulateFailure) throw new Error('simulated webhook failure (test)');
    const url = this.deps.getSecret('JAMES_WEBHOOK_URL');
    const key = this.deps.getSecret('JAMES_WEBHOOK_KEY');
    if (!url || !key) throw new Error('JAMES_WEBHOOK_URL / JAMES_WEBHOOK_KEY are not in Doppler');
    let target: URL;
    try { target = new URL(url.trim()); } catch { throw new Error('JAMES_WEBHOOK_URL is not a valid URL'); }
    if (target.protocol !== 'https:') throw new Error('JAMES_WEBHOOK_URL must be https');
    const signature = crypto.createHmac('sha256', key).update(body).digest('hex');
    const response = await this.deps.fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'x-veneer-signature': `sha256=${signature}`,
        'idempotency-key': `veneer-james-push-${pushId}`,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // Keep the receiver's own reason (e.g. its rate limit) so last_error explains the failure.
      let detail = '';
      try { detail = (await response.text()).split(key).join('[REDACTED]').replace(/\s+/g, ' ').trim().slice(0, 300); } catch { /* body unreadable */ }
      const requestId = response.headers.get('x-request-id');
      throw new Error(`webhook returned HTTP ${response.status}${requestId ? ` (x-request-id ${requestId})` : ''}${detail ? `: ${detail}` : ''}`);
    }
  }

  /**
   * Two webhook attempts. On failure the push is held as deferred_digest for
   * the next daily digest email, or, with immediateEmail, emailed now (first
   * address, then the second). Never retried after that.
   */
  private async deliver(pushId: number, payload: Record<string, unknown>, opts: { simulateFailure?: boolean; immediateEmail?: boolean }) {
    const body = JSON.stringify(payload);
    const errors: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      this.db.prepare('UPDATE james_pushes SET attempts = ? WHERE id = ?').run(attempt, pushId);
      try {
        await this.postWebhook(body, pushId, !!opts.simulateFailure);
        this.db.prepare("UPDATE james_pushes SET status = 'sent', last_error = NULL, finished_at = ? WHERE id = ?").run(iso(this.deps.now()), pushId);
        setState(this.db, 'webhook_failing_since', null);
        setState(this.db, 'webhook_escalated_at', null);
        return;
      } catch (err) {
        errors.push((err as Error).message);
        if (attempt === 1) await (this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(3_000);
      }
    }
    const lastError = errors.join(' | ').slice(0, 500);
    if (!opts.simulateFailure && !getState(this.db, 'webhook_failing_since')) setState(this.db, 'webhook_failing_since', iso(this.deps.now()));
    if (!opts.immediateEmail) {
      this.db.prepare("UPDATE james_pushes SET status = 'deferred_digest', last_error = ?, finished_at = ? WHERE id = ?")
        .run(lastError, iso(this.deps.now()), pushId);
      return;
    }
    const { subject, text } = this.alertEmail(payload, lastError);
    const sent = await this.sendVerified(subject, text);
    const status = sent.outcome === 'sent' ? 'emailed' : sent.outcome === 'unknown' ? 'email_unknown' : 'failed';
    this.db.prepare('UPDATE james_pushes SET status = ?, last_error = ?, emailed_to = ?, finished_at = ? WHERE id = ?').run(
      status, sent.outcome === 'sent' ? lastError : `${lastError} | ${sent.error}`.slice(0, 1000), sent.outcome === 'sent' ? sent.to : null, iso(this.deps.now()), pushId,
    );
    if (sent.outcome !== 'sent') this.log(`push ${pushId} urgent email ${sent.outcome}: ${sent.error}`);
  }

  /**
   * Send one email to the first alert address, then the second only if the
   * first certainly did not go. An unclear result (an unexpected error or no
   * message id) is checked against Sent; without an exact Sent match it is
   * unknown and nothing more is sent.
   */
  private async sendVerified(subject: string, text: string): Promise<SendOutcome & { to: string | null }> {
    const errors: string[] = [];
    for (const to of ALERT_EMAILS) {
      let unclear: string;
      try {
        const result = await this.deps.mailer.send(to, subject, text);
        if (result.messageId) return { outcome: 'sent', messageId: result.messageId, to };
        unclear = `email to ${to}: no message id`;
      } catch (err) {
        if (err instanceof MailNotSentError) { errors.push(`email to ${to}: ${err.message}`); continue; }
        unclear = `email to ${to}: ${(err as Error).message}`;
      }
      try {
        const hits = await this.deps.mailer.search(`in:sent to:${to} subject:"${subject.replace(/"/g, '')}" newer_than:2d`, 10);
        const hit = hits.find((m) => m.subject.trim() === subject.trim());
        if (hit) return { outcome: 'sent', messageId: hit.messageId, to };
        return { outcome: 'unknown', error: `${unclear}; no exact Sent match`, to };
      } catch (err) {
        return { outcome: 'unknown', error: `${unclear}; Sent check failed: ${(err as Error).message}`, to };
      }
    }
    return { outcome: 'failed', error: errors.join(' | ').slice(0, 1000), to: null };
  }

  /**
   * Before the cutover: the one daily email, after today's 8:30 AM ET heartbeat
   * has finished, sent only when something was held back (pushes whose webhook
   * failed, including the heartbeat itself); a day where the webhook delivered
   * everything gets no email. The date is claimed in james_link_state before
   * the send, so a date is emailed at most once and an unclear send is never
   * repeated.
   */
  async maybeSendDigestEmail(now: number) {
    const et = etClock(now);
    if (getState(this.db, 'heartbeat_date') !== et.date || getState(this.db, 'digest_email_date') === et.date) return;
    const heartbeat = this.todaysHeartbeat(et.date);
    if (!heartbeat || heartbeat.status === 'sending') return;
    setState(this.db, 'digest_email_date', et.date);
    const held = this.undeliveredPushes();
    if (!held.length) { setState(this.db, 'digest_email_result', `${et.date} not_needed`); return; }
    const { subject, text } = this.digestEmail(JSON.parse(heartbeat.payload_json), held.filter((p) => p.id !== heartbeat.id));
    const mark = this.db.prepare("UPDATE james_pushes SET status = ?, emailed_to = ?, digest_date = ?, last_error = COALESCE(?, last_error) WHERE id = ? AND status = 'deferred_digest'");
    const sent = await this.sendVerified(subject, text);
    const status = sent.outcome === 'sent' ? 'emailed' : sent.outcome === 'unknown' ? 'email_unknown' : 'failed';
    const error = sent.outcome === 'sent' ? null : sent.error;
    this.db.transaction(() => { for (const p of held) mark.run(status, sent.to, et.date, error, p.id); })();
    setState(this.db, 'digest_email_result', `${et.date} ${sent.outcome}${sent.to ? ` to ${sent.to}` : ''} (${held.length} pushes)`);
    if (error) this.log(`digest email for ${et.date} ${sent.outcome}: ${error}`);
  }

  private todaysHeartbeat(date: string) {
    return this.db.prepare(
      "SELECT id, status, payload_json FROM james_pushes WHERE kind = 'heartbeat' AND json_extract(payload_json, '$.date') = ? ORDER BY id DESC LIMIT 1",
    ).get(date) as { id: number; status: string; payload_json: string } | undefined;
  }

  /**
   * After the cutover (ACTIVE): exactly one digest per ET date from
   * first_digest_date on, at or after 8:30 AM ET, even when empty. The date is
   * claimed and every waiting item, rejection and held push is assigned to it in
   * one transaction before the send. Sent: receipts become digested. Unknown:
   * never re-sent; its items become digest_unknown and the next digest names it.
   * Both addresses certainly failed: everything is released to the next day.
   */
  async maybeSendActiveDigest(now: number) {
    const dir = this.spoolDir!;
    const active = readActive(dir)!;
    const et = etClock(now);
    const nowIso = iso(now);
    this.settleStuckDigests(now);
    if (et.date < active.first_digest_date || et.hour * 60 + et.minute < 8 * 60 + 30) return;
    if (this.db.prepare('SELECT 1 FROM james_digests WHERE date = ?').get(et.date)) return;
    // Use today's heartbeat (and its suppressed summary) once it has finished; if the heartbeat window passed without one, build it now.
    const heartbeatPush = this.todaysHeartbeat(et.date);
    if (heartbeatPush?.status === 'sending') return;
    if (!heartbeatPush && getState(this.db, 'heartbeat_date') === et.date) return;
    const previous = this.db.prepare('SELECT claimed_at FROM james_digests ORDER BY date DESC LIMIT 1').get() as { claimed_at: string } | undefined;
    const heartbeat = heartbeatPush
      ? JSON.parse(heartbeatPush.payload_json) as Record<string, unknown>
      : this.heartbeatPayload(now, getState(this.db, 'digest_since') ?? previous?.claimed_at ?? iso(now - 24 * 3_600_000));
    const webhook = {
      failing_since: getState(this.db, 'webhook_failing_since'),
      last_error: getState(this.db, 'webhook_failing_since')
        ? (this.db.prepare("SELECT last_error FROM james_pushes WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 1").get() as { last_error: string } | undefined)?.last_error ?? null
        : null,
      deferred: (this.db.prepare("SELECT COUNT(*) AS n FROM james_pushes WHERE status = 'deferred_digest' AND digest_date IS NULL").get() as { n: number }).n,
    };
    const claimed = this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM james_digests WHERE date = ?').get(et.date)) return false;
      this.db.prepare("INSERT INTO james_digests (date, status, claimed_at) VALUES (?, 'sending', ?)").run(et.date, nowIso);
      const items = this.db.prepare(
        `UPDATE james_digest_items SET digest_date = ? WHERE digest_date IS NULL AND state = 'ingested' AND source <> ?`,
      ).run(et.date, CONTRACT_CHECK_SOURCE).changes;
      const pushes = this.db.prepare("UPDATE james_pushes SET digest_date = ? WHERE status = 'deferred_digest' AND digest_date IS NULL").run(et.date).changes;
      const rejected = this.db.prepare('UPDATE james_digest_rejections SET digest_date = ? WHERE digest_date IS NULL').run(et.date).changes;
      this.db.prepare("UPDATE james_digests SET reported_in = ? WHERE status = 'unknown' AND reported_in IS NULL AND date <> ?").run(et.date, et.date);
      this.db.prepare('UPDATE james_digests SET item_count = ?, push_count = ?, rejected_count = ? WHERE date = ?').run(items, pushes, rejected, et.date);
      return true;
    })();
    if (!claimed) return;
    const { subject, text } = this.activeDigestEmail(et.date, heartbeat, webhook, heartbeatPush?.id ?? null);
    const sent = await this.sendVerified(subject, text);
    const finished = iso(this.deps.now());
    const items = this.db.prepare('SELECT key FROM james_digest_items WHERE digest_date = ?').all(et.date) as { key: string }[];
    if (sent.outcome === 'failed') {
      this.db.transaction(() => {
        this.db.prepare("UPDATE james_digests SET status = 'failed', error = ?, finished_at = ? WHERE date = ?").run(sent.error, finished, et.date);
        this.db.prepare("UPDATE james_digest_items SET digest_date = NULL WHERE digest_date = ? AND state = 'ingested'").run(et.date);
        this.db.prepare("UPDATE james_pushes SET digest_date = NULL WHERE digest_date = ? AND status = 'deferred_digest'").run(et.date);
        this.db.prepare('UPDATE james_digest_rejections SET digest_date = NULL WHERE digest_date = ?').run(et.date);
        this.db.prepare('UPDATE james_digests SET reported_in = NULL WHERE reported_in = ?').run(et.date);
      })();
      this.log(`digest ${et.date} failed on both addresses; its items wait for the next digest: ${sent.error}`);
      return;
    }
    const ok = sent.outcome === 'sent';
    const status = ok ? (sent.to === ALERT_EMAILS[0] ? 'sent' : 'fallback') : 'unknown';
    const messageId = ok ? sent.messageId : null;
    this.db.transaction(() => {
      this.db.prepare('UPDATE james_digests SET status = ?, to_address = ?, message_id = ?, error = ?, finished_at = ? WHERE date = ?')
        .run(status, sent.to, messageId, ok ? null : sent.error, finished, et.date);
      this.db.prepare('UPDATE james_digest_items SET state = ?, message_id = ? WHERE digest_date = ?').run(ok ? 'digested' : 'digest_unknown', messageId, et.date);
      this.db.prepare("UPDATE james_pushes SET status = ?, emailed_to = ? WHERE digest_date = ? AND status = 'deferred_digest'")
        .run(ok ? 'emailed' : 'email_unknown', sent.to, et.date);
    })();
    for (const { key } of items) {
      try { writeReceipt(dir, key, { state: ok ? 'digested' : 'digest_unknown', digest_date: et.date, message_id: messageId }, finished); } catch (err) {
        this.log(`digest receipt ${key} not written: ${(err as Error).message}`);
      }
    }
    if (!ok) this.log(`digest ${et.date} outcome unknown; it will not be re-sent: ${sent.error}`);
  }

  /** A claim left 'sending' by a process that died mid-send is unknown: it may have gone, so it is never re-sent. */
  private settleStuckDigests(now: number) {
    const stuck = this.db.prepare("SELECT date FROM james_digests WHERE status = 'sending' AND claimed_at < ?").all(iso(now - DIGEST_STUCK_MS)) as { date: string }[];
    for (const { date } of stuck) {
      const keys = this.db.prepare('SELECT key FROM james_digest_items WHERE digest_date = ?').all(date) as { key: string }[];
      this.db.transaction(() => {
        this.db.prepare("UPDATE james_digests SET status = 'unknown', error = 'process ended during the send', finished_at = ? WHERE date = ?").run(iso(now), date);
        this.db.prepare("UPDATE james_digest_items SET state = 'digest_unknown' WHERE digest_date = ?").run(date);
        this.db.prepare("UPDATE james_pushes SET status = 'email_unknown' WHERE digest_date = ? AND status = 'deferred_digest'").run(date);
      })();
      for (const { key } of keys) {
        try { writeReceipt(this.spoolDir!, key, { state: 'digest_unknown', digest_date: date }, iso(now)); } catch { /* the next digest still names it */ }
      }
      this.log(`digest ${date} was interrupted mid-send; marked unknown`);
    }
  }

  activeDigestEmail(date: string, heartbeat: Record<string, unknown>, webhook: { failing_since: string | null; last_error: string | null; deferred: number }, heartbeatPushId: number | null) {
    type ItemRow = { key: string; source: string; idempotency_key: string; created_at: string; category: string; subject: string; body: string;
      urgent: string | null; needed_on: string | null; reason: string | null; evidence_json: string | null; immediate_json: string | null };
    const items = this.db.prepare(
      `SELECT key, source, idempotency_key, created_at, category, subject, body, urgent, needed_on, reason, evidence_json, immediate_json
         FROM james_digest_items WHERE digest_date = ? ORDER BY created_at, id`,
    ).all(date) as ItemRow[];
    const immediateStatus = (i: ItemRow) => i.immediate_json ? (JSON.parse(i.immediate_json) as { status: string }).status : null;
    const needsCheck = (i: ItemRow) => !!i.urgent && ['failed', 'unknown'].includes(immediateStatus(i) ?? '');
    const ordered = [...items.filter(needsCheck), ...items.filter((i) => i.urgent && !needsCheck(i)), ...items.filter((i) => !i.urgent)];
    const pushes = (this.db.prepare(
      `SELECT p.id, p.kind, p.payload_json, p.last_error, p.created_at FROM james_pushes p WHERE p.digest_date = ? AND p.status = 'deferred_digest' ORDER BY p.id`,
    ).all(date) as { id: number; kind: string; payload_json: string; last_error: string | null; created_at: string }[]).filter((p) => p.id !== heartbeatPushId);
    const rejected = this.db.prepare('SELECT key, reason FROM james_digest_rejections WHERE digest_date = ? ORDER BY rejected_at, key').all(date) as { key: string; reason: string }[];
    const unknown = (this.db.prepare("SELECT date, item_count FROM james_digests WHERE status = 'unknown' AND reported_in = ? ORDER BY date").all(date) as { date: string; item_count: number }[])
      .map((d) => ({ ...d, keys: (this.db.prepare('SELECT key FROM james_digest_items WHERE digest_date = ? ORDER BY id').all(d.date) as { key: string }[]).map((k) => k.key) }));
    const plain = (subject: string) => subject.replace(/^\s*\[VENEER\]\s*/i, '');
    let budget = DIGEST_BODY_BUDGET;
    const full = (text: string) => { if (budget <= 0) return false; budget -= text.length; return true; };

    const lines: string[] = [`Veneer daily digest for ${date} (since ${String(heartbeat.since ?? '')}).`, ''];
    const urgentChecks = ordered.filter(needsCheck);
    if (urgentChecks.length) {
      lines.push(`NEEDS A MANUAL SENT CHECK: ${urgentChecks.length} urgent item(s) whose immediate email failed or is unknown (listed first below).`, '');
    }
    if (unknown.length) {
      lines.push('Earlier digests with an unknown send (never re-sent; please check Sent):');
      for (const d of unknown) lines.push(`  ${d.date}: ${d.item_count} item(s)${d.keys.length ? `, keys ${d.keys.join(', ')}` : ''}`);
      lines.push('');
    }
    lines.push(
      `James webhook: ${webhook.failing_since ? `failing since ${webhook.failing_since}` : 'healthy'}; ${webhook.deferred} push(es) held for this digest${webhook.last_error ? `; last error: ${webhook.last_error}` : ''}`,
      '', `James threads: ${JSON.stringify(heartbeat.counts)}`, '',
    );
    for (const key of ['waiting_on_james', 'waiting_on_veneer', 'open'] as const) {
      const list = (heartbeat[key] as ReturnType<JamesLink['summary']>[]) ?? [];
      lines.push(`${key} (${list.length}):`);
      for (const t of list) lines.push(`  ${t.thread_id} · turn ${t.turn} · ${t.title}`);
      lines.push('');
    }
    const suppressed = heartbeat.suppressed as ReturnType<JamesLink['suppressedSince']> | undefined;
    if (suppressed) {
      lines.push(`Recorded but not pushed (status only): ${suppressed.total} ${JSON.stringify(suppressed.by_reason)}`);
      for (const t of suppressed.threads) lines.push(`  ${t.thread_id} · ${t.events} · ${t.reasons.join(', ')} · ${t.title}`);
      lines.push('');
    }
    lines.push(`ERVP items (${ordered.length}):`, '');
    for (const i of ordered) {
      const immediate = i.immediate_json ? JSON.parse(i.immediate_json) as { status: string; to: string; message_id: string | null } : null;
      const head = `— ${plain(i.subject)} · ${i.source} · key ${i.key}`;
      if (!full(i.body + head)) { lines.push(head); continue; }
      lines.push(head, `  ${i.category} · ${i.created_at}${i.urgent ? ` · URGENT ${i.urgent} needed on ${i.needed_on}` : ''}`);
      if (i.urgent) {
        lines.push(`  reason: ${i.reason}`, `  evidence: ${i.evidence_json}`);
        if (immediate) lines.push(`  immediate email: ${immediate.status} to ${immediate.to}${immediate.message_id ? ` (message ${immediate.message_id})` : ''}${needsCheck(i) ? ' — check Sent; do not resend blindly' : ''}`);
      }
      if (i.body) lines.push(i.body);
      lines.push('');
    }
    if (ordered.length) lines.push('');
    lines.push(`James pushes the webhook did not take (${pushes.length}):`, '');
    for (const p of pushes) {
      const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
      const thread = payload.thread as ReturnType<JamesLink['summary']> | undefined;
      const head = `— push ${p.id} · ${p.created_at} · ${((payload.reasons as string[] | undefined) ?? [p.kind]).join(', ')}${thread ? ` · thread ${thread.thread_id} turn ${thread.turn} · ${thread.title}` : ` · ${p.kind}`}`;
      const excerpts = ((payload.events as Array<Record<string, unknown>> | undefined) ?? []).flatMap((e) => typeof e.excerpt === 'string' ? [e.excerpt] : []);
      if (!full(head + excerpts.join(''))) { lines.push(head); continue; }
      lines.push(head, ...excerpts.map((e) => (e.length > DIGEST_EXCERPT_MAX ? `${e.slice(0, DIGEST_EXCERPT_MAX)}…` : e)), '');
    }
    if (rejected.length) {
      lines.push('', `Rejected spool items (${rejected.length}; not retried, ERVP to correct with a new key):`);
      for (const r of rejected) lines.push(`  ${r.key}: ${r.reason}`);
    }
    lines.push('', 'Reply via the James API with each thread\'s expected_turn, or reply to this email with CLOSE <thread_id> or ARCHIVE <thread_id> as the first line.');
    return { subject: `[VENEER] Daily digest ${date}`, text: lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') };
  }

  digestEmail(heartbeat: Record<string, unknown>, held: ReturnType<JamesLink['undeliveredPushes']>) {
    const date = String(heartbeat.date ?? '');
    const lines: string[] = [`Veneer daily digest for ${date} (since ${String(heartbeat.since ?? '')}).`, '', `Counts: ${JSON.stringify(heartbeat.counts)}`, ''];
    for (const key of ['waiting_on_james', 'waiting_on_veneer', 'open'] as const) {
      const list = (heartbeat[key] as ReturnType<JamesLink['summary']>[]) ?? [];
      lines.push(`${key} (${list.length}):`);
      for (const t of list) lines.push(`  ${t.thread_id} · turn ${t.turn} · ${t.title}`);
      lines.push('');
    }
    const suppressed = heartbeat.suppressed as ReturnType<JamesLink['suppressedSince']> | undefined;
    if (suppressed) {
      lines.push(`Recorded but not pushed (status only): ${suppressed.total} ${JSON.stringify(suppressed.by_reason)}`);
      for (const t of suppressed.threads) lines.push(`  ${t.thread_id} · ${t.events} · ${t.reasons.join(', ')} · ${t.title}`);
      lines.push('');
    }
    lines.push(`Not delivered to the webhook (${held.length}):`, '');
    for (const p of held.slice(0, DIGEST_MAX_PUSHES)) {
      const thread = p.payload.thread as ReturnType<JamesLink['summary']> | undefined;
      lines.push(`— push ${p.id} · ${p.created_at} · ${p.reasons.join(', ')}${thread ? ` · thread ${thread.thread_id} turn ${thread.turn} · ${thread.title}` : ` · ${p.kind}`}`);
      for (const e of (p.payload.events as Array<Record<string, unknown>> | undefined) ?? []) {
        if (typeof e.excerpt === 'string') lines.push(e.excerpt.length > DIGEST_EXCERPT_MAX ? `${e.excerpt.slice(0, DIGEST_EXCERPT_MAX)}…` : e.excerpt);
      }
      if (p.last_error) lines.push(`(webhook: ${p.last_error})`);
      lines.push('');
    }
    if (held.length > DIGEST_MAX_PUSHES) lines.push(`…and ${held.length - DIGEST_MAX_PUSHES} more; read them with GET /api/james/threads.`, '');
    lines.push('Reply via the James API with each thread\'s expected_turn, or reply to this email with CLOSE <thread_id> or ARCHIVE <thread_id> as the first line.');
    return { subject: `[VENEER] Daily digest ${date}`, text: lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') };
  }

  alertEmail(payload: Record<string, unknown>, error: string) {
    const thread = payload.thread as ReturnType<JamesLink['summary']> | undefined;
    const lines: string[] = [];
    let subject: string;
    if (thread) {
      subject = `[VENEER thread ${thread.thread_id}] ${thread.title}`;
      lines.push(
        `Thread: ${thread.title}`,
        `thread_id: ${thread.thread_id}   turn: ${thread.turn}   status: ${thread.status}   started_by: ${thread.started_by}`,
        `Why: ${(payload.reasons as string[]).join(', ')}`,
        thread.url ? `Open: ${thread.url}` : '',
        '',
      );
      for (const e of payload.events as Array<Record<string, unknown>>) {
        lines.push(`— ${e.reason} (turn ${e.turn ?? '-'}, ${e.at})`);
        if (typeof e.excerpt === 'string') lines.push(e.excerpt);
        lines.push('');
      }
      lines.push(`Reply with expected_turn ${thread.turn} via the James API, or reply to this email with CLOSE or ARCHIVE as the first word.`);
    } else {
      subject = `[VENEER] Heartbeat ${String(payload.date ?? '')}`;
      lines.push(`Counts: ${JSON.stringify(payload.counts)}`, '');
      for (const key of ['waiting_on_james', 'waiting_on_veneer', 'open'] as const) {
        const list = (payload[key] as ReturnType<JamesLink['summary']>[]) ?? [];
        lines.push(`${key} (${list.length}):`);
        for (const t of list) lines.push(`  ${t.thread_id} · turn ${t.turn} · ${t.title}`);
        lines.push('');
      }
    }
    lines.push('', `(Sent by email because James's webhook failed twice: ${error})`, '', 'JSON payload:', JSON.stringify(payload, null, 2));
    return { subject, text: lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') };
  }
}
