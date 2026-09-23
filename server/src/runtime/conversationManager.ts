import {HistoryPages,type HistoryPage} from './historyPages.js';
import { queuedRoomWakeAllowed, roomSessionAllowed } from '../rooms/service.js';
import { botDiscussionWake, botWakeAllowed, queuedDiscussionWake, recordDiscussionDelivery } from '../bots/delivery.js';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { resolveEffectiveApprovalMode } from '../approvalMode.js';
import type { ApprovalRow, ConversationRow, QuestionRow } from '../db/db.js';
import { expandUserPath } from '../homes.js';
import { linkedFilePaths } from '../providers/fileScan.js';
import type {
  ApprovalDecision,
  CompactSessionHandle,
  CreatedFileRef,
  ProviderAdapter,
  SteerDelivery,
  TurnKillReason,
} from '../providers/types.js';
import type { WorkspaceTarget } from '../toolbox/materialize.js';
import {
  isMemoryWrappedPromptFor,
  prepareConversationInstructions,
  promptWithMemoryReference,
} from '../instructions/context.js';
import { mintAgentToken } from './agentTokens.js';
import {
  connectorToolSourcesForConversation,
  enrichConnectorToolEvent,
} from './connectorEvents.js';
import type {
  ConversationActivity,
  ConversationEvent,
  ConversationQueueSnapshot,
  ConversationStatus,
  AgentMessageToolDetails,
  MessageOrigin,
  QuestionAnswers,
  QuestionOption,
  QuestionPrompt,
  QuestionSecretTarget,
  TurnOutcome,
} from './events.js';
import { CONTEXT_COMPACTED_NOTICE, USER_STOPPED_NOTICE, VENEER_RESTARTED_NOTICE } from './events.js';
import { safeTerminalAction } from './subagentProgress.js';
import type { RecalledMemory, RecallDiagnostics } from '../memory/supermemory.js';
import {
  guardLoopbackDeliverableEvents,
  guardLoopbackDeliverableMarkdown,
} from './loopbackDeliverables.js';
import { providerSkillPrompt } from './skillInvocation.js';
import type { TranscriptArchive } from './transcriptArchive.js';
import {
  namespaceHistory, writeProviderHandoff, PROVIDER_CONTINUATION_RULES,
  type ModelSelection, type SwitchProviderResult,
} from './providerSwitch.js';

const TIMEOUT_DENY_MESSAGE =
  'No one approved this action in time, so it was automatically declined. Continue without it and do not retry it.';
const USER_DENY_MESSAGE = 'The user declined this action. Continue without it and do not retry it.';
/**
 * How long steerMessage waits for the provider to echo a steered line. Claude
 * Code only echoes after its current tool call ends, so this is a courtesy wait
 * for the fast case, not a delivery test.
 */
const STEER_ACK_WAIT_MS = 5_000;

function messageOriginJson(origin: MessageOrigin | undefined): string | null {
  return origin ? JSON.stringify(origin) : null;
}

function parseMessageOrigin(value: unknown): MessageOrigin | undefined {
  if (!value) return undefined;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const candidate = parsed as Partial<MessageOrigin>;
    if (
      (candidate.kind !== 'agent' && candidate.kind !== 'wakeup' && candidate.kind !== 'build_queue') ||
      typeof candidate.from !== 'string' ||
      typeof candidate.to !== 'string'
    ) return undefined;
    const from = candidate.from.trim().slice(0, 120);
    const to = candidate.to.trim().slice(0, 120);
    if (!from || !to) return undefined;
    const sourceConversationId = candidate.kind === 'agent' && typeof candidate.sourceConversationId === 'string'
      ? candidate.sourceConversationId.trim().slice(0, 200)
      : '';
    const sourceConversationTitle = sourceConversationId && typeof candidate.sourceConversationTitle === 'string'
      ? candidate.sourceConversationTitle.trim().slice(0, 200)
      : '';
    return {
      kind: candidate.kind,
      from,
      to,
      ...(sourceConversationId ? { sourceConversationId } : {}),
      ...(sourceConversationTitle ? { sourceConversationTitle } : {}),
    };
  } catch {
    return undefined;
  }
}

interface LiveTurn {
  turnId: string;
  promptText: string;
  actorUserId: number | null;
  origin?: MessageOrigin;
  /** Buffered events for the in-flight turn (deltas accumulate in partialText instead). */
  events: ConversationEvent[];
  partialText: string;
  /** Set once the turn has been interrupted: its work, and anything steered into it, is void. */
  discarded?: boolean;
}

/** A message waiting behind the in-flight turn. `id` is its durable
 * queued_messages row (deleted when the message is shifted into a turn); null
 * for a re-enqueued interrupted turn, which owns a pending_turns row instead. */
interface QueuedMessageWork {
  id: number | null;
  prompt: string;
  actorUserId: number | null;
  origin?: MessageOrigin;
}

interface PendingSteerOrigin {
  messageId: number;
  text: string;
  origin: MessageOrigin;
}

interface LiveConversation {
  turn: LiveTurn | null; // non-null while a turn is in flight
  maintenance: { kind: 'compaction' | 'provider-switch'; kill: () => void; interrupted: boolean } | null;
  kill: ((reason?: TurnKillReason) => void) | null;
  steer: ((text: string) => Promise<boolean | SteerDelivery>) | null;
  respond: ((requestId: string, decision: ApprovalDecision) => boolean) | null;
  respondQuestion: ((requestId: string, answers: QuestionAnswers) => boolean) | null;
  pendingSteerOrigins: PendingSteerOrigin[];
  /** Queued message ids written into the live process but not yet echoed back. */
  steering: Set<number>;
  queue: QueuedMessageWork[];
  lastTurnFailed: boolean;
}

export type ResolveApprovalResult =
  | { ok: true; status: 'approved' | 'denied' }
  | { ok: false; error: 'not_found' | 'not_pending' | 'expired' };

export interface QuestionSnapshot {
  conversationId: string;
  status: 'pending' | 'answered' | 'expired' | 'dismissed';
  answer: string;
  answers: QuestionAnswers;
  /** Omitted means a plain choice question. */
  kind?: 'choice' | 'secret' | 'reveal';
  /** Present on secret prompts so the save route needs no prompt re-parse. */
  secret?: QuestionSecretTarget;
}
export type ResolveQuestionResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'not_pending' | 'invalid' | 'expired' };
export interface PostMessageResult {
  messageId: number;
  disposition: 'running' | 'steered' | 'delivered' | 'queued' | 'duplicate';
  /** Why live steering did not happen. Present only when disposition is 'queued'. */
  steerReason?: SteerReason;
  queue: ConversationQueueSnapshot;
}
/** Each value is a distinct thing the caller (and the user) can act on. */
export type SteerReason =
  | 'maintenance'
  | 'failed_turn'
  | 'other_actor'
  | 'no_steer_support'
  | 'write_failed'
  | 'no_live_turn';
export type QueueMutationResult =
  | { ok: true; queue: ConversationQueueSnapshot }
  | { ok: false; error: 'not_found' | 'conflict'; queue: ConversationQueueSnapshot };

export type CompactConversationResult =
  | { ok: true; contextTokens: number | null }
  | {
      ok: false;
      error: 'working' | 'already_compacting' | 'unsupported' | 'not_ready' | 'interrupted' | 'failed';
      message: string;
    };

export interface ConversationManager {
  /** Fan-out bus: emits event/status plus server-authoritative queue snapshots. */
  bus: EventEmitter;
  postMessage(conv: ConversationRow, text: string, actorUserId?: number, origin?: MessageOrigin): PostMessageResult;
  /**
   * Persist first, then steer the active provider turn; retain the queue row on
   * failure. `idempotencyKey` is part of the runner IPC shape but is ignored:
   * only scheduled wake-ups are re-delivered, and they dedupe through
   * `deliverWakeup`.
   */
  steerMessage(
    conv: ConversationRow,
    text: string,
    idempotencyKey?: string,
    actorUserId?: number,
    origin?: MessageOrigin,
  ): Promise<PostMessageResult>;
  queueMessage(conv: ConversationRow, text: string, actorUserId?: number, origin?: MessageOrigin): PostMessageResult;
  /** Queue a runner-generated wake without dismissing questions or duplicating after a crash. */
  deliverWakeup(conv: ConversationRow, text: string, wakeupId: string, actorUserId?: number | null): PostMessageResult;
  queueSnapshot(conversationId: string): ConversationQueueSnapshot;
  updateQueuedMessage(conversationId: string, messageId: number, text: string, actorUserId?: number): QueueMutationResult;
  removeQueuedMessage(conversationId: string, messageId: number): QueueMutationResult;
  reorderQueuedMessages(conversationId: string, messageIds: number[]): QueueMutationResult;
  sendQueuedMessageNow(conv: ConversationRow, messageId: number): QueueMutationResult;
  retryFailedTurn(conv: ConversationRow, actorUserId?: number): QueueMutationResult;
  discardFailedTurn(conv: ConversationRow): QueueMutationResult;
  /** Compact native context without changing real turns; success may add a maintenance notice. */
  compactConversation(conv: ConversationRow): Promise<CompactConversationResult>;
  /**
   * Stop the live turn. The reason reaches the provider: only an explicit user
   * Stop ('user', the default) means "abandon the delegated work too" — a
   * "Send now" replaces the parent turn and leaves its children running.
   */
  interrupt(conversationId: string, reason?: TurnKillReason): boolean;
  /**
   * Re-run turns that were in flight when the process last died (restart / ship /
   * crash). Called once at boot, AFTER the http server is listening (a resumed
   * agent may call back into the API). Bounded by an attempt cap per turn.
   */
  resumeInterruptedTurns(): void;
  /** Kill every in-flight turn's child process (clean shutdown / restart). */
  shutdown(): void;
  statusOf(conversationId: string): ConversationStatus;
  activityOf(conversationId: string): ConversationActivity;
  isLive(conversationId: string): boolean;
  /** Resolve a pending approval (route layer has already authorized the caller). */
  resolveApproval(approvalId: number, outcome: 'approved' | 'denied', byUserId: number): ResolveApprovalResult;
  /**
   * Register a question the agent (via the ask_user MCP tool) is asking the
   * user; returns its requestId. Non-blocking — the agent polls getQuestion
   * until it flips to answered/expired. Auto-expires after the approval timeout.
   */
  askQuestion(
    conversationId: string,
    question: string,
    options: QuestionOption[],
    multi: boolean,
    allowOther?: boolean,
    /** Present = a secret prompt: masked input, value written straight to Doppler. */
    secret?: QuestionSecretTarget,
    /** Which secret card to render: collect a value ('secret') or show one ('reveal'). */
    secretKind?: 'secret' | 'reveal',
  ): string;
  /** Current state of a question, for the agent's poll loop (null once cleaned up). */
  getQuestion(requestId: string): QuestionSnapshot | null;
  /** Record the user's answer (route layer has already authorized the caller). */
  resolveQuestion(requestId: string, answers: QuestionAnswers | string): ResolveQuestionResult;
  /**
   * Full snapshot for subscribers: rehydrated session-file events merged with
   * the in-flight turn's live buffer. The session file lags the live stream
   * (claude writes it asynchronously), so a raw file parse would drop the
   * current turn's user message — and any events streamed before subscribe.
   */
  snapshot(conv: ConversationRow): Promise<ConversationEvent[]>;
  historyPage(conv:ConversationRow,token?:string,before?:number):Promise<HistoryPage>;
  historyRecord(conv:ConversationRow,token:string,index:number):ConversationEvent;
  switchProvider(conv: ConversationRow, selection: ModelSelection): Promise<SwitchProviderResult>;
  /**
   * Candidate deliverable files (CSV etc.) this conversation's agent created,
   * scanned from the native session file. Not existence-checked — the route
   * layer stats and filters before exposing anything.
   */
  listSessionFiles(conv: ConversationRow): Promise<CreatedFileRef[]>;
}

/**
 * Serializes turns per conversation (spec §8): one in-flight turn; messages
 * arriving mid-turn queue and run next. Status is derived, never persisted.
 */
/**
 * A stopped turn never writes terminal rows for the agents it launched, and
 * with no later prompt the transcript parser has no boundary to settle them
 * at. With no live turn, nothing can still be running: mark them stopped.
 */
export function settleOrphanedSubagentEvents(events: ConversationEvent[]): ConversationEvent[] {
  const latest = new Map<string, Extract<ConversationEvent, { type: 'subagent_started' | 'subagent_updated' }>>();
  for (const event of events) {
    if (event.type === 'subagent_started' || event.type === 'subagent_updated') latest.set(event.agentKey, event);
  }
  const orphans = [...latest.values()].filter((event) => event.status === 'queued' || event.status === 'running');
  if (orphans.length === 0) return events;
  const now = Date.now();
  return events.concat(orphans.map((event) => {
    const started = event.startedAt ? Date.parse(event.startedAt) : Number.NaN;
    return {
      type: 'subagent_updated' as const,
      turnId: event.turnId,
      agentKey: event.agentKey,
      status: 'stopped' as const,
      currentAction: safeTerminalAction('stopped'),
      ...(Number.isFinite(started) ? { durationMs: Math.max(0, now - started) } : {}),
    };
  }));
}

