import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ConversationRow, ConversationWakeupRow } from '../db/db.js';
import { governorFlags, overBudget, recordGovernorEvent, type GovernorFlags } from './store.js';

/**
 * Cheap deterministic checks before a background wake reaches the model.
 *
 * - A scheduled routine with a configured precheck runs the model only when its
 *   source changed since the last check, at a forced slot, or when the last
 *   full run is older than its limit (2-4 h). Every probe error wakes.
 * - A self-scheduled wake that keeps firing on the same key with nothing new
 *   arriving is spaced out; customer, shipping and deadline wakes never are.
 * - A wake identical to one already queued and not yet started is coalesced.
 *
 * Event wakes (decision answers, customer replies, huddle posts, handoffs) and
 * anything a human started always pass straight through.
 */

const SecretRef = z.object({ name: z.string().min(1), project: z.string().min(1), config: z.string().min(1) });
const ForceSlots = z.object({
  /** 0 = Sunday … 6 = Saturday, in the routine's time zone. */
  weekdays: z.array(z.number().int().min(0).max(6)).min(1),
  times: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1),
});
const Common = { maxSkipMinutes: z.number().int().min(30).max(240).default(180), forceSlots: ForceSlots.optional() };
export const PrecheckConfig = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('http_json'), urls: z.array(z.string().url()).min(1).max(5), secret: SecretRef.optional(), ...Common }),
  z.object({ kind: z.literal('gmail'), connectorIds: z.array(z.number().int().positive()).min(1).max(6), query: z.string().min(1), ...Common }),
  z.object({
    kind: z.literal('local'),
    huddleIds: z.array(z.string()).default([]),
    scheduledTaskIds: z.array(z.string()).default([]),
    decisionsOf: z.string().optional(),
    ...Common,
  }),
]);
export type PrecheckConfig = z.infer<typeof PrecheckConfig>;

export type GateDecision =
  | { action: 'deliver' }
  | { action: 'wait' }
  | { action: 'skip'; reason: string }
  | { action: 'coalesce'; reason: string }
  | { action: 'defer'; until: Date; reason: string };

export interface ComposioExecute {
  (apiKey: string, sessionId: string, slug: string, args: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown; successful?: boolean }>;
}

export interface WakeGovernorDeps {
  db: Database.Database;
  readSecret: (ref: { name: string; project: string; config: string }) => Promise<string>;
  composioApiKey: () => string | null;
  composioExecute?: ComposioExecute;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  probeTimeoutMs?: number;
}

/** Wakes whose arrival is itself the news. They are never prechecked or spaced. */
const EVENT_WAKE_PREFIXES = [
  'bot-decision:', 'cs-ticket:', 'huddle:', 'decision-handoff:', 'question-recheck:', 'message-thread:',
  'autoship-candidate:', 'browser-capacity:', 'bot-task:', 'stale:', 'room:', 'token-governor-alert:',
];
/** Customer, shipping and deadline work is never slowed. */
const NEVER_SPACE = /ship|label|track|deliver|carrier|customer|refund|return|cancel|deadline|urgent|tender|void|purchase|payment/i;
const REPEAT_WINDOW_MS = 3 * 3_600_000;
const REPEAT_MIN_DELIVERIES = 3;
const SPACING_MS = 30 * 60_000;
const SPACING_OVER_BUDGET_MS = 60 * 60_000;
const OVER_BUDGET_MAX_SKIP_MINUTES = 240;
/** Response fields that change without anything new happening. */
const VOLATILE_KEY = /^(now|generatedAt|generated_at|fetchedAt|fetched_at|serverTime|server_time|requestId|request_id|age\w*|\w*Ago|elapsed\w*|expiresAt|expires_at)$/i;

