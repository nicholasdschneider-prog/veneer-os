import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { coordinationOwner } from '../coordination/store.js';
import type { MessageOrigin, TokenUsage, TurnOutcome } from '../runtime/events.js';

/**
 * Token governor: per-bot switches and the honest per-turn ledger.
 *
 * A bot's switches cover its own chat and every lane it owns (bot lane,
 * coordination threads, ticket and task chats). Nothing here ever slows a
 * human-, James- or bot-message-started turn; only background wakes are
 * prechecked, spaced or rotated.
 */

export const DEFAULT_ROTATION_THRESHOLD = 150_000;
/** A rotation only repeats after the fresh session has grown by this much. */
export const ROTATION_REGROWTH_TOKENS = 40_000;
/** An auto budget needs this many earlier days of data before it applies. */
const AUTO_BUDGET_MIN_DAYS = 3;
const AUTO_BUDGET_FLOOR = 20_000_000;
const AUTO_BUDGET_MULTIPLIER = 1.5;
/** One alert to Nick when a bot exceeds its budget on this many of the last seven days. */
const ALERT_DAYS = 3;

export interface GovernorFlags {
  botId: string;
  rotation: boolean;
  precheck: boolean;
  budget: boolean;
  rotationThreshold: number;
  dailyBudgetTokens: number | null;
}

interface GovernorRow {
  conversation_id: string;
  rotation: number;
  precheck: number;
  budget: number;
  rotation_threshold_tokens: number | null;
  daily_budget_tokens: number | null;
}

/** The registered bot whose switches govern this chat (itself or its lane owner). */
export function governingBotId(db: Database.Database, conversationId: string): string {
  return coordinationOwner(db, conversationId);
}

export function governorFlags(db: Database.Database, conversationId: string): GovernorFlags | null {
  const botId = governingBotId(db, conversationId);
  const row = db.prepare(
    `SELECT g.* FROM token_governor_bots g JOIN bot_registrations b ON b.conversation_id = g.conversation_id
     WHERE g.conversation_id = ? AND b.active = 1`,
  ).get(botId) as GovernorRow | undefined;
  if (!row) return null;
  return {
    botId,
    rotation: row.rotation === 1,
    precheck: row.precheck === 1,
    budget: row.budget === 1,
    rotationThreshold: row.rotation_threshold_tokens ?? DEFAULT_ROTATION_THRESHOLD,
    dailyBudgetTokens: row.daily_budget_tokens,
  };
}

export type GovernorEventKind =
  | 'rotation' | 'rotation_deferred' | 'precheck_skip' | 'precheck_wake' | 'precheck_error'
  | 'wake_deferred' | 'wake_coalesced' | 'budget_exceeded' | 'budget_alert';

export function recordGovernorEvent(
  db: Database.Database,
  kind: GovernorEventKind,
  botId: string | null,
  conversationId: string | null,
  detail: Record<string, unknown> = {},
): void {
  db.prepare('INSERT INTO token_governor_events (bot_id, conversation_id, kind, detail_json) VALUES (?, ?, ?, ?)')
    .run(botId, conversationId, kind, JSON.stringify(detail));
}

/** Turn origin classes used by the ledger, the budget and the reports. */
export type TurnOriginClass = 'human' | 'james' | 'automation' | 'routine' | 'wakeup' | 'agent' | 'result_reply' | 'build' | 'spare';

export function classifyTurnOrigin(input: {
  origin?: MessageOrigin;
  promptText: string;
  channel: string;
  wakeKey: string | null;
}): TurnOriginClass {
  const { origin } = input;
  if (origin?.spareRunId) return 'spare';
  if (!origin) {
    if (input.promptText.startsWith('[James link')) return 'james';
    return input.channel === 'automation' ? 'automation' : 'human';
  }
  if (origin.kind === 'build_queue') return 'build';
  if (origin.kind === 'agent') return 'agent';
  if (origin.kind === 'result_reply') return 'result_reply';
  if (origin.humanTaskNote) return 'human';
  return input.wakeKey?.startsWith('bot-routine:') ? 'routine' : 'wakeup';
}

/** Background work is the only work the governor may slow. */
export function isBackgroundOrigin(origin: TurnOriginClass): boolean {
  return origin === 'routine' || origin === 'wakeup' || origin === 'automation' || origin === 'spare';
}

export function recordTurnUsage(db: Database.Database, input: {
  conversationId: string;
  turnId: string;
  origin: TurnOriginClass;
  wakeKey: string | null;
  provider: string;
  outcome: TurnOutcome | undefined;
  usage: TokenUsage | undefined;
  startedAt: Date;
  finishedAt: Date;
}): void {
  const usage = input.usage;
  // Claude reports input/output per turn directly; Codex adds turn totals.
  const inputTokens = usage?.totalInputTokens ?? usage?.inputTokens ?? 0;
  const outputTokens = usage?.totalOutputTokens ?? usage?.outputTokens ?? 0;
  db.prepare(
    `INSERT OR IGNORE INTO turn_token_usage
      (conversation_id, bot_id, turn_id, origin, wake_key, provider, outcome, context_tokens,
       input_tokens, cached_input_tokens, output_tokens, model_calls, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.conversationId,
    governingBotIdIfBot(db, input.conversationId),
    input.turnId,
    input.origin,
    input.wakeKey,
    input.provider,
    input.outcome ?? null,
    usage?.inputTokens ?? null,
    inputTokens,
    usage?.cachedInputTokens ?? null,
    outputTokens,
    usage?.modelCalls ?? null,
    input.startedAt.toISOString(),
    input.finishedAt.toISOString(),
  );
}

function governingBotIdIfBot(db: Database.Database, conversationId: string): string | null {
  const owner = governingBotId(db, conversationId);
  return db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id = ?').get(owner) ? owner : null;
}

/** Tokens processed by a bot (all its chats) since a point in time. */
export function botTokensSince(db: Database.Database, botId: string, since: Date): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total FROM turn_token_usage
     WHERE bot_id = ? AND finished_at >= ?`,
  ).get(botId, since.toISOString()) as { total: number };
  return row.total;
}

