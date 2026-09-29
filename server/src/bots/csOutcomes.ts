import type Database from 'better-sqlite3';
import { z } from 'zod';

// Read-only measurement of customer service follow-through from native records.
// Nothing here authorizes, classifies eligibility for, or changes any action.

export const outcomeWindowSchema = z.object({
  business_id: z.string().trim().min(1).max(200),
  since: z.string().datetime(),
  until: z.string().datetime(),
  subteam: z.string().trim().max(200).default('Customer Service'),
}).strict();
export type OutcomeWindow = z.infer<typeof outcomeWindowSchema>;

type BotRow = { conversation_id: string; name: string; role: string; provider: string; model: string | null };
type DecisionRow = { id: string; conversation_id: string; state: string; answer_json: string | null; created_at: string };
type EventRow = { decision_id: string; kind: string; actor_conversation_id: string | null; payload_json: string; created_at: string };
type DraftRow = { conversation_id: string; state: string; authorized_by: number | null; receipt: string | null; claim_key: string | null; retired: number };

export type DelaySummary = { count: number; median_minutes: number | null; p95_minutes: number | null };

// SQLite datetime('now') is UTC without a zone suffix.
function instant(value: string) {
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
}
function sqlTime(iso: string) {
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
}
export function summarizeDelays(minutes: number[]): DelaySummary {
  const sorted = minutes.filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, median_minutes: null, p95_minutes: null };
  // Nearest-rank percentile: never interpolates a delay that was not observed.
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  const round = (n: number) => Math.round(n * 10) / 10;
  return { count: sorted.length, median_minutes: round(rank(0.5)), p95_minutes: round(rank(0.95)) };
}

function draftOutcome(d: DraftRow) {
  if (d.retired || d.state === 'discarded') return 'retired';
  if (d.state === 'sent' && d.receipt) return 'sent_with_receipt';
  if (d.state === 'sent' || d.state === 'uncertain' || d.state === 'sending' || d.claim_key) return 'unknown_outcome';
  if (d.state === 'failed') return 'failed';
  if (d.authorized_by !== null) return 'authorized_unsent';
  return 'unauthorized_draft';
}

function emptyCounts() {
  return {
    turns: 0, stopped_turns: 0,
    decisions_raised: 0, decisions_by_state: {} as Record<string, number>, answers: {} as Record<string, number>,
    approved: 0, approved_verified_completed: 0, approved_blocked: 0, approved_open: 0,
    human_answers: 0, human_discussion_messages: 0,
    drafts: {} as Record<string, number>,
  };
}
type Counts = ReturnType<typeof emptyCounts>;
function bump(target: Record<string, number>, key: string, by = 1) {
  target[key] = (target[key] ?? 0) + by;
}
function merge(into: Counts, from: Counts) {
  for (const k of ['turns', 'stopped_turns', 'decisions_raised', 'approved', 'approved_verified_completed', 'approved_blocked', 'approved_open', 'human_answers', 'human_discussion_messages'] as const)
    into[k] += from[k];
  for (const k of ['decisions_by_state', 'answers', 'drafts'] as const)
    for (const [name, n] of Object.entries(from[k])) bump(into[k], name, n);
}

