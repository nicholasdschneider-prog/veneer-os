import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { sanitizeMemoryText } from '../memory/capture.js';
import type { ConversationEvent } from '../runtime/events.js';
import { overBudget, recordGovernorEvent, type GovernorFlags } from './store.js';

/** Providers whose native session can be replaced by a fresh one with a handoff. */
const ROTATING_PROVIDERS = new Set(['codex', 'claude']);
/** Turns the fresh session must run before it may rotate again. */
const MIN_TURNS_BETWEEN_ROTATIONS = 3;
const OWNER_DIRECTION_DAYS = 14;
const OWNER_DIRECTION_LIMIT = 12;
const RECENT_EXCERPT_CHARS = 24_000;
/** A reply that leaves an effect unresolved blocks rotation until it is settled. */
const UNRESOLVED_EFFECT = /outcome[_ ]unknown|\bunknown (?:effect|outcome|send|state|result)\b|\b(?:is|remains|still|marked|left) UNKNOWN\b|uncertain (?:send|refund|purchase|effect)/i;

export interface RotationCheck {
  rotate: boolean;
  reason: string;
  threshold: number;
}

/**
 * Whether a governed chat should start its next turn in a fresh native session.
 * Called only at a turn boundary, after the previous turn fully finished.
 */
export function rotationCheck(db: Database.Database, input: {
  conversationId: string;
  provider: string;
  contextTokens: number | null;
  flags: GovernorFlags | null;
  firstTurn: boolean;
  recentEvents?: ConversationEvent[];
  now?: Date;
}): RotationCheck {
  const flags = input.flags;
  const base = flags?.rotationThreshold ?? 0;
  if (!flags?.rotation) return { rotate: false, reason: 'off', threshold: base };
  // Over budget, background-heavy chats rotate a little earlier.
  const threshold = overBudget(db, flags, input.now) ? Math.round(base * 0.75) : base;
  if (!ROTATING_PROVIDERS.has(input.provider)) return { rotate: false, reason: 'provider', threshold };
  if (input.firstTurn) return { rotate: false, reason: 'fresh', threshold };
  if (!input.contextTokens || input.contextTokens < threshold) return { rotate: false, reason: 'below_threshold', threshold };
  const last = db.prepare(
    'SELECT outcome FROM turn_token_usage WHERE conversation_id = ? ORDER BY finished_at DESC, id DESC LIMIT 1',
  ).get(input.conversationId) as { outcome: string | null } | undefined;
  // An interrupted, failed or unrecorded turn may have left an effect in flight.
  if (last?.outcome !== 'completed') return { rotate: false, reason: 'previous_turn_not_completed', threshold };
  const lastRotation = db.prepare(
    "SELECT at FROM token_governor_events WHERE conversation_id = ? AND kind = 'rotation' ORDER BY id DESC LIMIT 1",
  ).get(input.conversationId) as { at: string } | undefined;
  if (lastRotation) {
    const turns = db.prepare('SELECT COUNT(*) AS n FROM turn_token_usage WHERE conversation_id = ? AND finished_at > ?')
      .get(input.conversationId, lastRotation.at) as { n: number };
    if (turns.n < MIN_TURNS_BETWEEN_ROTATIONS) return { rotate: false, reason: 'recently_rotated', threshold };
  }
  if (unresolvedBrowserEffect(db, input.conversationId)) return { rotate: false, reason: 'unknown_browser_effect', threshold };
  if (input.recentEvents && unresolvedEffectInReplies(input.recentEvents)) {
    return { rotate: false, reason: 'unknown_effect_in_reply', threshold };
  }
  return { rotate: true, reason: 'over_threshold', threshold };
}