export function mergeLiveIntoSnapshot(
  fileEvents: ConversationEvent[],
  turn: { promptText: string; events: ConversationEvent[]; partialText: string } | null,
  opts: { settleOrphans?: boolean } = {},
): ConversationEvent[] {
  // The live buffer is authoritative for the in-flight turn, so orphan
  // settling only applies when there is nothing live to overlay.
  if (!turn) return opts.settleOrphans ? settleOrphanedSubagentEvents(fileEvents) : fileEvents;
  // Drop the file's copy of the in-flight turn (if the user row landed on disk
  // already): truncate at the LAST turn_started whose text matches the live
  // prompt, then append the authoritative live buffer.
  //
  // Text alone is ambiguous when two consecutive prompts are identical ("ok",
  // "continue"): a COMPLETED prior exchange can share the live prompt's text,
  // and cutting there would delete real history. So only cut when the tail-most
  // turn_started is genuinely the in-flight turn's echo, not a finished one:
  //   - it is the very last event on disk (user row flushed, no assistant reply
  //     yet — a completed turn would have its reply after it), or
  //   - the live turn has itself produced assistant content, meaning the disk
  //     copy is that same in-flight turn's partial (as the CLI writes it).
  // A completed prior exchange is followed by its reply while the live turn is
  // still empty → keep it.
  const liveProduced = turn.events.length > 1 || turn.partialText !== '';
  let cut = fileEvents.length;
  for (let i = fileEvents.length - 1; i >= 0; i--) {
    const e = fileEvents[i]!;
    if (e.type === 'turn_started') {
      const isLastEvent = i === fileEvents.length - 1;
      const matchesLivePrompt =
        e.text === turn.promptText || isMemoryWrappedPromptFor(e.text, turn.promptText);
      if (matchesLivePrompt && (isLastEvent || liveProduced)) cut = i;
      break; // only ever the tail-most turn
    }
  }
  const merged = fileEvents.slice(0, cut).concat(turn.events);
  if (turn.partialText) {
    merged.push({ type: 'text_delta', turnId: (turn.events[0] as { turnId?: string })?.turnId ?? '', text: turn.partialText });
  }
  return merged;
}

/**
 * Provider transcripts record approval requests before the manager decides
 * whether to surface or auto-approve them. Reconcile those raw events with the
 * authoritative DB rows so a reload matches the live approval experience.
 */
export function reconcileApprovalEvents(
  events: ConversationEvent[],
  approvals: ApprovalRow[],
): ConversationEvent[] {
  const byRequestId = new Map(approvals.map((row) => [row.request_id, row]));
  const resolutionsOnDisk = new Set(
    events.flatMap((event) => (event.type === 'approval_resolved' ? [event.requestId] : [])),
  );
  const out: ConversationEvent[] = [];

  for (const event of events) {
    if (event.type === 'approval_requested') {
      const row = byRequestId.get(event.requestId);
      if (!row) {
        out.push(event);
        continue;
      }

      // Allow mode suppresses these live. Keep reloads consistent instead of
      // resurrecting a disabled, apparently pending approval card.
      const autoApproved = row.status === 'approved' && row.resolved_by === null;
      if (autoApproved) continue;

      out.push({ ...event, approvalId: row.id });
      if (row.status !== 'pending' && !resolutionsOnDisk.has(event.requestId)) {
        out.push({
          type: 'approval_resolved',
          requestId: event.requestId,
          outcome: row.status,
          ...(row.resolved_by === null ? {} : { byUserId: row.resolved_by }),
        });
      }
      continue;
    }

    if (event.type === 'approval_resolved') {
      const row = byRequestId.get(event.requestId);
      if (row?.status === 'approved' && row.resolved_by === null) continue;
      if (row && row.status !== 'pending') {
        out.push({
          ...event,
          outcome: row.status,
          ...(row.resolved_by === null ? {} : { byUserId: row.resolved_by }),
        });
      } else {
        out.push(event);
      }
      continue;
    }

    out.push(event);
  }

  return out;
}

function parseQuestionPrompts(row: QuestionRow): QuestionPrompt[] {
  try {
    const parsed = JSON.parse(row.questions_json);
    return Array.isArray(parsed) ? (parsed as QuestionPrompt[]) : [];
  } catch {
    return [];
  }
}

function parseQuestionAnswers(row: QuestionRow): QuestionAnswers {
  try {
    const parsed = JSON.parse(row.answers_json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as QuestionAnswers)
      : {};
  } catch {
    return {};
  }
}

function durableQuestionEvents(row: QuestionRow): ConversationEvent[] {
  const questions = parseQuestionPrompts(row);
  const first = questions[0];
  const asked: ConversationEvent = {
    type: 'question_asked',
    requestId: row.request_id,
    turnId: row.turn_id,
    questions,
    responseMode: row.response_mode,
    ...(first ? { question: first.question, options: first.options, multi: first.multi } : {}),
  };
  if (row.status === 'pending') return [asked];

  const answers = parseQuestionAnswers(row);
  const legacyAnswer = first ? (answers[first.id] ?? []).join(', ') : '';
  return [
    asked,
    {
      type: 'question_answered',
      requestId: row.request_id,
      answers,
      answer: legacyAnswer,
      ...(row.status === 'expired' ? { expired: true } : {}),
      ...(row.status === 'dismissed' ? { dismissed: true } : {}),
    },
  ];
}

/** MCP tools whose raw tool rows are replaced by a durable question card. */
const QUESTION_TOOL_NAMES = new Set(['mcp__agents__ask_user', 'mcp__agents__request_secret']);

/**
 * sqlite `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` with no zone and no
 * milliseconds, and it is UTC. Event timestamps are ISO strings. Parse both,
 * treating a zone-less stamp as UTC rather than local time.
 */
function parseQuestionTime(value: string | undefined): number {
  const text = (value ?? '').trim();
  if (!text) return Number.NaN;
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text);
  const normalized = zoneless ? `${text.replace(' ', 'T')}Z` : text;
  return Date.parse(normalized);
}

interface TurnSpan {
  /** Index of the span's `turn_started` event. */
  start: number;
  /** Exclusive end index — the next `turn_started`, or the transcript end. */
  end: number;
  atMs: number;
}

/**
 * Split a transcript into turns by `turn_started` position. Spans are indexed,
 * not keyed by turn id, so subagent events carrying their own turn id still
 * belong to the turn they were emitted inside.
 */
function buildTurnSpans(events: ConversationEvent[]): TurnSpan[] {
  const spans: TurnSpan[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.type !== 'turn_started') continue;
    const previous = spans[spans.length - 1];
    if (previous) previous.end = i;
    spans.push({ start: i, end: events.length, atMs: parseQuestionTime(event.at) });
  }
  return spans;
}

/**
 * sqlite truncates to whole seconds, so a question recorded in the same second
 * its turn started can look a fraction of a second older than the turn. Allow
 * that much slack when deciding which turn a row belongs to.
 */
const QUESTION_TIME_SLACK_MS = 1000;

function resolveSpanByTime(spans: TurnSpan[], createdAtMs: number): number {
  if (!Number.isFinite(createdAtMs)) return -1;
  let found = -1;
  for (let i = 0; i < spans.length; i++) {
    const at = spans[i]!.atMs;
    if (Number.isFinite(at) && at <= createdAtMs + QUESTION_TIME_SLACK_MS) found = i;
  }
  return found;
}

/**
 * Replace raw MCP ask_user activity with the authoritative durable card.
 *
 * Question rows store the runtime's own turn id, but a reloaded provider
 * transcript renumbers turns (`t0`, `t1`, …), so that id usually matches
 * nothing on disk. Placing by `created_at` against the `turn_started` timeline
 * keeps an answered card inside the turn that asked it instead of dumping it at
 * the bottom of the transcript on every reload.
 */
export function reconcileQuestionEvents(
  events: ConversationEvent[],
  questions: QuestionRow[],
): ConversationEvent[] {
  if (!questions.length) return events;

  const rowsById = new Map(questions.map((row) => [row.request_id, row]));
  const pollRowsByTurn = new Map<string, QuestionRow[]>();
  for (const row of questions) {
    if (row.response_mode !== 'poll') continue;
    const rows = pollRowsByTurn.get(row.turn_id) ?? [];
    rows.push(row);
    pollRowsByTurn.set(row.turn_id, rows);
  }

  const spans = buildTurnSpans(events);
  const spanByEventIndex: number[] = new Array(events.length).fill(-1);
  spans.forEach((span, index) => {
    for (let i = span.start; i < span.end; i++) spanByEventIndex[i] = index;
  });
  const lastIndexByTurnId = new Map<string, number>();
  events.forEach((event, index) => {
    const turnId = (event as { turnId?: unknown }).turnId;
    if (typeof turnId === 'string' && turnId) lastIndexByTurnId.set(turnId, index);
  });

  // Prefer an exact turn-id hit (live turns, Codex); fall back to the timeline.
  const spanByRow = new Map<string, number>();
  for (const row of questions) {
    const exactIndex = lastIndexByTurnId.get(row.turn_id);
    let span = exactIndex === undefined ? -1 : (spanByEventIndex[exactIndex] ?? -1);
    if (span < 0) span = resolveSpanByTime(spans, parseQuestionTime(row.created_at));
    if (span >= 0) spanByRow.set(row.request_id, span);
  }

  const byCreatedAt = (a: QuestionRow, b: QuestionRow) => {
    const left = parseQuestionTime(a.created_at);
    const right = parseQuestionTime(b.created_at);
    if (!Number.isFinite(left) || !Number.isFinite(right) || left === right) return 0;
    return left - right;
  };
  const rowsBySpan = new Map<number, QuestionRow[]>();
  for (const row of [...questions].sort(byCreatedAt)) {
    const span = spanByRow.get(row.request_id);
    if (span === undefined) continue;
    const rows = rowsBySpan.get(span) ?? [];
    rows.push(row);
    rowsBySpan.set(span, rows);
  }
  const pollRowsBySpan = new Map<number, QuestionRow[]>();
  for (const [span, rows] of rowsBySpan) {
    const pollRows = rows.filter((row) => row.response_mode === 'poll');
    if (pollRows.length) pollRowsBySpan.set(span, pollRows);
  }

  const placed = new Set<string>();
  const suppressedToolIds = new Set<string>();
  const out: ConversationEvent[] = [];
  const place = (row: QuestionRow) => {
    if (placed.has(row.request_id)) return;
    placed.add(row.request_id);
    out.push(...durableQuestionEvents(row));
  };
  // A turn with no raw question tool row still owns its cards: emit them as the
  // turn's last events rather than letting them fall through to the transcript.
  const flushSpan = (span: number) => {
    if (span < 0) return;
    for (const row of rowsBySpan.get(span) ?? []) place(row);
  };

  let currentSpan = events.length ? (spanByEventIndex[0] ?? -1) : -1;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const span = spanByEventIndex[i] ?? -1;
    if (span !== currentSpan) {
      flushSpan(currentSpan);
      currentSpan = span;
    }
    if (event.type === 'tool_started' && QUESTION_TOOL_NAMES.has(event.toolName)) {
      const candidates = [
        ...(pollRowsByTurn.get(event.turnId) ?? []),
        ...(pollRowsBySpan.get(span) ?? []),
      ];
      const row = candidates.find((candidate) => !placed.has(candidate.request_id));
      if (row) {
        suppressedToolIds.add(event.toolId);
        place(row);
        continue;
      }
    }
    if (event.type === 'tool_finished' && suppressedToolIds.has(event.toolId)) continue;
    if (event.type === 'question_asked') {
      const row = rowsById.get(event.requestId);
      if (row) {
        place(row);
        continue;
      }
    }
    if (event.type === 'question_answered' && rowsById.has(event.requestId)) continue;
    out.push(event);
  }
  flushSpan(currentSpan);

  // Rows we could not tie to any turn keep the old best effort: after the last
  // event carrying their turn id, else at the end of the transcript.
  for (const row of questions) {
    if (placed.has(row.request_id)) continue;
    const insertAt = out.findLastIndex(
      (event) => String((event as { turnId?: unknown }).turnId ?? '') === row.turn_id,
    );
    const rowEvents = durableQuestionEvents(row);
    if (insertAt < 0) out.push(...rowEvents);
    else out.splice(insertAt + 1, 0, ...rowEvents);
    placed.add(row.request_id);
  }

  return out;
}

/**
 * Relabel "Veneer restarted…" notices the user actually caused by pressing Stop.
 *
 * The provider CLI dies on SIGTERM without reliably writing its interruption
 * marker, so the resumed session file is indistinguishable from a runner
 * restart. `stoppedAt` (ISO strings from turn_stops) is the missing evidence: a
 * stop recorded after the most recent user message and at or before the
 * notice's own timestamp is what produced that notice. Each stop relabels at
 * most one notice; notices with no `at` carry no evidence and are left alone.
 */
export function spliceUserStopNotices(
  events: ConversationEvent[],
  stoppedAt: string[],
): ConversationEvent[] {
  const stops = stoppedAt
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!stops.length) return events;
  const used = new Set<number>();
  let lastUserMessageAt = Number.NEGATIVE_INFINITY;
  return events.map((event) => {
    if (event.type === 'turn_started' && event.role === 'user') {
      const at = Date.parse(event.at);
      if (Number.isFinite(at)) lastUserMessageAt = at;
      return event;
    }
    if (event.type !== 'notice' || event.message !== VENEER_RESTARTED_NOTICE || !event.at) return event;
    const noticeAt = Date.parse(event.at);
    if (!Number.isFinite(noticeAt)) return event;
    const match = stops.findIndex(
      (stop, i) => !used.has(i) && stop > lastUserMessageAt && stop <= noticeAt,
    );
    if (match < 0) return event;
    used.add(match);
    return { ...event, message: USER_STOPPED_NOTICE };
  });
}