/** Earlier whole UTC days' totals for a bot, newest first (excludes today). */
function dailyTotals(db: Database.Database, botId: string, now: Date, days: number): number[] {
  const today = now.toISOString().slice(0, 10);
  const rows = db.prepare(
    `SELECT substr(finished_at, 1, 10) AS day, SUM(input_tokens + output_tokens) AS total
     FROM turn_token_usage WHERE bot_id = ? AND substr(finished_at, 1, 10) < ? AND finished_at >= ?
     GROUP BY day ORDER BY day DESC`,
  ).all(botId, today, new Date(now.getTime() - (days + 1) * 86_400_000).toISOString()) as { day: string; total: number }[];
  return rows.slice(0, days).map((row) => row.total);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The bot's daily budget: its explicit setting, else 1.5x the median of its
 * last seven measured days (never below 20M), else none until three days exist.
 * Self-managing: the budget follows the bot's own normal load.
 */
export function effectiveDailyBudget(db: Database.Database, flags: GovernorFlags, now = new Date()): number | null {
  if (!flags.budget) return null;
  if (flags.dailyBudgetTokens) return flags.dailyBudgetTokens;
  const history = dailyTotals(db, flags.botId, now, 7);
  if (history.length < AUTO_BUDGET_MIN_DAYS) return null;
  return Math.max(AUTO_BUDGET_FLOOR, Math.round(median(history) * AUTO_BUDGET_MULTIPLIER));
}

/** True while the bot's rolling 24 hours exceed its budget. Records one event per day. */
export function overBudget(db: Database.Database, flags: GovernorFlags | null, now = new Date()): boolean {
  if (!flags?.budget) return false;
  const budget = effectiveDailyBudget(db, flags, now);
  if (!budget) return false;
  const used = botTokensSince(db, flags.botId, new Date(now.getTime() - 86_400_000));
  if (used <= budget) return false;
  const day = now.toISOString().slice(0, 10);
  const recorded = db.prepare(
    "SELECT 1 FROM token_governor_events WHERE bot_id = ? AND kind = 'budget_exceeded' AND substr(at, 1, 10) = ?",
  ).get(flags.botId, day);
  if (!recorded) {
    recordGovernorEvent(db, 'budget_exceeded', flags.botId, null, { used, budget, day });
    maybeAlertRepeatedOverrun(db, flags.botId, now);
  }
  return true;
}

/**
 * One alert per bot per week, only when it exceeded its budget on three or
 * more of the last seven days. The chief of staff briefs Nick; nothing else
 * is interrupted and no card is raised.
 */
function maybeAlertRepeatedOverrun(db: Database.Database, botId: string, now: Date): void {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const days = db.prepare(
    "SELECT COUNT(DISTINCT substr(at, 1, 10)) AS n FROM token_governor_events WHERE bot_id = ? AND kind = 'budget_exceeded' AND at >= ?",
  ).get(botId, weekAgo) as { n: number };
  if (days.n < ALERT_DAYS) return;
  if (db.prepare("SELECT 1 FROM token_governor_events WHERE bot_id = ? AND kind = 'budget_alert' AND at >= ?").get(botId, weekAgo)) return;
  const chief = db.prepare(
    `SELECT s.conversation_id, c.user_id FROM chief_of_staff_bots s JOIN conversations c ON c.id = s.conversation_id
     JOIN bot_registrations b ON b.conversation_id = s.conversation_id WHERE b.active = 1 AND c.archived = 0 LIMIT 1`,
  ).get() as { conversation_id: string; user_id: number } | undefined;
  const bot = db.prepare('SELECT name FROM bot_registrations WHERE conversation_id = ?').get(botId) as { name: string } | undefined;
  const name = bot?.name ?? 'A bot';
  recordGovernorEvent(db, 'budget_alert', botId, chief?.conversation_id ?? null, { days: days.n, delivered: Boolean(chief) });
  if (!chief) return;
  const key = `token-governor-alert:${botId}:${now.toISOString().slice(0, 10)}`;
  db.prepare(
    `INSERT OR IGNORE INTO conversation_wakeups (id, conversation_id, actor_user_id, wake_key, reason, scheduled_for)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    chief.conversation_id,
    chief.user_id,
    key,
    `Token governor note for Nick (include once in his next digest; no card, no call): ${name} went over its normal daily token use on ${days.n} of the last 7 days. Its background routines are already being slowed automatically; human, customer and shipping work is untouched. Nothing is needed from Nick unless he wants it looked at.`,
    now.toISOString(),
  );
}