type ProbeResult = { ok: true; signature: string } | { ok: false; error: string };

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (!VOLATILE_KEY.test(key)) out[key] = stripVolatile((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Local weekday (0-6) and HH:MM of an instant in a time zone. */
export function localSlot(at: Date, timeZone: string): { weekday: number; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { weekday, time: `${get('hour')}:${get('minute')}` };
}

async function defaultComposioExecute(
  apiKey: string, sessionId: string, slug: string, args: Record<string, unknown>,
): Promise<{ data?: unknown; error?: unknown; successful?: boolean }> {
  const { Composio } = await import('@composio/core');
  const session = await new Composio({ apiKey, allowTracking: false }).sessions.use(sessionId);
  return session.execute(slug, args);
}

export function createWakeGovernor(deps: WakeGovernorDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const composioExecute = deps.composioExecute ?? defaultComposioExecute;
  const timeoutMs = deps.probeTimeoutMs ?? 20_000;
  const probes = new Map<string, { startedAt: number; result?: ProbeResult }>();

  async function withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('probe timed out')), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function probeHttp(config: Extract<PrecheckConfig, { kind: 'http_json' }>): Promise<string> {
    const token = config.secret ? await deps.readSecret(config.secret) : null;
    const bodies: unknown[] = [];
    for (const url of config.urls) {
      const res = await fetchImpl(url, {
        headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bodies.push(stripVolatile(await res.json()));
    }
    return hash(bodies);
  }

  async function probeGmail(config: Extract<PrecheckConfig, { kind: 'gmail' }>): Promise<string> {
    const apiKey = deps.composioApiKey();
    if (!apiKey) throw new Error('Composio is not configured');
    const perMailbox: string[][] = [];
    for (const id of config.connectorIds) {
      const row = db.prepare("SELECT config_json FROM user_connectors WHERE id = ? AND connector_slug = 'gmail' AND status = 'connected'")
        .get(id) as { config_json: string } | undefined;
      if (!row) throw new Error(`Gmail connector ${id} is not connected`);
      const sessionId = (JSON.parse(row.config_json) as { sessionId?: unknown }).sessionId;
      if (typeof sessionId !== 'string' || !sessionId) throw new Error(`Gmail connector ${id} needs reconnecting`);
      const result = await composioExecute(apiKey, sessionId, 'GMAIL_FETCH_EMAILS', {
        query: config.query, max_results: 50, ids_only: true, include_payload: false, verbose: false, user_id: 'me',
      });
      if (result.successful === false || result.error) throw new Error(`Gmail connector ${id} read failed`);
      const data = result.data as { messages?: unknown; data?: unknown } | undefined;
      const list = Array.isArray(data?.messages) ? data.messages : Array.isArray(data?.data) ? data.data : null;
      // An unrecognized shape is an error, never an empty inbox: it must wake.
      if (!list) throw new Error(`Gmail connector ${id} returned no message list`);
      const ids = (list as Record<string, unknown>[])
        .map((message) => String(message.messageId ?? message.id ?? ''))
        .filter(Boolean)
        .sort();
      perMailbox.push(ids);
    }
    return hash(perMailbox);
  }

  function probeLocal(config: Extract<PrecheckConfig, { kind: 'local' }>): string {
    const huddles = config.huddleIds.map((id) =>
      db.prepare('SELECT MAX(seq) AS seq FROM huddle_messages WHERE huddle_id = ?').get(id));
    const runs = config.scheduledTaskIds.map((id) =>
      db.prepare(
        'SELECT id, status, finished_at FROM scheduled_task_runs WHERE scheduled_task_id = ? ORDER BY started_at DESC LIMIT 1',
      ).get(id) ?? null);
    const decisions = config.decisionsOf
      ? db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM bot_decisions WHERE conversation_id = ?').get(config.decisionsOf)
      : null;
    return hash({ huddles, runs, decisions });
  }

  function startProbe(wakeupId: string, config: PrecheckConfig): void {
    const entry: { startedAt: number; result?: ProbeResult } = { startedAt: Date.now() };
    probes.set(wakeupId, entry);
    const run = async (): Promise<string> => {
      if (config.kind === 'http_json') return probeHttp(config);
      if (config.kind === 'gmail') return probeGmail(config);
      return probeLocal(config);
    };
    void withTimeout(run()).then(
      (signature) => { entry.result = { ok: true, signature }; },
      // Only the message is kept; never a response body or credential.
      (err: unknown) => { entry.result = { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'probe failed' }; },
    );
  }

  function coalesced(row: ConversationWakeupRow): boolean {
    return Boolean(db.prepare(
      `SELECT 1 FROM queued_messages q
       JOIN hub_inbound_messages h ON h.message_id = q.id AND h.conversation_id = q.conversation_id AND h.source_kind = 'wakeup'
       JOIN conversation_wakeups w ON h.idempotency_key = 'wakeup:' || w.id
       WHERE w.conversation_id = ? AND w.id <> ? AND w.wake_key = ? AND w.reason = ?`,
    ).get(row.conversation_id, row.id, row.wake_key, row.reason));
  }

  function routineGate(row: ConversationWakeupRow, flags: GovernorFlags): GateDecision {
    const routineId = row.wake_key.split(':')[1] ?? '';
    const routine = db.prepare("SELECT id, kind, timezone FROM bot_routines WHERE id = ? AND kind = 'schedule'")
      .get(routineId) as { id: string; kind: string; timezone: string | null } | undefined;
    if (!routine) return { action: 'deliver' };
    const stored = db.prepare('SELECT * FROM routine_prechecks WHERE routine_id = ?').get(routine.id) as
      | { config_json: string; last_signature: string | null; last_full_run_at: string | null }
      | undefined;
    if (!stored) return { action: 'deliver' };
    const parsed = PrecheckConfig.safeParse(JSON.parse(stored.config_json));
    if (!parsed.success) {
      recordGovernorEvent(db, 'precheck_error', flags.botId, row.conversation_id, { routineId, error: 'invalid precheck config' });
      return { action: 'deliver' };
    }
    const config = parsed.data;
    const probe = probes.get(row.id);
    if (!probe) {
      startProbe(row.id, config);
      return { action: 'wait' };
    }
    if (!probe.result) {
      // A hung probe must not hold the routine: wake once it outlives the timeout.
      if (Date.now() - probe.startedAt < timeoutMs + 5_000) return { action: 'wait' };
      probe.result = { ok: false, error: 'probe timed out' };
    }
    probes.delete(row.id);
    const at = now();
    const result = probe.result;
    const fullRun = (reason: string, signature: string | null): GateDecision => {
      db.prepare(
        `UPDATE routine_prechecks SET last_signature = COALESCE(?, last_signature), last_checked_at = ?, last_full_run_at = ?
         WHERE routine_id = ?`,
      ).run(signature, at.toISOString(), at.toISOString(), routine.id);
      recordGovernorEvent(db, result.ok ? 'precheck_wake' : 'precheck_error', flags.botId, row.conversation_id, {
        routineId, reason, ...(result.ok ? {} : { error: result.error }),
      });
      return { action: 'deliver' };
    };
    if (!result.ok) return fullRun('probe_failed', null);
    if (!stored.last_full_run_at) return fullRun('first_run', result.signature);
    if (result.signature !== stored.last_signature) return fullRun('changed', result.signature);
    const delivery = db.prepare('SELECT event_id FROM bot_routine_deliveries WHERE wakeup_id = ?').get(row.id) as { event_id: string } | undefined;
    const slotAt = delivery?.event_id.startsWith('schedule:') ? new Date(delivery.event_id.slice('schedule:'.length)) : at;
    if (config.forceSlots && !Number.isNaN(slotAt.getTime())) {
      const slot = localSlot(slotAt, routine.timezone || 'America/Indiana/Indianapolis');
      if (config.forceSlots.weekdays.includes(slot.weekday) && config.forceSlots.times.includes(slot.time)) {
        return fullRun('forced_slot', result.signature);
      }
    }
    const maxSkip = overBudget(db, flags, at) ? Math.max(config.maxSkipMinutes, OVER_BUDGET_MAX_SKIP_MINUTES) : config.maxSkipMinutes;
    if (at.getTime() - Date.parse(stored.last_full_run_at) >= maxSkip * 60_000) return fullRun('max_skip_reached', result.signature);
    db.prepare('UPDATE routine_prechecks SET last_checked_at = ? WHERE routine_id = ?').run(at.toISOString(), routine.id);
    recordGovernorEvent(db, 'precheck_skip', flags.botId, row.conversation_id, { routineId, lastFullRunAt: stored.last_full_run_at });
    return { action: 'skip', reason: 'nothing new since the last run' };
  }

  function repeatGate(row: ConversationWakeupRow, flags: GovernorFlags): GateDecision {
    if (NEVER_SPACE.test(row.wake_key) || NEVER_SPACE.test(row.reason)) return { action: 'deliver' };
    const at = now();
    const recent = db.prepare(
      `SELECT delivered_at FROM conversation_wakeups WHERE conversation_id = ? AND wake_key = ? AND status = 'delivered'
         AND delivered_at >= ? ORDER BY delivered_at DESC`,
    ).all(row.conversation_id, row.wake_key, new Date(at.getTime() - REPEAT_WINDOW_MS).toISOString()) as { delivered_at: string }[];
    if (recent.length < REPEAT_MIN_DELIVERIES) return { action: 'deliver' };
    const last = recent[0]!.delivered_at;
    const spacing = overBudget(db, flags, at) ? SPACING_OVER_BUDGET_MS : SPACING_MS;
    const until = new Date(Date.parse(last) + spacing);
    if (until.getTime() <= at.getTime()) return { action: 'deliver' };
    // Anything new for this bot since the last delivery wakes it right away.
    const family = [row.conversation_id, ...(db.prepare('SELECT conversation_id FROM coordination_lanes WHERE owner_id = ?')
      .all(row.conversation_id) as { conversation_id: string }[]).map((lane) => lane.conversation_id)];
    const marks = family.map(() => '?').join(',');
    const lastSql = last.replace('T', ' ').slice(0, 19);
    const news = db.prepare(
      `SELECT 1 FROM hub_inbound_messages WHERE conversation_id IN (${marks}) AND source_kind = 'hub' AND created_at > ?
       UNION ALL SELECT 1 FROM bot_decisions WHERE conversation_id = ? AND updated_at > ?
       UNION ALL SELECT 1 FROM conversation_wakeups WHERE conversation_id = ? AND wake_key <> ? AND status = 'delivered' AND delivered_at > ?
         AND (${EVENT_WAKE_PREFIXES.map(() => 'wake_key LIKE ?').join(' OR ')})
       LIMIT 1`,
    ).get(...family, lastSql, row.conversation_id, lastSql, row.conversation_id, row.wake_key, last,
      ...EVENT_WAKE_PREFIXES.map((prefix) => `${prefix}%`));
    if (news) return { action: 'deliver' };
    return { action: 'defer', until, reason: `fired ${recent.length} times in 3 hours with nothing new` };
  }

  return {
    /** Synchronous decision for one due wake; probes run in the background between ticks. */
    gate(row: ConversationWakeupRow, conv: ConversationRow): GateDecision {
      // Forget probes for wakes that were cancelled or fired elsewhere meanwhile.
      for (const [id, probe] of probes) if (Date.now() - probe.startedAt > 10 * 60_000) probes.delete(id);
      try {
        const flags = governorFlags(db, conv.id);
        if (!flags?.precheck) return { action: 'deliver' };
        if (coalesced(row)) {
          recordGovernorEvent(db, 'wake_coalesced', flags.botId, conv.id, { wakeKey: row.wake_key });
          return { action: 'coalesce', reason: 'an identical wake is already waiting to run' };
        }
        if (row.wake_key.startsWith('bot-routine:')) return routineGate(row, flags);
        if (EVENT_WAKE_PREFIXES.some((prefix) => row.wake_key.startsWith(prefix))) return { action: 'deliver' };
        const decision = repeatGate(row, flags);
        if (decision.action === 'defer') {
          recordGovernorEvent(db, 'wake_deferred', flags.botId, conv.id, { wakeKey: row.wake_key, until: decision.until.toISOString() });
        }
        return decision;
      } catch {
        // Fail open: the governor must never be the reason a wake is lost.
        probes.delete(row.id);
        return { action: 'deliver' };
      }
    },
  };
}

export type WakeGovernor = ReturnType<typeof createWakeGovernor>;