export function createConversationManager({
  db,
  adapters,
  resolveWorkspace,
  materialize,
  loadMemoryBlock,
  captureMemoryTurn,
  transcriptArchive,
  approvalTimeoutMs = 10 * 60 * 1000,
  steerAckWaitMs = STEER_ACK_WAIT_MS,
  log = console,
}: {
  db: Database.Database;
  /** One PER_TURN adapter per provider (spec §7); conv.provider picks which runs a given conversation. */
  adapters: Record<string, ProviderAdapter>;
  /** Which workspace/cwd a conversation runs in (scratch vs. the source checkout). */
  resolveWorkspace: (conv: ConversationRow) => WorkspaceTarget;
  /** Toolbox → per-spawn config (spec §11.3); run before each turn's spawn.
   * conversationId is handed to the agent-tools MCP server so ask_user knows
   * which chat to surface its question in. */
  materialize?: (
    target: WorkspaceTarget,
    agentToken: string,
    conversationId: string,
    actorUserId: number | null,
    memoryBlock: string | null,
  ) => {
    mcpConfigPath: string | null;
    settingsPath: string | null;
    developerInstructions: string;
    instructionHash: string;
  };
  /** Fetch the fail-open remembered-context block (+ structured recall) before synchronous materialization. */
  loadMemoryBlock?: (
    conv: ConversationRow,
    prompt: string,
    context: { firstTurn: boolean },
  ) => Promise<{ block: string | null; memories: RecalledMemory[]; diagnostics: RecallDiagnostics }>;
  /** Best-effort, asynchronous capture after a successful completed turn. */
  captureMemoryTurn?: (conv: ConversationRow, events: ConversationEvent[]) => Promise<void>;
  /** Veneer-owned copies of provider transcript files; absent in tests that don't need them. */
  transcriptArchive?: TranscriptArchive;
  approvalTimeoutMs?: number;
  /** How long a caller waits for the provider's steer echo before settling for 'delivered'. */
  steerAckWaitMs?: number;
  log?: Pick<Console, 'warn' | 'error'>;
}): ConversationManager {
  const live = new Map<string, LiveConversation>();
  const bus = new EventEmitter();
  const historyPages=new HistoryPages(),snapshotRevisions=new WeakMap<ConversationEvent[],number>();
  const streamEpoch=crypto.randomUUID();
  let streamRevision=0;
  bus.on('event',(_id:string,event:ConversationEvent)=>{Object.defineProperty(event,'streamRevision',{value:++streamRevision,enumerable:false,configurable:true});Object.defineProperty(event,'streamEpoch',{value:streamEpoch,enumerable:false,configurable:true});});
  bus.setMaxListeners(100);
  // HTTP mutation replies and runner WebSocket events use different transports.
  // Stamp snapshots when they are created so a delayed reply cannot overwrite a
  // newer live event. Date seeding also keeps revisions increasing across normal
  // runner restarts; the sub-millisecond counter preserves order within one tick.
  let lastQueueRevision = Date.now() * 1_000;
  function nextQueueRevision(): number {
    lastQueueRevision = Math.max(lastQueueRevision + 1, Date.now() * 1_000);
    return lastQueueRevision;
  }

  const touchStmt = db.prepare("UPDATE conversations SET last_active_at = datetime('now') WHERE id = ?");
  const activeUserEmailStmt = db.prepare("SELECT email FROM users WHERE id = ? AND status = 'active'");
  // Only overwrite the title while it's still auto-managed — a user rename (PATCH) clears title_auto.
  const updateAutoTitleStmt = db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND title_auto = 1');
  const updateModelStmt = db.prepare(`UPDATE conversations SET last_answered_model = ?, last_answered_provider = ?
    WHERE id = ? AND provider = ? AND native_session_id = ?`);
  const providerContextStmt = db.prepare('SELECT * FROM conversation_provider_context WHERE conversation_id = ?');
  const providerContext = (id: string) => providerContextStmt.get(id) as {
    history_json: string; files_json: string; handoff: string; pending: number;
  } | undefined;
  const updateContextTokensStmt = db.prepare('UPDATE conversations SET last_input_tokens = ? WHERE id = ?');
  const updateNativeSessionIdStmt = db.prepare('UPDATE conversations SET native_session_id = ? WHERE id = ?');
  const updateProviderInstructionHashStmt = db.prepare(
    'UPDATE conversations SET provider_instruction_hash = ? WHERE id = ?',
  );

  // ── Approvals (spec §5, workstream B) ──────────────────────────────────────
  // The DB row is the record; the timer + live handle are runtime-only. At boot
  // no process is alive, so any leftover 'pending' rows are unanswerable.
  db.prepare("UPDATE approvals SET status = 'expired', resolved_at = datetime('now') WHERE status = 'pending'").run();
  // Native provider handles and MCP pollers are process-local. Preserve stale
  // cards for history, but make them explicitly non-interactive after a boot.
  db.prepare("UPDATE questions SET status = 'expired', resolved_at = datetime('now') WHERE status = 'pending'").run();

  // ── Turn auto-resume (pending_turns) ───────────────────────────────────────
  // A turn records itself here on start and clears itself on completion; a row
  // that survives a restart is an interrupted turn to re-run at boot.
  const MAX_RESUME_ATTEMPTS = 3;
  // A persisted prompt can resume after a crash, but its previous focus cannot.
  db.prepare('UPDATE pending_turns SET discussion_message_id=NULL').run();
  const clearDiscussionActivity = db.prepare('UPDATE pending_turns SET discussion_message_id=NULL WHERE conversation_id=?');
  const recordPendingTurnStmt = db.prepare(
    `INSERT INTO pending_turns (conversation_id, prompt, actor_user_id, origin_json, attempts, status, error)
     VALUES (?, ?, ?, ?, 1, 'pending', NULL)
     ON CONFLICT(conversation_id) DO UPDATE SET
       prompt = excluded.prompt,
       actor_user_id = excluded.actor_user_id,
       origin_json = excluded.origin_json,
       discussion_message_id = NULL,
       attempts = pending_turns.attempts + 1,
       status = 'pending',
       error = NULL`,
  );
  const clearPendingTurnStmt = db.prepare('DELETE FROM pending_turns WHERE conversation_id = ?');
  const listPendingTurnsStmt = db.prepare(
    "SELECT conversation_id, prompt, actor_user_id, origin_json, attempts FROM pending_turns WHERE status = 'pending'",
  );
  const failedTurnStmt = db.prepare(
    "SELECT prompt, actor_user_id, origin_json, attempts, error FROM pending_turns WHERE conversation_id = ? AND status = 'failed'",
  );
  const failPendingTurnStmt = db.prepare(
    "UPDATE pending_turns SET status = 'failed', error = ? WHERE conversation_id = ? AND status = 'pending'",
  );
  const retryPendingTurnStmt = db.prepare(
    "UPDATE pending_turns SET status = 'pending', attempts = 0, error = NULL WHERE conversation_id = ? AND status = 'failed'",
  );
  const discardFailedTurnStmt = db.prepare(
    "DELETE FROM pending_turns WHERE conversation_id = ? AND status = 'failed'",
  );
  // A deliberate service restart is not a failed recovery attempt. Discount
  // the current run before SIGTERM so the boot-time resume restores the same
  // attempt number; crashes still consume the cap because shutdown never runs.
  const discountCleanRestartStmt = db.prepare(
    "UPDATE pending_turns SET attempts = MAX(attempts - 1, 0) WHERE conversation_id = ? AND status = 'pending'",
  );

  // ── Durable message queue (queued_messages) ────────────────────────────────
  // Messages that arrive mid-turn queue behind the in-flight turn. Persist each
  // on enqueue and delete it when it's shifted into a turn, so a restart/crash
  // doesn't silently drop still-waiting messages — they're replayed at boot.
  const insertQueuedMessageStmt = db.prepare(
    `INSERT INTO queued_messages (conversation_id, prompt, actor_user_id, origin_json, sort_order)
     SELECT ?, ?, ?, ?, COALESCE(MAX(sort_order), 0) + 1 FROM queued_messages WHERE conversation_id = ?`,
  );
  const findInboundReceiptStmt = db.prepare(
    'SELECT conversation_id, message_id, source_kind FROM hub_inbound_messages WHERE idempotency_key = ?',
  );
  const insertInboundReceiptStmt = db.prepare(
    `INSERT INTO hub_inbound_messages
     (idempotency_key, conversation_id, message_id, source_kind)
     VALUES (?, ?, ?, ?)`,
  );
  const deleteQueuedMessageStmt = db.prepare('DELETE FROM queued_messages WHERE id = ?');
  const deleteConversationQueuedMessageStmt = db.prepare(
    'DELETE FROM queued_messages WHERE id = ? AND conversation_id = ?',
  );
  const updateQueuedMessageStmt = db.prepare(
    'UPDATE queued_messages SET prompt = ?, actor_user_id = COALESCE(?, actor_user_id) WHERE id = ? AND conversation_id = ?',
  );
  const listQueuedMessagesStmt = db.prepare(
    'SELECT id, conversation_id, prompt, actor_user_id, origin_json FROM queued_messages ORDER BY conversation_id, sort_order, id',
  );
  const listConversationQueuedMessagesStmt = db.prepare(
    'SELECT id, prompt, created_at, origin_json FROM queued_messages WHERE conversation_id = ? ORDER BY sort_order, id',
  );
  const setQueuedMessageOrderStmt = db.prepare(
    'UPDATE queued_messages SET sort_order = ? WHERE id = ? AND conversation_id = ?',
  );
  const assistantNameStmt = db.prepare('SELECT name FROM assistants WHERE id = ?');

  function assistantNameFor(conv: ConversationRow): string {
    const row = assistantNameStmt.get(conv.assistant_id) as { name: string } | undefined;
    return row?.name?.trim() || 'Agent';
  }

  // ── Authenticated non-human message origins ───────────────────────────────
  // Provider transcripts preserve prompt text but not who initiated it. This
  // sidecar lets reloads distinguish agent guidance and scheduled wake-ups
  // without trusting text prefixes that a human could spoof.
  const insertTurnOriginStmt = db.prepare(
    'INSERT INTO turn_origins (conversation_id, turn_id, prompt_text, event_at, message_id, origin_json) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selectTurnOriginsStmt = db.prepare(
    'SELECT turn_id, prompt_text, event_at, message_id, origin_json FROM turn_origins WHERE conversation_id = ? ORDER BY id',
  );
  const selectAgentMessageReceiptsStmt = db.prepare(
    `SELECT id, target_conversation_id, message_id, message_text, disposition
       FROM agent_message_receipts
      WHERE source_conversation_id = ?
      ORDER BY id`,
  );
  const selectLatestAgentMessageReceiptStmt = db.prepare(
    `SELECT id, target_conversation_id, message_id, message_text, disposition
       FROM agent_message_receipts
      WHERE source_conversation_id = ?
        AND target_conversation_id = ?
        AND message_text = ?
      ORDER BY id DESC
      LIMIT 1`,
  );

  interface AgentMessageReceiptRow {
    id: number;
    target_conversation_id: string | null;
    message_id: number;
    message_text: string;
    disposition: AgentMessageToolDetails['disposition'];
  }

  function detailsWithAgentReceipt(
    details: AgentMessageToolDetails,
    receipt: AgentMessageReceiptRow,
  ): AgentMessageToolDetails {
    return {
      ...details,
      ...(receipt.target_conversation_id ? { targetConversationId: receipt.target_conversation_id } : {}),
      messageId: receipt.message_id,
      ...(receipt.disposition ? { disposition: receipt.disposition } : {}),
    };
  }

  function enrichLiveAgentMessageEvent(
    conversationId: string,
    event: ConversationEvent,
    priorEvents: ConversationEvent[],
  ): ConversationEvent {
    if (event.type !== 'tool_finished') return event;
    const started = priorEvents.findLast((candidate) =>
      candidate.type === 'tool_started'
      && candidate.toolId === event.toolId
      && candidate.agentMessageDetails?.targetConversationId,
    );
    if (started?.type !== 'tool_started' || !started.agentMessageDetails?.targetConversationId) return event;
    const receipt = selectLatestAgentMessageReceiptStmt.get(
      conversationId,
      started.agentMessageDetails.targetConversationId,
      started.agentMessageDetails.text,
    ) as AgentMessageReceiptRow | undefined;
    return receipt
      ? { ...event, agentMessageDetails: detailsWithAgentReceipt(started.agentMessageDetails, receipt) }
      : event;
  }

  /** Match authenticated REST receipts back onto provider-neutral tool events.
   * Ordering disambiguates repeated identical sends without exposing tool ids
   * outside the source chat. */
  function spliceAgentMessageReceipts(
    conversationId: string,
    events: ConversationEvent[],
  ): ConversationEvent[] {
    const receipts = selectAgentMessageReceiptsStmt.all(conversationId) as AgentMessageReceiptRow[];
    if (!receipts.length) return events;
    const used = new Set<number>();
    const receiptByToolId = new Map<string, AgentMessageReceiptRow>();

    return events.map((event) => {
      if (event.type === 'tool_started' && event.agentMessageDetails?.targetConversationId) {
        const receipt = receipts.find((candidate) =>
          !used.has(candidate.id)
          && candidate.target_conversation_id === event.agentMessageDetails!.targetConversationId
          && candidate.message_text === event.agentMessageDetails!.text,
        );
        if (!receipt) return event;
        used.add(receipt.id);
        receiptByToolId.set(event.toolId, receipt);
        return { ...event, agentMessageDetails: detailsWithAgentReceipt(event.agentMessageDetails, receipt) };
      }
      if (event.type !== 'tool_finished') return event;
      const receipt = receiptByToolId.get(event.toolId);
      if (!receipt) return event;
      const started = events.find((candidate) =>
        candidate.type === 'tool_started' && candidate.toolId === event.toolId,
      );
      return started?.type === 'tool_started' && started.agentMessageDetails
        ? { ...event, agentMessageDetails: detailsWithAgentReceipt(started.agentMessageDetails, receipt) }
        : event;
    });
  }

  function spliceTurnOrigins(conversationId: string, events: ConversationEvent[]): ConversationEvent[] {
    try {
      const rows = selectTurnOriginsStmt.all(conversationId) as Array<{
        turn_id: string;
        prompt_text: string;
        event_at: string;
        message_id: number | null;
        origin_json: string;
      }>;
      if (!rows.length) return events;
      let cursor = 0;
      return events.map((event) => {
        if (event.type !== 'turn_started') return event;
        const text = String(event.text).trim();
        const eventAt = Date.parse(event.at);
        let match = -1;
        for (let j = cursor; j < rows.length; j++) {
          const row = rows[j]!;
          const authored = row.prompt_text;
          const textMatches = authored.trim() === text || isMemoryWrappedPromptFor(text, authored);
          const rowAt = Date.parse(row.event_at);
          const timestampMatches = Number.isFinite(eventAt)
            && Number.isFinite(rowAt)
            && Math.abs(eventAt - rowAt) <= 5 * 60_000;
          // Codex/Grok keep Veneer's turn UUID; Claude rebuilds t1/t2 ids, so
          // timestamp proximity is the safe fallback for its native transcript.
          if (textMatches && (row.turn_id === event.turnId || timestampMatches)) {
            match = j;
            break;
          }
        }
        if (match < 0) return event;
        cursor = match + 1;
        const origin = parseMessageOrigin(rows[match]!.origin_json);
        const messageId = rows[match]!.message_id;
        return origin
          ? {
              ...event,
              origin,
              ...(messageId ? { messageId } : {}),
            }
          : event;
      });
    } catch {
      return events;
    }
  }

  // ── Per-turn memory recall (turn_recall) ───────────────────────────────────
  // The structured memories that produced this turn's "Remembered context"
  // block, persisted so a reloaded transcript can re-attach the per-message chip.
  const insertTurnRecallStmt = db.prepare(
    'INSERT INTO turn_recall (conversation_id, turn_id, prompt_text, payload) VALUES (?, ?, ?, ?)',
  );
  const selectTurnRecallStmt = db.prepare(
    'SELECT turn_id, prompt_text, payload FROM turn_recall WHERE conversation_id = ? ORDER BY id',
  );

  // Re-attach persisted per-prompt recall to a snapshot. On reload the native
  // transcript re-synthesizes turnIds (t1, t2, …) that no longer match the
  // UUIDs stored in turn_recall, so rows match turn_started events by prompt
  // text + order and the synthetic event carries the SNAPSHOT's turnId. Fail
  // open: any error returns the events unmodified.
  function spliceTurnRecall(conversationId: string, events: ConversationEvent[]): ConversationEvent[] {
    try {
      const rows = selectTurnRecallStmt.all(conversationId) as {
        turn_id: string;
        prompt_text: string;
        payload: string;
      }[];
      if (!rows.length) return events;
      const out: ConversationEvent[] = [];
      let cursor = 0;
      for (let i = 0; i < events.length; i++) {
        const event = events[i]!;
        if (event.type !== 'turn_started') {
          out.push(event);
          continue;
        }
        // Scan forward from the cursor so a stale row (e.g. a crash-resumed
        // turn inserted twice) can't block every later row from matching.
        const text = String(event.text).trim();
        let match = -1;
        for (let j = cursor; j < rows.length; j++) {
          const authored = rows[j]!.prompt_text;
          if (authored.trim() === text || isMemoryWrappedPromptFor(text, authored)) {
            match = j;
            break;
          }
        }
        if (match < 0) {
          out.push(event);
          continue;
        }
        const recall = rows[match]!;
        cursor = match + 1;
        // Provider-native transcripts contain the full prompt delivered to the
        // model. The normalized event seam exposes only what the user authored.
        out.push({ ...event, text: recall.prompt_text });
        // A live-buffered turn already carries its memory_recall inline —
        // consume the matching row but don't splice a duplicate.
        const next = events[i + 1];
        if (next && next.type === 'memory_recall' && next.turnId === event.turnId) continue;
        const parsed = JSON.parse(recall.payload) as unknown;
        const memories = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object' && Array.isArray((parsed as { memories?: unknown }).memories)
            ? (parsed as { memories: RecalledMemory[] }).memories
            : [];
        out.push({ type: 'memory_recall', turnId: event.turnId, memories });
      }
      return out;
    } catch {
      return events;
    }
  }

  // ── User stops (turn_stops) ────────────────────────────────────────────────
  const insertTurnStopStmt = db.prepare(
    'INSERT INTO turn_stops (conversation_id, stopped_at, reason) VALUES (?, ?, ?)',
  );
  const selectTurnStopsStmt = db.prepare(
    'SELECT stopped_at FROM turn_stops WHERE conversation_id = ? ORDER BY id',
  );

  /** Fail open: any error returns the events unmodified. */
  function spliceTurnStops(conversationId: string, events: ConversationEvent[]): ConversationEvent[] {
    try {
      const rows = selectTurnStopsStmt.all(conversationId) as { stopped_at: string }[];
      if (!rows.length) return events;
      return spliceUserStopNotices(events, rows.map((row) => row.stopped_at));
    } catch {
      return events;
    }
  }

  const insertApprovalStmt = db.prepare(
    'INSERT INTO approvals (conversation_id, request_id, tool_name, request_json) VALUES (?, ?, ?, ?)',
  );
  const insertAutoApprovalStmt = db.prepare(
    `INSERT INTO approvals
       (conversation_id, request_id, tool_name, request_json, status, resolved_by, resolved_at)
     VALUES (?, ?, ?, ?, 'approved', NULL, datetime('now'))`,
  );
  const fallbackAutoApprovalStmt = db.prepare(
    "UPDATE approvals SET status = 'pending', resolved_at = NULL WHERE id = ? AND status = 'approved'",
  );
  // Read at each approval event so Full Access, agent defaults, and chat
  // overrides changed during a live turn apply immediately.
  const approvalModeStmt = db.prepare(
    `SELECT c.approval_mode AS conversation_mode,
            a.approval_mode AS assistant_mode,
            a.full_access
       FROM conversations c
       JOIN assistants a ON a.id = c.assistant_id
      WHERE c.id = ?`,
  );
  const getApprovalStmt = db.prepare('SELECT * FROM approvals WHERE id = ?');
  const hasPendingStmt = db.prepare("SELECT 1 FROM approvals WHERE conversation_id = ? AND status = 'pending' LIMIT 1");
  const listPendingStmt = db.prepare("SELECT * FROM approvals WHERE conversation_id = ? AND status = 'pending'");
  const listConversationApprovalsStmt = db.prepare(
    'SELECT * FROM approvals WHERE conversation_id = ? ORDER BY id',
  );
  const expireStmt = db.prepare(
    "UPDATE approvals SET status = 'expired', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'",
  );
  const resolveStmt = db.prepare(
    "UPDATE approvals SET status = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'pending'",
  );
  const approvalTimers = new Map<number, NodeJS.Timeout>();

  function clearApprovalTimer(approvalId: number): void {
    const timer = approvalTimers.get(approvalId);
    if (timer) {
      clearTimeout(timer);
      approvalTimers.delete(approvalId);
    }
  }

  /** Emit an event outside the adapter callback: buffer into the live turn (if any) + fan out. */
  function emitConversationEvent(conversationId: string, event: ConversationEvent): void {
    const turn = live.get(conversationId)?.turn;
    if (turn) bufferEvent(turn, event);
    bus.emit('event', conversationId, event);
  }

  function armApprovalTimer(approvalId: number, conversationId: string, requestId: string): void {
    const timer = setTimeout(() => {
      approvalTimers.delete(approvalId);
      const row = getApprovalStmt.get(approvalId) as ApprovalRow | undefined;
      if (row?.status !== 'pending') return;
      // Deny toward the CLI so the turn continues, record as expired (≠ human deny).
      live.get(conversationId)?.respond?.(requestId, { behavior: 'deny', message: TIMEOUT_DENY_MESSAGE });
      expireStmt.run(approvalId);
      emitConversationEvent(conversationId, { type: 'approval_resolved', requestId, outcome: 'expired' });
      emitStatus(conversationId);
    }, approvalTimeoutMs);
    timer.unref?.();
    approvalTimers.set(approvalId, timer);
  }

  /** Turn is over (result, kill, or crash): unanswered approvals are dead. */
  function expirePendingApprovals(conversationId: string): void {
    const rows = listPendingStmt.all(conversationId) as ApprovalRow[];
    for (const row of rows) {
      clearApprovalTimer(row.id);
      expireStmt.run(row.id);
      emitConversationEvent(conversationId, { type: 'approval_resolved', requestId: row.request_id, outcome: 'expired' });
    }
  }

  // ── Questions ──────────────────────────────────────────────────────────────
  // The DB owns the public lifecycle. MCP ask_user polls it; provider-native
  // requests are delivered through the current TurnHandle using only Veneer ids.
  const insertQuestionStmt = db.prepare(
    `INSERT INTO questions
       (request_id, conversation_id, turn_id, response_mode, questions_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const getQuestionStmt = db.prepare('SELECT * FROM questions WHERE request_id = ?');
  const hasPendingQuestionStmt = db.prepare(
    "SELECT 1 FROM questions WHERE conversation_id = ? AND status = 'pending' LIMIT 1",
  );
  const listPendingQuestionsStmt = db.prepare(
    "SELECT * FROM questions WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at, request_id",
  );
  const listConversationQuestionsStmt = db.prepare(
    'SELECT * FROM questions WHERE conversation_id = ? ORDER BY created_at, request_id',
  );
  const resolveQuestionStmt = db.prepare(
    `UPDATE questions
        SET status = ?, answers_json = ?, resolved_at = datetime('now')
      WHERE request_id = ? AND status = 'pending'`,
  );
  const questionTimers = new Map<string, NodeJS.Timeout>();

  function hasPendingQuestion(conversationId: string): boolean {
    return Boolean(hasPendingQuestionStmt.get(conversationId));
  }

  function clearQuestionTimer(requestId: string): void {
    const timer = questionTimers.get(requestId);
    if (!timer) return;
    clearTimeout(timer);
    questionTimers.delete(requestId);
  }

  function normalizedQuestionAnswers(
    row: QuestionRow,
    input: QuestionAnswers | string,
  ): QuestionAnswers | null {
    const prompts = parseQuestionPrompts(row);
    if (!prompts.length) return null;
    const incoming: QuestionAnswers = typeof input === 'string'
      ? {
          [prompts[0]!.id]: prompts[0]!.multi
            ? input.split(', ').map((value) => value.trim()).filter(Boolean)
            : [input.trim()].filter(Boolean),
        }
      : input;
    const normalized: QuestionAnswers = {};
    for (const prompt of prompts) {
      const raw = incoming[prompt.id];
      if (!Array.isArray(raw) || raw.length === 0 || (!prompt.multi && raw.length !== 1)) return null;
      const allowed = new Set(prompt.options.map((option) => option.value));
      const answers = [...new Set(raw.map((value) => String(value).trim()).filter(Boolean))];
      if (!answers.length || answers.some((value) => value.length > 4_000)) return null;
      if (answers.some((value) => !allowed.has(value)) && !prompt.allowOther) return null;
      normalized[prompt.id] = answers;
    }
    return normalized;
  }

  function emitQuestionResolution(
    row: QuestionRow,
    status: 'answered' | 'expired' | 'dismissed',
    answers: QuestionAnswers,
  ): void {
    const first = parseQuestionPrompts(row)[0];
    emitConversationEvent(row.conversation_id, {
      type: 'question_answered',
      requestId: row.request_id,
      answers,
      answer: first ? (answers[first.id] ?? []).join(', ') : '',
      ...(status === 'expired' ? { expired: true } : {}),
      ...(status === 'dismissed' ? { dismissed: true } : {}),
    });
    emitStatus(row.conversation_id);
  }

  function finalizeQuestion(
    requestId: string,
    status: 'answered' | 'expired' | 'dismissed',
    input: QuestionAnswers | string = {},
  ): ResolveQuestionResult {
    const row = getQuestionStmt.get(requestId) as QuestionRow | undefined;
    if (!row) return { ok: false, error: 'not_found' };
    if (row.status !== 'pending') return { ok: false, error: 'not_pending' };

    const answers = status === 'answered' ? normalizedQuestionAnswers(row, input) : {};
    if (!answers) return { ok: false, error: 'invalid' };

    let finalStatus = status;
    let finalAnswers = answers;
    if (row.response_mode === 'provider') {
      const delivered = live.get(row.conversation_id)?.respondQuestion?.(requestId, answers) ?? false;
      if (status === 'answered' && !delivered) {
        finalStatus = 'expired';
        finalAnswers = {};
      }
    }

    clearQuestionTimer(requestId);
    resolveQuestionStmt.run(finalStatus, JSON.stringify(finalAnswers), requestId);
    emitQuestionResolution(row, finalStatus, finalAnswers);
    return status === 'answered' && finalStatus === 'expired'
      ? { ok: false, error: 'expired' }
      : { ok: true };
  }

  function armQuestionTimer(requestId: string, timeoutMs = approvalTimeoutMs): void {
    const timer = setTimeout(() => {
      questionTimers.delete(requestId);
      finalizeQuestion(requestId, 'expired');
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    questionTimers.set(requestId, timer);
  }

  /** Turn is over: any unanswered question is dead and its provider is released. */
  function expirePendingQuestions(conversationId: string): void {
    const rows = listPendingQuestionsStmt.all(conversationId) as QuestionRow[];
    for (const row of rows) finalizeQuestion(row.request_id, 'expired');
  }

  function entryFor(id: string): LiveConversation {
    let entry = live.get(id);
    if (!entry) {
      entry = {
        turn: null,
        maintenance: null,
        kill: null,
        steer: null,
        respond: null,
        respondQuestion: null,
        pendingSteerOrigins: [],
        steering: new Set(),
        queue: [],
        lastTurnFailed: false,
      };
      live.set(id, entry);
    }
    return entry;
  }

  function queueSnapshot(conversationId: string): ConversationQueueSnapshot {
    const steering = live.get(conversationId)?.steering ?? new Set<number>();
    const messages = (
      listConversationQueuedMessagesStmt.all(conversationId) as {
        id: number;
        prompt: string;
        created_at: string;
        origin_json: string | null;
      }[]
    ).map((row) => {
      const origin = parseMessageOrigin(row.origin_json);
      return {
        id: row.id,
        text: row.prompt,
        createdAt: row.created_at,
        ...(origin ? { origin } : {}),
        ...(steering.has(row.id) ? { delivered: true as const } : {}),
      };
    });
    const failed = failedTurnStmt.get(conversationId) as
      | { prompt: string; attempts: number; error: string | null }
      | undefined;
    return {
      revision: nextQueueRevision(),
      messages,
      failedTurn: failed
        ? {
            prompt: failed.prompt,
            attempts: failed.attempts,
            error: failed.error ?? 'This turn could not be recovered after repeated runner restarts.',
          }
        : null,
    };
  }

  function emitQueue(conversationId: string): ConversationQueueSnapshot {
    const snapshot = queueSnapshot(conversationId);
    bus.emit('queue', conversationId, snapshot);
    return snapshot;
  }

  function statusOf(conversationId: string): ConversationStatus {
    if (hasPendingStmt.get(conversationId) || hasPendingQuestion(conversationId)) return 'needs_you';
    const entry = live.get(conversationId);
    if (entry?.turn || entry?.maintenance) return 'working';
    if (failedTurnStmt.get(conversationId)) return 'failed';
    if (entry?.lastTurnFailed) return 'failed';
    return 'idle';
  }

  function activityOf(conversationId: string): ConversationActivity {
    return live.get(conversationId)?.maintenance?.kind === 'compaction' ? 'compacting' : null;
  }

  function bufferEvent(turn: LiveTurn, event: ConversationEvent): void {
    if (event.type === 'text_delta') {
      turn.partialText += event.text;
      return;
    }
    if (event.type === 'text_final') turn.partialText = '';
    if (event.type !== 'turn_done') turn.events.push(event);
  }

  function emitStatus(conversationId: string): void {
    bus.emit('status', conversationId, statusOf(conversationId), activityOf(conversationId));
  }

  async function runNext(conv: ConversationRow): Promise<void> {
    const entry = entryFor(conv.id);
    if (entry.turn || entry.maintenance) return;
    // Callers may have queued work before a provider switch. Always spawn from the current row.
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id) as ConversationRow;
    if (!conv) return;
    // A turn that exhausted recovery remains visible/retryable. Do not run later
    // messages past it until the user explicitly retries or skips it.
    if (failedTurnStmt.get(conv.id)) return;
    const item = entry.queue.shift();
    if (item === undefined) return;
    if (!roomSessionAllowed(db, conv.id, item.actorUserId) || (item.id !== null && !queuedRoomWakeAllowed(db, conv.id, item.id))) {
      if (item.id !== null) deleteQueuedMessageStmt.run(item.id);
      db.prepare('DELETE FROM pending_turns WHERE conversation_id=?').run(conv.id);
      emitQueue(conv.id);
      void runNext(conv);
      return;
    }
    const discussion = item.id === null ? undefined : queuedDiscussionWake(db, conv.id, item.id);
    if (discussion && !botWakeAllowed(db, discussion, conv)) {
      deleteQueuedMessageStmt.run(item.id);
      recordDiscussionDelivery(db, discussion.id, 'cancelled', 'Access or proposal version changed before queued execution');
      emitQueue(conv.id);
      void runNext(conv);
      return;
    }
    if (discussion) recordDiscussionDelivery(db, discussion.id, 'turn_started');
    const text = item.prompt;
    const skillPrompt = providerSkillPrompt(conv.provider, text);
    const visibleText = skillPrompt.visible;
    const actorUserId = item.actorUserId;
    const origin = item.origin;
    // The message is now running, not waiting — drop its durable queue row.
    if (item.id !== null) {
      deleteQueuedMessageStmt.run(item.id);
      emitQueue(conv.id);
    }

    const turnId = crypto.randomUUID();
    const turn: LiveTurn = { turnId, promptText: visibleText, actorUserId, origin, events: [], partialText: '' };
    const connectorSources = connectorToolSourcesForConversation(db, conv.id, actorUserId);
    entry.turn = turn;
    entry.lastTurnFailed = false;
    // Record the in-flight turn so a restart/ship/crash mid-turn can resume it.
    // On a fresh turn there's no prior row (attempts→1); on a resume the row
    // survives and attempts increments, so a turn that keeps crashing gives up.
    recordPendingTurnStmt.run(conv.id, text, actorUserId, messageOriginJson(origin));
    if (discussion) db.prepare('UPDATE pending_turns SET discussion_message_id=? WHERE conversation_id=?').run(discussion.id, conv.id);

    // Has this native session ever run a turn? First turn uses --session-id.
    const firstTurn = isFirstTurn(conv.id);

    const emit = (event: ConversationEvent): void => {
      if (['turn_done', 'error', 'approval_requested', 'question_asked'].includes(event.type)) {
        clearDiscussionActivity.run(conv.id);
      }
      if (event.type === 'turn_started') {
        let eventOrigin = event.origin;
        let eventMessageId = event.messageId;
        if (!eventOrigin) {
          const steerIndex = entry.pendingSteerOrigins.findIndex(
            (pending) => pending.text.trim() === event.text.trim(),
          );
          if (steerIndex >= 0) {
            eventOrigin = entry.pendingSteerOrigins[steerIndex]!.origin;
            eventMessageId = entry.pendingSteerOrigins[steerIndex]!.messageId;
          }
        }
        if (eventOrigin) {
          Object.assign(event, {
            origin: eventOrigin,
            ...(eventMessageId ? { messageId: eventMessageId } : {}),
          });
          insertTurnOriginStmt.run(
            conv.id,
            event.turnId,
            event.text,
            event.at,
            eventMessageId ?? null,
            messageOriginJson(eventOrigin),
          );
        }
      }
      let enriched = enrichConnectorToolEvent(event, connectorSources);
      enriched = enrichLiveAgentMessageEvent(conv.id, enriched, turn.events);
      // Codex persists the same event object after its synchronous onEvent
      // callback returns. Mutating here makes the metadata durable there while
      // Claude history is re-enriched from its native transcript on snapshot.
      if (enriched !== event) Object.assign(event, enriched);
      bufferEvent(turn, event);
      bus.emit('event', conv.id, event);
    };

    const adapter = adapters[conv.provider];
    if (!adapter) {
      emit({ type: 'error', message: `No "${conv.provider}" provider is configured.`, fatal: true });
      emit({ type: 'turn_done', turnId, outcome: 'failed' });
      entry.turn = null;
      entry.lastTurnFailed = true;
      clearPendingTurnStmt.run(conv.id);
      emitStatus(conv.id);
      return;
    }

    emit({
      type: 'turn_started',
      turnId,
      role: 'user',
      text: visibleText,
      at: new Date().toISOString(),
      via: conv.channel,
      ...(origin ? { origin } : {}),
      ...(item.id ? { messageId: item.id } : {}),
    });
    emitStatus(conv.id);
    touchStmt.run(conv.id);

    // Resolve where this conversation runs (scratch workspace, or the source
    // checkout for the platform-dev agent). cwd + toolbox config both key off it.
    const workspace = resolveWorkspace(conv);
    // Resuming needs the provider's own session file to still be there. Put it
    // back from the archive first if the provider purged it (Claude Code
    // deletes session JSONLs after cleanupPeriodDays).
    // Guarded rather than `await archive?.…`: with no archive configured this
    // must not introduce a microtask before the spawn.
    if (transcriptArchive && !firstTurn) {
      await transcriptArchive.restore(conv.provider, {
        cwd: workspace.workspaceDir,
        nativeSessionId: conv.native_session_id,
      });
    }

    // Materialize toolbox state so this turn's spawn picks up the latest
    // connections and policies without a restart (spec §11.3).
    let spawnConfig: {
      mcpConfigPath: string | null;
      settingsPath: string | null;
      developerInstructions: string | null;
      instructionHash: string | null;
    } = {
      mcpConfigPath: null,
      settingsPath: null,
      developerInstructions: null,
      instructionHash: null,
    };
    const isolatedRoom = Boolean(db.prepare('SELECT 1 FROM team_room_workers WHERE conversation_id=?').get(conv.id));
    let memoryBlock: string | null = null;
    try {
      // Memory reads and the optional semantic gate are bounded and fail open.
      const recall = !isolatedRoom && loadMemoryBlock ? await loadMemoryBlock(conv, visibleText, { firstTurn }) : null;
      memoryBlock = recall?.block ?? null;
      const memories = recall?.memories ?? [];
      // Persist every successful recall attempt, including an empty result, so
      // precision/empty-result telemetry can be audited. Only non-empty sets
      // need a live chip event.
      if (recall) {
        insertTurnRecallStmt.run(conv.id, turnId, visibleText, JSON.stringify({
          version: 2,
          memories,
          diagnostics: recall.diagnostics,
        }));
        if (memories.length > 0) emit({ type: 'memory_recall', turnId, memories });
      }
    } catch (err) {
      log.warn(`[runtime] memory context omitted: ${(err as Error).message}`);
    }
    const continuation = providerContext(conv.id);
    if (continuation?.pending) {
      memoryBlock = [continuation.handoff, memoryBlock].filter(Boolean).join('\n\n');
      // Even when memory recall is disabled, strip the context wrapper from visible history.
      if (!db.prepare('SELECT 1 FROM turn_recall WHERE conversation_id = ? AND turn_id = ?').get(conv.id, turnId)) {
        insertTurnRecallStmt.run(conv.id, turnId, visibleText, JSON.stringify([]));
      }
    }
    try {
      // Core rules and the fixed snapshot must survive a toolbox write failure.
      // A provider turn must never start with missing Veneer developer context.
      const fallbackInstructions = prepareConversationInstructions(db, workspace, conv.id, memoryBlock);
      spawnConfig.developerInstructions = fallbackInstructions.developerInstructions;
      spawnConfig.instructionHash = fallbackInstructions.instructionHash;
    } catch (err) {
      log.error(`[runtime] instruction preparation failed; turn stopped: ${(err as Error).message}`);
      emit({ type: 'error', message: 'Could not prepare the required chat instructions.', fatal: true });
      emit({ type: 'turn_done', turnId, outcome: 'failed' });
      entry.turn = null;
      entry.lastTurnFailed = true;
      clearPendingTurnStmt.run(conv.id);
      emitStatus(conv.id);
      return;
    }
    if (materialize) {
      try {
        // The callback identity and personal connector set stay bound to the
        // authenticated user who initiated this turn, even in a Team chat.
        const actorEmail = (activeUserEmailStmt.get(actorUserId) as { email: string } | undefined)?.email;
        if (!actorEmail) throw new Error('The user who initiated this turn is no longer active.');
        spawnConfig = materialize(
          workspace,
          mintAgentToken(db, actorEmail, conv.id),
          conv.id,
          actorUserId,
          memoryBlock,
        );
      } catch (err) {
        log.warn(`[runtime] toolbox materialization failed; continuing with required instructions only: ${(err as Error).message}`);
        spawnConfig.mcpConfigPath = null;
        spawnConfig.settingsPath = null;
      }
    }

    if (continuation) {
      spawnConfig.developerInstructions = `${spawnConfig.developerInstructions ?? ''}\n\n${PROVIDER_CONTINUATION_RULES}`;
      spawnConfig.instructionHash = crypto.createHash('sha256').update(spawnConfig.developerInstructions).digest('hex');
    }

    let sawError = false;
    let terminalOutcome: TurnOutcome | null = null;
    // Did this turn actually establish the native session (complete the API
    // round trip)? Only then is the session resumable, so only then may we flip
    // isFirstTurn off. Signals: for Claude the session file lands once the round
    // trip produces content (any assistant event below); for Codex the thread id
    // arrives via onSessionId. A turn that dies before either never created a
    // session and must stay a first turn (else every future --resume 404s).
    //
    // Crucially we persist this the MOMENT it's true (markSessionEstablished),
    // not at handle.done — a ship/restart/crash kills the process mid-turn so
    // done never runs, yet the session file already exists on disk. Resuming
    // such a turn with --session-id (isFirstTurn still true) fails hard with
    // "Session ID … is already in use"; only --resume recovers it.
    let sessionEstablished = false;
    const markSessionEstablished = (): void => {
      if (sessionEstablished) return;
      sessionEstablished = true;
      markTurnRan(conv.id);
      if (
        spawnConfig.instructionHash &&
        conv.provider_instruction_hash !== spawnConfig.instructionHash
      ) {
        conv.provider_instruction_hash = spawnConfig.instructionHash;
        updateProviderInstructionHashStmt.run(spawnConfig.instructionHash, conv.id);
      }
    };
    const handle = adapter.runTurn(
      {
        cwd: workspace.workspaceDir,
        conversationId: conv.id,
        nativeSessionId: conv.native_session_id,
        firstTurn,
        model: conv.model,
        effort: conv.effort,
        displayPrompt: visibleText,
        prompt: promptWithMemoryReference(skillPrompt.prompt, memoryBlock, skillPrompt.skillName !== null),
        turnId,
        mcpConfigPath: spawnConfig.mcpConfigPath,
        settingsPath: spawnConfig.settingsPath,
        developerInstructions: spawnConfig.developerInstructions,
        refreshDeveloperInstructions:
          (conv.provider === 'codex' || conv.provider === 'grok') &&
          !firstTurn &&
          Boolean(spawnConfig.instructionHash) &&
          conv.provider_instruction_hash !== spawnConfig.instructionHash,
        dangerous: workspace.fullAccess ?? false,
      },
      (event) => {
        if (event.type === 'text_final') {
          event.markdown = guardLoopbackDeliverableMarkdown(turn.promptText, event.markdown);
        }
        if (event.type === 'error') sawError = true;
        else if (event.type === 'turn_done') {
          // Modern adapters report the terminal result explicitly. Keep the
          // error fallback for legacy emitters, but let a recovered turn's
          // completed outcome clear the live failure badge.
          terminalOutcome = event.outcome ?? (sawError ? 'failed' : 'completed');
        }
        // Any assistant-side event means the round trip happened → session exists.
        // 'notice' (e.g. a user Stop) is not assistant output and may fire before
        // the round trip, so it must not flip the first-turn flag.
        else if (event.type !== 'turn_started' && event.type !== 'notice')
          markSessionEstablished();
        if (event.type === 'approval_requested') {
          const mode = approvalModeStmt.get(conv.id) as
            | {
                conversation_mode: 'ask' | 'auto' | null;
                assistant_mode: 'ask' | 'auto';
                full_access: 0 | 1;
              }
            | undefined;
          const effectiveMode = resolveEffectiveApprovalMode(
            Boolean(mode?.full_access),
            mode?.conversation_mode,
            mode?.assistant_mode,
          );
          if (effectiveMode === 'auto' && entry.respond) {
            const info = insertAutoApprovalStmt.run(
              conv.id,
              event.requestId,
              event.toolName,
              JSON.stringify(event.input ?? null),
            );
            const approvalId = Number(info.lastInsertRowid);
            if (entry.respond(event.requestId, { behavior: 'allow' })) return;
            // The CLI disappeared between the null-guard and the response.
            // Preserve the same row but restore the normal pending lifecycle.
            fallbackAutoApprovalStmt.run(approvalId);
            event = { ...event, approvalId };
            armApprovalTimer(approvalId, conv.id, event.requestId);
          } else {
            const info = insertApprovalStmt.run(
              conv.id,
              event.requestId,
              event.toolName,
              JSON.stringify(event.input ?? null),
            );
            const approvalId = Number(info.lastInsertRowid);
            event = { ...event, approvalId };
            armApprovalTimer(approvalId, conv.id, event.requestId);
          }
        } else if (event.type === 'question_asked') {
          // Adapters provide already-sanitized public prompts. Force the local
          // turn id and persist before the browser can attempt to answer.
          event = { ...event, turnId: turn.turnId };
          insertQuestionStmt.run(
            event.requestId,
            conv.id,
            turn.turnId,
            event.responseMode,
            JSON.stringify(event.questions),
          );
          armQuestionTimer(
            event.requestId,
            event.autoResolutionMs === null || event.autoResolutionMs === undefined
              ? approvalTimeoutMs
              : event.autoResolutionMs,
          );
        }
        // Persist the turn's input-token count so the composer's context readout
        // survives a reload (the live event carries it to already-open clients).
        if (event.type === 'turn_done' && event.usage) {
          updateContextTokensStmt.run(event.usage.inputTokens, conv.id);
        }
        emit(event);
        if (event.type === 'approval_requested' || event.type === 'question_asked') emitStatus(conv.id);
      },
      (nativeSessionId) => {
        // Codex discovers its own thread id instead of accepting one up
        // front (Claude never calls this) — mirror it onto the in-memory row
        // (readTitle/readModel below key off conv.native_session_id) and DB.
        // Being called at all means the native session now exists.
        // Persist the new id before the instruction hash. If either write ever
        // fails, a retry may fork again but cannot resume the stale old thread
        // while incorrectly believing the new developer context was applied.
        if (nativeSessionId !== conv.native_session_id) {
          updateNativeSessionIdStmt.run(nativeSessionId, conv.id);
          conv.native_session_id = nativeSessionId;
        }
        markSessionEstablished();
      },
    );
    entry.kill = handle.kill;
    entry.steer = handle.steer ?? null;
    entry.respond = handle.respondToApproval;
    entry.respondQuestion = handle.respondToQuestion ?? null;

    void handle.done.then(() => {
      // Turn reached a clean end (result, user interrupt, or timeout) — not a
      // process death — so it should NOT auto-resume. On a restart the process
      // exits before this runs, leaving the row for boot-time resume.
      clearPendingTurnStmt.run(conv.id);
      // Backstop: markSessionEstablished already persisted this the instant the
      // session first existed (so a mid-turn kill still flips isFirstTurn off).
      // Re-assert here for the rare adapter that finishes cleanly without ever
      // emitting an assistant event. A turn that died before the round trip
      // leaves sessionEstablished false → stays a first turn, as intended.
      if (sessionEstablished) markTurnRan(conv.id);
      expirePendingApprovals(conv.id);
      expirePendingQuestions(conv.id);
      entry.turn = null;
      entry.kill = null;
      entry.steer = null;
      entry.respond = null;
      entry.respondQuestion = null;
      entry.lastTurnFailed = terminalOutcome === null
        ? sawError
        : terminalOutcome === 'failed' || terminalOutcome === 'timed_out';
      touchStmt.run(conv.id);
      emitStatus(conv.id);
      // Keep a Veneer-owned copy of the provider's transcript file: Claude Code
      // purges its session JSONL after cleanupPeriodDays and snapshot() has no
      // other source of history.
      void transcriptArchive?.archive(conv.provider, {
        cwd: workspace.workspaceDir,
        nativeSessionId: conv.native_session_id,
      });
      // Mirror the provider's auto-generated title (e.g. Claude Code's rolling
      // "ai-title") into the DB; a no-op once the user has renamed the chat.
      if (adapter.readTitle) {
        void adapter
          .readTitle({ cwd: workspace.workspaceDir, nativeSessionId: conv.native_session_id })
          .then((title) => {
            if (title) updateAutoTitleStmt.run(title, conv.id);
          })
          .catch((err: Error) => log.warn(`[runtime] readTitle failed: ${err.message}`));
      }
      // Report the answering model separately; a failed transcript may only
      // contain an older model and must never overwrite the user's selection.
      if (!sawError && terminalOutcome === 'completed') {
        db.prepare('UPDATE conversation_provider_context SET pending = 0 WHERE conversation_id = ?').run(conv.id);
        if (adapter.readModel) {
          void adapter.readModel({ cwd: workspace.workspaceDir, nativeSessionId: conv.native_session_id })
            .then((model) => {
              if (model) updateModelStmt.run(model, conv.provider, conv.id, conv.provider, conv.native_session_id);
            }).catch((err: Error) => log.warn(`[runtime] readModel failed: ${err.message}`));
        }
      }
      if (!isolatedRoom && !sawError && captureMemoryTurn && turn.events.some((event) => event.type === 'text_final')) {
        const captureEvents = [...turn.events];
        void captureMemoryTurn(conv, captureEvents).catch((err: Error) =>
          log.warn(`[runtime] memory capture failed: ${err.message}`),
        );
      }
      // Refetch the row in case it changed while the turn ran.
      const fresh = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id) as ConversationRow | undefined;
      if (fresh && entry.queue.length) void runNext(fresh);
    });
  }

  // First-turn tracking: --session-id (create) vs --resume. Kept in settings so
  // it survives restarts (the session file may exist from a crashed first turn,
  // but the session is only resumable once a turn completed the API round trip).
  const getRan = db.prepare("SELECT value_json FROM settings WHERE key = ?");
  const setRan = db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  );
  function isFirstTurn(conversationId: string): boolean {
    return !getRan.get(`turn_ran:${conversationId}`);
  }
  function markTurnRan(conversationId: string): void {
    setRan.run(`turn_ran:${conversationId}`, 'true');
  }

  function enqueueMessage(
    conv: ConversationRow,
    text: string,
    dismissQuestions: boolean,
    idempotency?: { key: string; sourceKind: 'wakeup' },
    actorUserId: number | null = conv.user_id,
    origin?: MessageOrigin,
    onPersisted?: () => void,
  ): PostMessageResult {
    const entry = entryFor(conv.id);
    const disposition: PostMessageResult['disposition'] =
      entry.turn || entry.maintenance || failedTurnStmt.get(conv.id) ? 'queued' : 'running';
    if (dismissQuestions) {
      // Chatting past a pending question dismisses it: otherwise a normal send
      // would sit behind the blocked ask_user call. Explicit queueing does not
      // dismiss it; the user chose to let the current turn finish first.
      const questions = listPendingQuestionsStmt.all(conv.id) as QuestionRow[];
      for (const question of questions) finalizeQuestion(question.request_id, 'dismissed');
    }
    let messageId: number;
    if (idempotency) {
      const stored = db.transaction(() => {
        const existing = findInboundReceiptStmt.get(idempotency.key) as
          | { conversation_id: string; message_id: number; source_kind: string }
          | undefined;
        if (existing) {
          if (existing.conversation_id !== conv.id || existing.source_kind !== idempotency.sourceKind) {
            throw new Error('Idempotency key belongs to another delivery');
          }
          return { messageId: existing.message_id, duplicate: true };
        }
        const info = insertQueuedMessageStmt.run(
          conv.id,
          text,
          actorUserId,
          messageOriginJson(origin),
          conv.id,
        );
        const id = Number(info.lastInsertRowid);
        insertInboundReceiptStmt.run(idempotency.key, conv.id, id, idempotency.sourceKind);
        onPersisted?.();
        return { messageId: id, duplicate: false };
      })();
      if (stored.duplicate) {
        return { messageId: stored.messageId, disposition: 'duplicate', queue: queueSnapshot(conv.id) };
      }
      messageId = stored.messageId;
    } else {
      messageId = Number(insertQueuedMessageStmt.run(
        conv.id,
        text,
        actorUserId,
        messageOriginJson(origin),
        conv.id,
      ).lastInsertRowid);
    }
    entry.queue.push({ id: messageId, prompt: text, actorUserId, ...(origin ? { origin } : {}) });
    emitQueue(conv.id);
    void runNext(conv);
    return {
      messageId,
      disposition,
      queue: queueSnapshot(conv.id),
    };
  }

  async function steerQueued(
    conv: ConversationRow, text: string, posted: PostMessageResult,
    actorUserId: number | null, origin?: MessageOrigin, onConsumed?: () => void,
  ): Promise<PostMessageResult> {
      if (posted.disposition === 'duplicate') return posted;
      if (posted.disposition !== 'queued') return posted;
      const entry = entryFor(conv.id);
      const steer = entry.steer;
      // Each reason is reported back so the sending agent can tell "the chat is
      // busy compacting" from "this provider cannot be steered at all".
      const queued = (steerReason: SteerReason): PostMessageResult => ({
        ...posted,
        disposition: 'queued',
        steerReason,
        queue: queueSnapshot(conv.id),
      });
      // A turn that exhausted recovery blocks the queue until the user retries.
      if (failedTurnStmt.get(conv.id)) return queued('failed_turn');
      if (!entry.turn) return queued(entry.maintenance ? 'maintenance' : 'no_live_turn');
      // A live provider process already has one actor's personal connectors.
      // Another user's guidance must wait for a fresh, correctly scoped turn.
      if (entry.turn.actorUserId !== actorUserId) return queued('other_actor');
      if (!steer) return queued('no_steer_support');

      // Once another input enters this turn, exclusive discussion focus is unknown.
      // Even a failed steer must not restore a potentially stale activity claim.
      clearDiscussionActivity.run(conv.id);

      // The origin is consumed when the provider replays the line as a synthetic
      // turn_started, which may be long after this call returns. Keep it pending
      // until the acknowledgement settles either way.
      if (origin) entry.pendingSteerOrigins.push({ messageId: posted.messageId, text, origin });
      // The line now lives in the provider's stdin as well as the queue table, so
      // editing or removing that row would desynchronize the two.
      entry.steering.add(posted.messageId);
      const steeredTurn = entry.turn;
      const releasePending = (): void => {
        entry.pendingSteerOrigins = entry.pendingSteerOrigins.filter(
          (pending) => pending.messageId !== posted.messageId,
        );
        entry.steering.delete(posted.messageId);
        if (entry.steering.size === 0) emitQueue(conv.id);
      };
      /** Drop the durable fallback: the provider consumed the line inside the live turn. */
      const commit = (): void => {
        // Only the turn this steer was issued against can consume it. A Stop or
        // "Send now" replaces that turn, and a late echo from the dying process
        // must not retire a row whose message nobody will ever answer.
        if (entry.turn !== steeredTurn || steeredTurn.discarded) return;
        const deleted = db.transaction(() => {
          const result = deleteConversationQueuedMessageStmt.run(posted.messageId, conv.id);
          if (result.changes > 0) onConsumed?.();
          return result;
        })();
        if (deleted.changes > 0) {
          entry.queue = entry.queue.filter((item) => item.id !== posted.messageId);
          emitQueue(conv.id);
        }
      };

      let outcome: boolean | SteerDelivery;
      try {
        outcome = await steer(text);
      } catch (err) {
        releasePending();
        log.warn(`[runtime] steer failed for ${conv.id}; retaining queued fallback: ${(err as Error).message}`);
        return queued('write_failed');
      }
      if (outcome === false) {
        releasePending();
        return queued('write_failed');
      }
      if (outcome === true) {
        releasePending();
        commit();
        return { messageId: posted.messageId, disposition: 'steered', queue: queueSnapshot(conv.id) };
      }

      const acknowledged = outcome.acknowledged.then(
        (ok) => {
          releasePending();
          return ok;
        },
        (err: Error) => {
          releasePending();
          log.warn(`[runtime] steer acknowledgement failed for ${conv.id}: ${err.message}`);
          return false;
        },
      );
      const raced = await Promise.race([
        acknowledged,
        new Promise<'waiting'>((resolve) => {
          const timer = setTimeout(() => resolve('waiting'), steerAckWaitMs);
          timer.unref?.();
        }),
      ]);
      // Provider acknowledgement is the commit point: only now may the durable
      // fallback disappear. Later queued messages keep their order.
      if (raced === true) {
        commit();
        return { messageId: posted.messageId, disposition: 'steered', queue: queueSnapshot(conv.id) };
      }
      // The turn ended without consuming the line; runNext runs it as a fresh turn.
      if (raced === false) return queued('no_live_turn');

      // Still in flight. The write landed, so report delivery, but keep the
      // durable row: if the process dies before reading the line, runNext must
      // still own it. When the echo does arrive, retire the row then.
      acknowledged
        .then((ok) => {
          if (ok) commit();
        })
        .catch((err: Error) => {
          log.warn(`[runtime] steer cleanup failed for ${conv.id}: ${err.message}`);
        });
      return {
        messageId: posted.messageId,
        disposition: 'delivered',
        queue: queueSnapshot(conv.id),
      };
  }

  return {
    bus,
    postMessage(conv, text, actorUserId = conv.user_id, origin) {
      return enqueueMessage(conv, text, true, undefined, actorUserId, origin);
    },
    async steerMessage(conv, text, _idempotencyKey, actorUserId = conv.user_id, origin) {
      const posted = enqueueMessage(conv, text, true, undefined, actorUserId, origin);
      return steerQueued(conv, text, posted, actorUserId, origin);
    },
    queueMessage(conv, text, actorUserId = conv.user_id, origin) {
      return enqueueMessage(conv, text, false, undefined, actorUserId, origin);
    },
    deliverWakeup(conv, text, wakeupId, actorUserId = conv.user_id) {
      const discussion = botDiscussionWake(db, wakeupId);
      if (discussion && !botWakeAllowed(db, discussion, conv)) throw new Error('Discussion access or version changed');
      const name = assistantNameFor(conv);
      const origin: MessageOrigin = { kind: 'wakeup', from: name, to: name };
      const posted = enqueueMessage(conv, text, false, {
        key: `wakeup:${wakeupId}`, sourceKind: 'wakeup',
      }, actorUserId, origin, discussion ? () => recordDiscussionDelivery(db, wakeupId, 'queued') : undefined);
      if (discussion && posted.disposition !== 'duplicate') {
        if (posted.disposition === 'queued') {
          // The original durable row remains until the provider acknowledges it.
          // Retries use the receipt above and never issue another steer.
          void steerQueued(conv, text, posted, actorUserId, origin, () =>
            recordDiscussionDelivery(db, wakeupId, 'provider_consumed'),
          ).then(result => {
            if (result.disposition !== 'steered') {
              const stage = result.disposition === 'delivered' ? 'written_awaiting_ack' : 'queued_fallback';
              recordDiscussionDelivery(db, wakeupId, stage, result.steerReason);
            }
          }).catch(() => recordDiscussionDelivery(db, wakeupId, 'queued_fallback', 'steer_failed'));
        }
      }
      return posted;
    },
    queueSnapshot,
    updateQueuedMessage(conversationId, messageId, text, actorUserId) {
      // The live process already holds this exact text; editing only the row
      // would leave the agent acting on the old wording.
      if (live.get(conversationId)?.steering.has(messageId)) {
        return { ok: false, error: 'conflict', queue: queueSnapshot(conversationId) };
      }
      const result = updateQueuedMessageStmt.run(text, actorUserId ?? null, messageId, conversationId);
      if (result.changes === 0) return { ok: false, error: 'not_found', queue: queueSnapshot(conversationId) };
      const item = live.get(conversationId)?.queue.find((queued) => queued.id === messageId);
      if (item) {
        item.prompt = text;
        if (actorUserId !== undefined) item.actorUserId = actorUserId;
      }
      return { ok: true, queue: emitQueue(conversationId) };
    },
    removeQueuedMessage(conversationId, messageId) {
      // Deleting the row cannot unsend what the provider already read.
      if (live.get(conversationId)?.steering.has(messageId)) {
        return { ok: false, error: 'conflict', queue: queueSnapshot(conversationId) };
      }
      const result = deleteConversationQueuedMessageStmt.run(messageId, conversationId);
      if (result.changes === 0) return { ok: false, error: 'not_found', queue: queueSnapshot(conversationId) };
      const entry = live.get(conversationId);
      if (entry) entry.queue = entry.queue.filter((queued) => queued.id !== messageId);
      return { ok: true, queue: emitQueue(conversationId) };
    },
    reorderQueuedMessages(conversationId, messageIds) {
      const current = queueSnapshot(conversationId).messages.map((message) => message.id);
      const unique = new Set(messageIds);
      if (
        unique.size !== messageIds.length ||
        current.length !== messageIds.length ||
        current.some((id) => !unique.has(id))
      ) {
        return { ok: false, error: 'conflict', queue: queueSnapshot(conversationId) };
      }
      db.transaction(() => {
        messageIds.forEach((id, index) => setQueuedMessageOrderStmt.run(index + 1, id, conversationId));
      })();
      const entry = live.get(conversationId);
      if (entry) {
        const durable = new Map(
          entry.queue.filter((item): item is QueuedMessageWork & { id: number } => item.id !== null).map((item) => [item.id, item]),
        );
        const resumed = entry.queue.filter((item) => item.id === null);
        entry.queue = [...resumed, ...messageIds.flatMap((id) => (durable.has(id) ? [durable.get(id)!] : []))];
      }
      return { ok: true, queue: emitQueue(conversationId) };
    },
    sendQueuedMessageNow(conv, messageId) {
      const current = queueSnapshot(conv.id).messages.map((message) => message.id);
      if (!current.includes(messageId)) {
        return { ok: false, error: 'not_found', queue: queueSnapshot(conv.id) };
      }
      // "Send now" normally interrupts an active turn, but maintenance must
      // finish first so a new native turn cannot overlap provider compaction.
      if (live.get(conv.id)?.maintenance || failedTurnStmt.get(conv.id)) {
        return { ok: false, error: 'conflict', queue: queueSnapshot(conv.id) };
      }

      // Make the clicked row the next turn before interrupting. This matters
      // when several follow-ups are waiting: "Send now" must send the message
      // the user chose, not merely whichever message happened to be first.
      const reordered = [messageId, ...current.filter((id) => id !== messageId)];
      const result = this.reorderQueuedMessages(conv.id, reordered);
      if (!result.ok) return result;

      // Both Claude and Codex implement kill() through their native interrupt
      // mechanisms. Once handle.done settles, runNext() drains the promoted
      // queued message. If the active turn ended in the meantime, start it now.
      //
      // 'send_now', not 'user': the point is to replace what the parent is
      // working on, not to abandon the agents it already delegated to.
      if (!this.interrupt(conv.id, 'send_now')) void runNext(conv);
      return { ok: true, queue: queueSnapshot(conv.id) };
    },
    retryFailedTurn(conv, actorUserId) {
      const entry = entryFor(conv.id);
      if (entry.turn || entry.maintenance) {
        return { ok: false, error: 'conflict', queue: queueSnapshot(conv.id) };
      }
      const failed = failedTurnStmt.get(conv.id) as {
        prompt: string;
        actor_user_id: number | null;
        origin_json: string | null;
      } | undefined;
      if (!failed || retryPendingTurnStmt.run(conv.id).changes === 0) {
        return { ok: false, error: 'not_found', queue: queueSnapshot(conv.id) };
      }
      const origin = parseMessageOrigin(failed.origin_json);
      entryFor(conv.id).queue.unshift({
        id: null,
        prompt: failed.prompt,
        actorUserId: actorUserId ?? failed.actor_user_id,
        ...(origin ? { origin } : {}),
      });
      void runNext(conv);
      emitStatus(conv.id);
      return { ok: true, queue: emitQueue(conv.id) };
    },
    discardFailedTurn(conv) {
      if (discardFailedTurnStmt.run(conv.id).changes === 0) {
        return { ok: false, error: 'not_found', queue: queueSnapshot(conv.id) };
      }
      void runNext(conv);
      emitStatus(conv.id);
      return { ok: true, queue: emitQueue(conv.id) };
    },
    async switchProvider(conv, selection) {
      const entry = entryFor(conv.id);
      if (entry.turn || entry.maintenance || hasPendingStmt.get(conv.id) || hasPendingQuestion(conv.id)) {
        return { ok: false, message: 'Finish or stop the current reply before switching models.' };
      }
      const adapter = adapters[selection.provider];
      if (!adapter) return { ok: false, message: 'This provider is not configured.' };
      const maintenance: NonNullable<LiveConversation['maintenance']> = {
        kind: 'provider-switch', kill() {}, interrupted: false,
      };
      entry.maintenance = maintenance;
      emitStatus(conv.id);
      try {
        if (selection.provider === conv.provider) {
          db.prepare('UPDATE conversations SET model = ?, effort = ? WHERE id = ?')
            .run(selection.model, selection.effort, conv.id);
          return { ok: true };
        }
        const models = await adapter.listModels?.() ?? [];
        if (!models.length || (selection.model && !models.some((model) => model.id === selection.model))) {
          return { ok: false, message: 'This model is not available. Connect the provider and refresh its model list.' };
        }
        const history = namespaceHistory(await this.snapshot(conv));
        const files = await this.listSessionFiles(conv);
        if (maintenance.interrupted) return { ok: false, message: 'Model switch canceled.' };
        const handoff = writeProviderHandoff(resolveWorkspace(conv).workspaceDir, conv.id, history);
        const notice: ConversationEvent = {
          type: 'notice', at: new Date().toISOString(),
          message: `Switched from ${conv.provider} to ${selection.provider} (${selection.model ?? 'default model'}). Earlier history is preserved; the next reply receives recorded context in a fresh provider session.`,
        };
        history.push(notice);
        const nativeSessionId = adapter.mintSessionId();
        db.transaction(() => {
          db.prepare(`INSERT INTO conversation_provider_context (conversation_id, history_json, files_json, handoff)
            VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET
            history_json = excluded.history_json, files_json = excluded.files_json,
            handoff = excluded.handoff, pending = 1, updated_at = datetime('now')`)
            .run(conv.id, JSON.stringify(history), JSON.stringify(files), handoff);
          db.prepare(`UPDATE conversations SET provider = ?, model = ?, effort = ?, native_session_id = ?,
            provider_instruction_hash = NULL, last_input_tokens = NULL, files_synced_at = NULL,
            title_auto = CASE WHEN title IS NOT NULL THEN 0 ELSE title_auto END WHERE id = ?`)
            .run(selection.provider, selection.model, selection.effort, nativeSessionId, conv.id);
          db.prepare('DELETE FROM settings WHERE key = ?').run(`turn_ran:${conv.id}`);
        })();
        bus.emit('event', conv.id, notice);
        bus.emit('event', conv.id, { type: 'context_compacted', contextTokens: null });
        return { ok: true };
      } catch {
        return { ok: false, message: 'Could not transfer the chat context. The provider was not changed.' };
      } finally {
        if (entry.maintenance === maintenance) entry.maintenance = null;
        emitStatus(conv.id);
        // Messages arriving during the switch retain their durable queue rows.
        const fresh = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id) as ConversationRow | undefined;
        if (fresh && !fresh.archived && entry.queue.length) void runNext(fresh);
      }
    },
    async compactConversation(conv) {
      const entry = entryFor(conv.id);
      if (entry.maintenance) {
        return { ok: false, error: 'already_compacting', message: 'Context compaction is already running.' };
      }
      if (entry.turn || hasPendingStmt.get(conv.id) || hasPendingQuestion(conv.id)) {
        return { ok: false, error: 'working', message: 'Wait for the current reply to finish.' };
      }

      const adapter = adapters[conv.provider];
      if (!adapter?.compactSession) {
        return {
          ok: false,
          error: 'unsupported',
          message: `Context compaction is not available for ${conv.provider}.`,
        };
      }
      if (isFirstTurn(conv.id)) {
        return {
          ok: false,
          error: 'not_ready',
          message: 'Send at least one message before compacting this chat.',
        };
      }

      let handle: CompactSessionHandle;
      try {
        const workspace = resolveWorkspace(conv);
        handle = adapter.compactSession({
          cwd: workspace.workspaceDir,
          nativeSessionId: conv.native_session_id,
          dangerous: workspace.fullAccess ?? false,
        });
      } catch {
        log.warn(`[runtime] ${conv.provider} compaction could not start`);
        return { ok: false, error: 'failed', message: 'Could not start context compaction. Try again.' };
      }

      const maintenance: NonNullable<LiveConversation['maintenance']> = {
        kind: 'compaction',
        kill: handle.kill,
        interrupted: false,
      };
      entry.maintenance = maintenance;
      emitStatus(conv.id);

      try {
        const result = await handle.done;
        if (maintenance.interrupted) {
          return { ok: false, error: 'interrupted', message: 'Context compaction was stopped.' };
        }
        // A provider may not expose post-compaction occupancy. Null is
        // intentional: it removes the stale pre-compaction gauge until the
        // next native turn reports the fresh value.
        updateContextTokensStmt.run(result.contextTokens, conv.id);
        bus.emit('event', conv.id, {
          type: 'context_compacted',
          contextTokens: result.contextTokens,
          ...(conv.provider === 'claude' || conv.provider === 'codex'
            ? { notice: CONTEXT_COMPACTED_NOTICE }
            : {}),
        });
        return { ok: true, contextTokens: result.contextTokens };
      } catch (err) {
        if (maintenance.interrupted) {
          return { ok: false, error: 'interrupted', message: 'Context compaction was stopped.' };
        }
        const detail = (err as Error).message ?? '';
        log.warn(`[runtime] ${conv.provider} compaction failed`);
        if (/(?:no|not enough) (?:messages|(?:chat )?history) to compact/i.test(detail)) {
          return { ok: false, error: 'not_ready', message: 'There is not enough chat history to compact yet.' };
        }
        if (/not logged in|credential|unauthorized|\b401\b/i.test(detail)) {
          return { ok: false, error: 'failed', message: 'The provider is not connected. Reconnect it and try again.' };
        }
        if (/not found|unknown (thread|session)|no rollout/i.test(detail)) {
          return {
            ok: false,
            error: 'failed',
            message: 'The provider session is no longer available. Start a fresh context to continue.',
          };
        }
        if (/disconnected|exited|broken pipe/i.test(detail)) {
          return { ok: false, error: 'failed', message: 'The provider disconnected while compacting. Try again.' };
        }
        if (/timed out/i.test(detail)) {
          return { ok: false, error: 'failed', message: 'Context compaction timed out. Try again.' };
        }
        return { ok: false, error: 'failed', message: 'The provider could not compact this chat. Try again.' };
      } finally {
        if (entry.maintenance === maintenance) entry.maintenance = null;
        emitStatus(conv.id);
        const fresh = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id) as
          | ConversationRow
          | undefined;
        if (fresh && !fresh.archived && entry.queue.length) void runNext(fresh);
      }
    },
    resumeInterruptedTurns() {
      const rows = listPendingTurnsStmt.all() as {
        conversation_id: string;
        prompt: string;
        actor_user_id: number | null;
        origin_json: string | null;
        attempts: number;
      }[];
      for (const row of rows) {
        const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(row.conversation_id) as
          | ConversationRow
          | undefined;
        // Gone/archived rows are no longer actionable. Exhausted rows remain in
        // SQLite as failed so the user can retry or skip instead of losing text.
        if (!conv || conv.archived) {
          clearPendingTurnStmt.run(row.conversation_id);
          continue;
        }
        if (row.attempts >= MAX_RESUME_ATTEMPTS) {
          const error = `Turn could not be recovered after ${row.attempts} runner restarts.`;
          failPendingTurnStmt.run(error, row.conversation_id);
          log.warn(`[runtime] paused ${row.conversation_id} after ${row.attempts} resume attempts`);
          emitQueue(row.conversation_id);
          emitStatus(row.conversation_id);
          continue;
        }
        // Re-run the interrupted prompt; --resume gives the agent its prior
        // context so it continues rather than starting over. runNext's own
        // recordPendingTurnStmt bumps `attempts`, capping repeated crashes.
        const entry = entryFor(conv.id);
        if (entry.turn) continue; // already live somehow
        // A deleted actor must fail closed, never inherit the chat creator's connectors.
        const origin = parseMessageOrigin(row.origin_json);
        entry.queue.push({
          id: null,
          prompt: row.prompt,
          actorUserId: row.actor_user_id,
          ...(origin ? { origin } : {}),
        });
        void runNext(conv);
      }
      // Replay durably-queued messages that were waiting behind an in-flight
      // turn when the process died. They're re-enqueued in durable sort order
      // AFTER any resumed turn above, so ordering is preserved: runNext is a
      // no-op while a resumed turn is live and drains them once it completes.
      //
      // A row that was 'delivered' (written into a live provider process whose
      // echo never arrived) is replayed here too. That is at-least-once by
      // design: the CLI process dies with the runner, so it either never read
      // the line or read it without ever getting to answer. Re-running it is
      // the only outcome that cannot silently lose the message.
      const queued = listQueuedMessagesStmt.all() as {
        id: number;
        conversation_id: string;
        prompt: string;
        actor_user_id: number | null;
        origin_json: string | null;
      }[];
      for (const q of queued) {
        const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(q.conversation_id) as
          | ConversationRow
          | undefined;
        if (!conv || conv.archived) {
          deleteQueuedMessageStmt.run(q.id);
          continue;
        }
        const entry = entryFor(conv.id);
        const origin = parseMessageOrigin(q.origin_json);
        entry.queue.push({
          id: q.id,
          prompt: q.prompt,
          actorUserId: q.actor_user_id,
          ...(origin ? { origin } : {}),
        });
        void runNext(conv);
      }
    },
    interrupt(conversationId, reason = 'user') {
      clearDiscussionActivity.run(conversationId);
      const entry = live.get(conversationId);
      if (!entry) return false;
      const kill = entry.turn ? entry.kill : entry.maintenance?.kill;
      if (!kill) return false;
      if (entry.maintenance) entry.maintenance.interrupted = true;
      // A steer whose echo has not landed yet belongs to this turn; the turn is
      // going away, so its durable row must survive for the next turn to run.
      if (entry.turn) entry.turn.discarded = true;
      // A stopped turn's session file looks like a restart on the next resume, so
      // record the stop here — the only place that still knows a person caused it.
      // 'timeout' is a watchdog kill, not a user stop.
      if (entry.turn && (reason === 'user' || reason === 'send_now')) {
        try {
          insertTurnStopStmt.run(conversationId, new Date().toISOString(), reason);
        } catch (err) {
          log.warn(`[runtime] recording turn stop failed: ${(err as Error).message}`);
        }
      }
      try {
        kill(reason);
      } catch (err) {
        log.warn(`[runtime] interrupt failed: ${(err as Error).message}`);
      }
      return true;
    },
    shutdown() {
      historyPages.close();
      db.prepare('UPDATE pending_turns SET discussion_message_id=NULL').run();
      for (const [conversationId, entry] of live) {
        const kill = entry.turn ? entry.kill : entry.maintenance?.kill;
        if (!kill) continue;
        if (entry.turn) {
          discountCleanRestartStmt.run(conversationId);
          // The process dies with the runner: an in-flight steer is replayed from
          // its durable row after the restart, never retired here.
          entry.turn.discarded = true;
        }
        if (entry.maintenance) entry.maintenance.interrupted = true;
        try {
          kill();
        } catch (err) {
          log.warn(`[runtime] shutdown kill failed: ${(err as Error).message}`);
        }
      }
    },
    statusOf,
    activityOf,
    isLive: (id) => Boolean(live.get(id)?.turn || live.get(id)?.maintenance),
    resolveApproval(approvalId, outcome, byUserId) {
      const row = getApprovalStmt.get(approvalId) as ApprovalRow | undefined;
      if (!row) return { ok: false, error: 'not_found' };
      if (row.status !== 'pending') return { ok: false, error: 'not_pending' };

      const decision: ApprovalDecision =
        outcome === 'approved' ? { behavior: 'allow' } : { behavior: 'deny', message: USER_DENY_MESSAGE };
      const delivered = live.get(row.conversation_id)?.respond?.(row.request_id, decision) ?? false;
      clearApprovalTimer(row.id);
      if (!delivered) {
        // Process already gone (crash/restart between request and tap).
        expireStmt.run(row.id);
        emitConversationEvent(row.conversation_id, {
          type: 'approval_resolved',
          requestId: row.request_id,
          outcome: 'expired',
        });
        emitStatus(row.conversation_id);
        return { ok: false, error: 'expired' };
      }
      resolveStmt.run(outcome, byUserId, row.id);
      emitConversationEvent(row.conversation_id, {
        type: 'approval_resolved',
        requestId: row.request_id,
        outcome,
        byUserId,
      });
      emitStatus(row.conversation_id);
      return { ok: true, status: outcome };
    },
    askQuestion(conversationId, question, options, multi, allowOther = false, secret, secretKind = 'secret') {
      const requestId = crypto.randomUUID();
      const turnId = live.get(conversationId)?.turn?.turnId ?? `detached-${requestId}`;
      const questions: QuestionPrompt[] = [{
        id: 'q1',
        question,
        // A secret prompt has no choices; allowOther is what lets the server's
        // literal 'saved' answer pass normalizedQuestionAnswers.
        options: secret ? [] : options,
        multi: secret ? false : multi,
        allowOther: secret ? true : allowOther,
        ...(secret ? { kind: secretKind, secret } : {}),
      }];
      insertQuestionStmt.run(requestId, conversationId, turnId, 'poll', JSON.stringify(questions));
      armQuestionTimer(requestId);
      emitConversationEvent(conversationId, {
        type: 'question_asked',
        requestId,
        turnId,
        questions,
        responseMode: 'poll',
        question,
        options,
        multi,
      });
      emitStatus(conversationId);
      return requestId;
    },
    getQuestion(requestId) {
      const row = getQuestionStmt.get(requestId) as QuestionRow | undefined;
      if (!row) return null;
      const answers = parseQuestionAnswers(row);
      const first = parseQuestionPrompts(row)[0];
      return {
        conversationId: row.conversation_id,
        status: row.status,
        answer: first ? (answers[first.id] ?? []).join(', ') : '',
        answers,
        ...(first?.kind ? { kind: first.kind } : {}),
        ...(first?.secret ? { secret: first.secret } : {}),
      };
    },
    resolveQuestion(requestId, answers) {
      return finalizeQuestion(requestId, 'answered', answers);
    },
    async historyPage(conv,token,before) {
      if(token)return historyPages.page(conv.id,token,before??0);
      const events=await this.snapshot(conv);
      return historyPages.open(conv.id,events,snapshotRevisions.get(events)??0,streamEpoch);
    },
    historyRecord(conv,token,index){return historyPages.record(conv.id,token,index);},
    async snapshot(conv) {
      const cwd = resolveWorkspace(conv).workspaceDir;
      const adapter = adapters[conv.provider];
      // Put the transcript back if the provider deleted it since the last open.
      // A no-op stat when the native file is still there.
      if (adapter) await transcriptArchive?.restore(conv.provider, { cwd, nativeSessionId: conv.native_session_id });
      const fileEvents = adapter ? await adapter.readTranscript({ cwd, nativeSessionId: conv.native_session_id }) : [];
      // A switch can finish while the old provider transcript is being read.
      // Restart the read instead of combining the old session with its archived copy.
      const fresh = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id) as ConversationRow | undefined;
      if (fresh && (fresh.provider !== conv.provider || fresh.native_session_id !== conv.native_session_id)) {
        return this.snapshot(fresh);
      }
      const history = providerContext(conv.id);
      const historicalEvents = history ? JSON.parse(history.history_json) as ConversationEvent[] : [];
      const connectorSources = connectorToolSourcesForConversation(db, conv.id, conv.user_id);
      const approvals = listConversationApprovalsStmt.all(conv.id) as ApprovalRow[];
      const questions = listConversationQuestionsStmt.all(conv.id) as QuestionRow[];
      const merged = reconcileQuestionEvents(
        reconcileApprovalEvents(
          [...historicalEvents, ...mergeLiveIntoSnapshot(fileEvents, live.get(conv.id)?.turn ?? null, { settleOrphans: true })],
          approvals,
        ),
        questions,
      ).map((event) => enrichConnectorToolEvent(event, connectorSources));
      const withAgentMessageReceipts = spliceAgentMessageReceipts(conv.id, merged);
      const complete = spliceTurnStops(
        conv.id,
        spliceTurnRecall(
          conv.id,
          spliceTurnOrigins(conv.id, guardLoopbackDeliverableEvents(withAgentMessageReceipts)),
        ),
      );
      snapshotRevisions.set(complete,streamRevision);
      return complete;
    },
    async listSessionFiles(conv) {
      const adapter = adapters[conv.provider];
      if (!adapter) return [];
      const cwd = resolveWorkspace(conv).workspaceDir;
      const target = { cwd, nativeSessionId: conv.native_session_id };
      const refs = adapter.listCreatedFiles ? await adapter.listCreatedFiles(target) : [];
      // Provider-neutral second feed: local files the agent linked in its
      // replies. The strongest deliverable signal there is (the agent chose to
      // present them), and the only one every provider emits. Reported as
      // 'bash' so the registry's heuristic guards (exists + mtime) still apply.
      const context = providerContext(conv.id);
      const previous = context ? JSON.parse(context.files_json) as CreatedFileRef[] : [];
      const bySource = new Map([...previous, ...refs].map((ref) => [ref.path, ref.source]));
      for (const event of await adapter.readTranscript(target)) {
        if (event.type !== 'text_final') continue;
        for (const linked of linkedFilePaths(event.markdown, expandUserPath)) {
          if (!bySource.has(linked)) bySource.set(linked, 'bash');
        }
      }
      return [...bySource].map(([path, source]) => ({ path, source }));
    },
  };
}
