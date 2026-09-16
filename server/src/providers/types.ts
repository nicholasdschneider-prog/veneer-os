import type { ConversationEvent, QuestionAnswers } from '../runtime/events.js';

/**
 * Provider seam (spec §7): provider implementations can be per-turn (Claude,
 * OpenRouter) or long-lived (Codex App Server); the runtime never branches on
 * provider itself.
 */

export interface TurnSpec {
  /** Assistant workspace dir the CLI runs in. */
  cwd: string;
  /** Veneer conversation id, used to isolate provider-neutral host tools. */
  conversationId?: string;
  /**
   * Native session id. For Claude this is minted up front and reused as-is.
   * Codex assigns its own thread id on the first turn instead — callers pass
   * a placeholder for that first spawn and learn the real id via runTurn's
   * onSessionId callback.
   */
  nativeSessionId: string;
  /** True for the first turn of a conversation (create vs resume). */
  firstTurn: boolean;
  model?: string | null;
  /** Reasoning-effort level, provider-specific vocabulary (model/effort picker). */
  effort?: string | null;
  /** User-visible prompt when `prompt` contains provider-native transport syntax. */
  displayPrompt?: string;
  prompt: string;
  turnId: string;
  /** Per-spawn materialized toolbox config (spec §11.3); null → none. */
  mcpConfigPath?: string | null;
  settingsPath?: string | null;
  /** Veneer's short core rules plus this chat's fixed agent/project snapshot. */
  developerInstructions?: string | null;
  /** Fork a resumed native thread before the turn so new developer context applies immediately. */
  refreshDeveloperInstructions?: boolean;
  /**
   * Full-control spawn for an opted-in agent: `--dangerously-skip-permissions`
   * for Claude, or danger-full-access + never approvals for Codex.
   */
  dangerous?: boolean;
}

/** Resolution for a pending approval, provider-agnostic. */
export type ApprovalDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

/** One selectable model for the new-conversation picker. */
export interface ModelOption {
  id: string;
  label: string;
  /**
   * Reasoning-effort levels this model supports, in the provider's own
   * vocabulary, when the provider reports them (Codex `model/list` does; the
   * sets differ per model since GPT-5.6 — Sol/Terra add 'max'+'ultra' and drop
   * 'minimal', Luna has 'max' but not 'ultra'). Absent → the UI falls back to
   * its static per-provider vocabulary.
   */
  efforts?: string[];
  /** Effort the provider applies when none is picked, if reported. */
  defaultEffort?: string;
  /** Flagged by the provider as its current default model (Codex: gpt-5.6-sol). */
  isDefault?: boolean;
}

/** A deliverable data file the agent created during a session (listCreatedFiles). */
export interface CreatedFileRef {
  /** Absolute path on disk. */
  path: string;
  /** Detection: an exact Write tool call, or a path named in a Bash command (heuristic). */
  source: 'write' | 'bash';
}

export type ProviderId = 'claude' | 'openrouter' | 'codex' | 'grok';

/** Why a live turn is being interrupted. `timeout` is raised by the adapter itself. */
export type TurnKillReason = 'user' | 'send_now' | 'timeout';

export interface TurnHandle {
  /** Resolves when the turn is over (success, error, kill, or timeout). */
  done: Promise<void>;
  /**
   * Interrupt: SIGTERM, then SIGKILL after a grace period.
   *
   * The reason is not cosmetic. Only an explicit user Stop means "abandon this
   * work"; a "Send now" replaces the parent turn while its delegated children
   * should keep running, and a timeout is Veneer's own guard rather than a
   * decision about the children. Providers that can cancel children separately
   * (Grok) key that choice off this argument.
   */
  kill(reason?: TurnKillReason): void;
  /**
   * Append user guidance to the active turn. `false` means the input never
   * reached the provider, so the caller must keep its durable fallback. A
   * SteerDelivery means the write landed but the provider has not confirmed it
   * yet; the caller keeps the fallback until `acknowledged` settles. Optional
   * for provider implementations that cannot steer.
   */
  steer?(text: string): Promise<boolean | SteerDelivery>;
  /**
   * Answer a pending approval (control_request). Returns false if the request
   * is unknown or the process is already gone — the caller treats that as expired.
   */
  respondToApproval(requestId: string, decision: ApprovalDecision): boolean;
  /** Answer a provider-native structured question request. MCP questions poll the durable store instead. */
  respondToQuestion?(requestId: string, answers: QuestionAnswers): boolean;
}

/**
 * A steered line the provider process accepted on stdin but has not echoed back
 * yet. Claude Code only replays an injected user message once its current tool
 * call finishes, so the write itself — not the echo — is the earliest honest
 * signal that the line was delivered.
 */
export interface SteerDelivery {
  delivered: true;
  /** True once the provider replays the line into the live turn; false if the turn ended first. */
  acknowledged: Promise<boolean>;
}

/** Existing native provider session to compact without adding a transcript turn. */
export interface CompactSessionSpec {
  cwd: string;
  nativeSessionId: string;
  /** Keep the provider process on the same account/home boundary as ordinary turns. */
  dangerous?: boolean;
}

export interface CompactSessionResult {
  /** Fresh occupancy when the provider reports it; null means refresh on the next turn. */
  contextTokens: number | null;
}

export interface CompactSessionHandle {
  done: Promise<CompactSessionResult>;
  kill(): void;
}

export interface ProviderAdapter {
  id: ProviderId;
  mintSessionId(): string;
  /**
   * Run one user turn; events fan out through onEvent as they stream.
   * onSessionId is called at most once, on the first turn, by a provider that
   * discovers its own session id mid-spawn rather than accepting one
   * up front (Codex); Claude never calls it.
   */
  runTurn(spec: TurnSpec, onEvent: (e: ConversationEvent) => void, onSessionId?: (id: string) => void): TurnHandle;
  /** Compact hidden/native context while leaving Veneer's visible transcript untouched. */
  compactSession?(spec: CompactSessionSpec): CompactSessionHandle;
  /** Parse the native session file into normalized events (rehydrate). */
  readTranscript(conv: { cwd: string; nativeSessionId: string }): Promise<ConversationEvent[]>;
  /**
   * Where readTranscript reads its bytes from, when the provider keeps history
   * in a file it owns. Veneer archives that file and restores it if the
   * provider deletes it — Claude Code purges its session JSONL after 30 days
   * (cleanupPeriodDays), which silently emptied older chats. Returns the
   * canonical path even when nothing is there yet (so a restore knows where to
   * put the bytes back), or null when the provider has no such file.
   */
  nativeTranscriptPath?(conv: { cwd: string; nativeSessionId: string }): Promise<string | null>;
  /** Latest auto-generated conversation title from the native session, if the provider writes one. */
  readTitle?(conv: { cwd: string; nativeSessionId: string }): Promise<string | null>;
  /** The model that actually answered the last turn, read back from the native session. */
  readModel?(conv: { cwd: string; nativeSessionId: string }): Promise<string | null>;
  /** Models this provider currently offers, for the new-conversation picker. */
  listModels?(): Promise<ModelOption[]>;
  /**
   * Deliverable data files (CSV etc.) the agent created this session, scanned
   * from the native session file. Paths are candidates — callers must verify
   * they still exist before exposing them.
   */
  listCreatedFiles?(conv: { cwd: string; nativeSessionId: string }): Promise<CreatedFileRef[]>;
}