function unresolvedBrowserEffect(db: Database.Database, conversationId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM browser_controller_recovery u WHERE u.conversation_id = ? AND u.outcome = 'unknown'
       AND u.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
       AND NOT EXISTS (SELECT 1 FROM browser_controller_recovery v WHERE v.conversation_id = u.conversation_id
         AND v.request_key = u.request_key AND v.outcome = 'read_verified')`,
  ).get(conversationId));
}

/** The last two replies say an effect is still unresolved. */
export function unresolvedEffectInReplies(events: ConversationEvent[]): boolean {
  const finals = events.filter((event): event is Extract<ConversationEvent, { type: 'text_final' }> => event.type === 'text_final');
  return finals.slice(-2).some((event) => UNRESOLVED_EFFECT.test(event.markdown));
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function isOwnerDirection(event: Extract<ConversationEvent, { type: 'turn_started' }>): boolean {
  if (!event.origin) return true;
  return Boolean(event.origin.humanTaskNote);
}

/** Order numbers and six-character ticket codes mentioned in the record. */
export function referencedIds(record: string): { orders: string[]; tickets: string[] } {
  const orders = new Set(record.match(/\b100\d{6}\b/g) ?? []);
  const tickets = new Set(
    (record.match(/\b[A-Z0-9]{6}\b/g) ?? []).filter((code) => /[A-Z]/.test(code) && /\d/.test(code)),
  );
  return { orders: [...orders].slice(-40), tickets: [...tickets].slice(-40) };
}

/**
 * The structured handoff a rotated session starts with. The full redacted
 * record stays on disk; the prompt carries open work, owner directions, ids
 * and a recent excerpt, so the fresh session starts small but informed.
 */
export function writeRotationHandoff(db: Database.Database, input: {
  cwd: string;
  conversationId: string;
  botId: string;
  events: ConversationEvent[];
  previousContextTokens: number;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const lines: string[] = [];
  for (const event of input.events) {
    if (event.type === 'turn_started') {
      lines.push(`User${event.origin ? ` (${event.origin.kind}: ${event.origin.from})` : ''} at ${event.at}:\n${sanitizeMemoryText(event.text)}`);
    } else if (event.type === 'text_final') {
      lines.push(`Assistant:\n${sanitizeMemoryText(event.markdown)}`);
    } else if (event.type === 'notice' || event.type === 'error') {
      lines.push(`Status: ${sanitizeMemoryText(event.message)}`);
    } else if (event.type === 'tool_started') {
      lines.push(`Tool attempted: ${sanitizeMemoryText(event.displayName)}. Verify its outcome before repeating it.`);
    }
  }
  const record = lines.join('\n\n');
  const folder = path.join(input.cwd, '.veneer', 'provider-context', input.conversationId);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `rotation-${now.toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.md`);
  fs.writeFileSync(file, record, { mode: 0o600, flag: 'wx' });

  const since = new Date(now.getTime() - OWNER_DIRECTION_DAYS * 86_400_000).toISOString();
  const directions = input.events
    .filter((event): event is Extract<ConversationEvent, { type: 'turn_started' }> => event.type === 'turn_started')
    .filter((event) => isOwnerDirection(event) && event.at >= since)
    .slice(-OWNER_DIRECTION_LIMIT)
    .map((event) => `- ${event.at}: ${clip(sanitizeMemoryText(event.text).replace(/\s+/g, ' '), 1_200)}`);

  const wakeups = db.prepare(
    `SELECT wake_key, scheduled_for, reason FROM conversation_wakeups
     WHERE conversation_id IN (?, ?) AND status = 'pending' ORDER BY scheduled_for LIMIT 25`,
  ).all(input.conversationId, input.botId) as { wake_key: string; scheduled_for: string; reason: string }[];
  const decisions = db.prepare(
    `SELECT id, state, version, proposal_json FROM bot_decisions
     WHERE conversation_id = ? AND state NOT IN ('verified_completed', 'failed') ORDER BY updated_at DESC LIMIT 20`,
  ).all(input.botId) as { id: string; state: string; version: number; proposal_json: string }[];
  const tasks = db.prepare(
    `SELECT id, title, status, status_line, case_key FROM bot_tasks
     WHERE owner_conversation_id = ? AND status <> 'done' ORDER BY updated_at DESC LIMIT 25`,
  ).all(input.botId) as { id: string; title: string; status: string; status_line: string; case_key: string | null }[];
  const ids = referencedIds(record);

  const question = (json: string): string => {
    try {
      const proposal = JSON.parse(json) as { question?: unknown; title?: unknown };
      return typeof proposal.question === 'string' ? proposal.question : typeof proposal.title === 'string' ? proposal.title : '';
    } catch {
      return '';
    }
  };
  const excerpt = record.length <= RECENT_EXCERPT_CHARS ? record : `[Earlier record omitted; read the full record file.]\n\n${record.slice(-RECENT_EXCERPT_CHARS)}`;
  const section = (title: string, items: string[]) => `${title}:\n${items.length ? items.join('\n') : '- none'}`;

  return [
    `Context rotation for the SAME chat (${input.conversationId}). The previous native session reached ${input.previousContextTokens.toLocaleString('en-US')} tokens of context, so this turn starts in a fresh session to keep work fast and cheap. Your identity, skills, authority and accepted work are unchanged.`,
    `Full redacted record of this chat: ${file}`,
    'Before continuing any operation, check its source of truth. Never repeat a send, refund, purchase, label, or other external effect because of this rotation; reconcile by readback. Reload the skills your next step needs.',
    section('Open tasks', tasks.map((t) => `- ${t.title} [${t.status}]${t.case_key ? ` case ${t.case_key}` : ''}${t.status_line ? ` — ${clip(t.status_line, 200)}` : ''} (task ${t.id})`)),
    section('Open decisions you raised', decisions.map((d) => `- ${d.id} v${d.version} [${d.state}] ${clip(question(d.proposal_json), 240)}`)),
    section('Pending wake-ups', wakeups.map((w) => `- ${w.wake_key} at ${w.scheduled_for}: ${clip(w.reason.replace(/\s+/g, ' '), 200)}`)),
    section(`Owner and human directions, last ${OWNER_DIRECTION_DAYS} days (newest last)`, directions),
    `Order and ticket ids mentioned in this chat: orders ${ids.orders.join(', ') || 'none'}; tickets ${ids.tickets.join(', ') || 'none'}`,
    `Recent record:\n${excerpt}`,
  ].join('\n\n');
}

export function recordRotation(db: Database.Database, botId: string, conversationId: string, detail: Record<string, unknown>): void {
  recordGovernorEvent(db, 'rotation', botId, conversationId, detail);
}