export function csOutcomes(db: Database.Database) {
  return {
    report(raw: unknown) {
      const parsed = outcomeWindowSchema.parse(raw);
      const window = { ...parsed, since: new Date(parsed.since).toISOString(), until: new Date(parsed.until).toISOString() };
      const since = sqlTime(window.since), until = sqlTime(window.until);
      if (since >= until) throw new Error('Outcome window must end after it starts');
      const bots = db.prepare(`SELECT m.conversation_id, r.name, m.role, c.provider, c.model
        FROM business_bot_members m JOIN bot_registrations r ON r.conversation_id=m.conversation_id
        JOIN conversations c ON c.id=m.conversation_id
        WHERE m.team_id=? AND m.subteam=? AND r.active=1 ORDER BY r.name`).all(window.business_id, window.subteam) as BotRow[];

      // Timestamps are stored as ISO or as SQLite UTC text depending on the writer; compare each in its own form.
      const countBetween = (table: 'turn_origins' | 'turn_stops', column: 'event_at' | 'stopped_at', conversationId: string) =>
        (db.prepare(`SELECT count(*) n FROM ${table} WHERE conversation_id=? AND (
          (${column} LIKE '%T%' AND ${column}>=? AND ${column}<?) OR (${column} NOT LIKE '%T%' AND ${column}>=? AND ${column}<?))`)
          .get(conversationId, window.since, window.until, since, until) as { n: number }).n;
      const approvalToResult: number[] = [], approvalToCompletion: number[] = [];
      const perBot = bots.map(bot => {
        const counts = emptyCounts();
        counts.turns = countBetween('turn_origins', 'event_at', bot.conversation_id);
        counts.stopped_turns = countBetween('turn_stops', 'stopped_at', bot.conversation_id);

        const decisions = db.prepare('SELECT id,conversation_id,state,answer_json,created_at FROM bot_decisions WHERE conversation_id=? AND created_at>=? AND created_at<?')
          .all(bot.conversation_id, since, until) as DecisionRow[];
        for (const d of decisions) {
          counts.decisions_raised++;
          bump(counts.decisions_by_state, d.state);
          const events = db.prepare('SELECT decision_id,kind,actor_conversation_id,payload_json,created_at FROM bot_decision_events WHERE decision_id=? ORDER BY created_at, rowid')
            .all(d.id) as EventRow[];
          counts.human_answers += events.filter(e => e.kind === 'answered' && !e.actor_conversation_id).length;
          counts.human_discussion_messages += events.filter(e => e.kind === 'message' && !e.actor_conversation_id).length;
          const action = d.answer_json ? (JSON.parse(d.answer_json) as { action?: string }).action ?? 'unrecorded' : 'unanswered';
          bump(counts.answers, action);
          if (action !== 'approve') continue;
          counts.approved++;
          if (d.state === 'verified_completed') counts.approved_verified_completed++;
          else if (d.state === 'blocked' || d.state === 'failed') counts.approved_blocked++;
          else counts.approved_open++;
          // Measure from the latest approval so a revised proposal is not charged for its predecessor.
          const approvals = events.filter(e => e.kind === 'answered' && (JSON.parse(e.payload_json) as { action?: string }).action === 'approve');
          const approval = approvals[approvals.length - 1];
          if (!approval) continue;
          const later = events.filter(e => e.kind === 'result' && instant(e.created_at) >= instant(approval.created_at));
          const first = later[0];
          if (first) approvalToResult.push((instant(first.created_at) - instant(approval.created_at)) / 60000);
          const completed = later.find(e => (JSON.parse(e.payload_json) as { state?: string }).state === 'verified_completed');
          if (completed) approvalToCompletion.push((instant(completed.created_at) - instant(approval.created_at)) / 60000);
        }

        const drafts = db.prepare(`SELECT d.conversation_id,d.state,d.authorized_by,d.receipt,d.claim_key,
          EXISTS(SELECT 1 FROM bot_message_retirements x WHERE x.draft_id=d.id) retired
          FROM bot_message_drafts d WHERE d.conversation_id=? AND d.created_at>=? AND d.created_at<?`)
          .all(bot.conversation_id, since, until) as DraftRow[];
        for (const d of drafts) bump(counts.drafts, draftOutcome(d));
        return { conversation_id: bot.conversation_id, name: bot.name, role: bot.role, model_group: `${bot.provider}/${bot.model ?? 'default'}`, ...counts };
      });

      const groups: Record<string, Counts & { bots: string[] }> = {};
      const total = emptyCounts();
      for (const bot of perBot) {
        const group = groups[bot.model_group] ??= { ...emptyCounts(), bots: [] };
        group.bots.push(bot.name);
        merge(group, bot);
        merge(total, bot);
      }
      return {
        window: { business_id: window.business_id, subteam: window.subteam, since: window.since, until: window.until },
        bots: perBot, model_groups: groups, total,
        approval_to_first_result: summarizeDelays(approvalToResult),
        approval_to_verified_completion: summarizeDelays(approvalToCompletion),
        limits: [
          'Counts come from native Veneer decisions, drafts and turns. Customer messages sent directly in the source system without a native draft are not counted here.',
          'Model group is the chat model at report time; a model switched inside the window is attributed to its current model.',
          'Human answers and discussion messages count interactions, not minutes. Human handling time is not recorded.',
          'A verified completion is the owning bot\'s recorded result, not an independent source readback.',
        ],
      };
    },
  };
}
export type CsOutcomeReport = ReturnType<ReturnType<typeof csOutcomes>['report']>;
