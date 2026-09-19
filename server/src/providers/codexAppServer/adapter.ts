import crypto from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';
import { agentEnv, expandUserPath } from '../../homes.js';
import { runAgentBrowser, sharedDesktopUrl, type BrowserRunResult } from '../../mcp/agentBrowser.js';
import type { ConversationEvent, QuestionAnswers, SubagentProgress, SubagentStatus } from '../../runtime/events.js';
import { CONTEXT_COMPACTED_NOTICE, displayNameForTool, previewOf } from '../../runtime/events.js';
import { diffLineCounts, safeTerminalAction, safeToolAction, type SafeCommandKind } from '../../runtime/subagentProgress.js';
import { saveImageBytes } from '../../runtime/media.js';
import { connectorInputDetails, connectorResultDetails } from '../../runtime/connectorToolDetails.js';
import { agentMessageInputDetails } from '../../runtime/agentMessageToolDetails.js';
import { labelFromAgentPath, subagentEventKey, subagentLabel } from '../../runtime/subagents.js';
import { MAX_BASH_RESULT_FILES, WRITE_EXTS, boundedResultText, fileCandidates } from '../fileScan.js';
import type {
  ApprovalDecision,
  CompactSessionHandle,
  CompactSessionSpec,
  ModelOption,
  ProviderAdapter,
  TurnHandle,
  TurnKillReason,
  TurnSpec,
} from '../types.js';
import { codexMcpServers } from '../agentsMcp.js';
import { createTurnWatchdog, isPollingToolName, turnTimeoutMessage } from '../turnWatchdog.js';
import { appendShadowFiles, appendShadowTranscript, findRolloutFile, readCodexModel } from '../codex/transcript.js';
import { readCodexHistory, readCodexHistoryFiles, recordCodexFork } from '../codex/history.js';
import { requestModelList } from '../codex/models.js';
import {
  AppServerClient,
  DISCONNECTED_METHOD,
  type JsonRpcMessage,
  type PermissionsRequestApprovalParams,
  type PermissionsRequestApprovalResponse,
  type RequestPermissionProfile,
  type ToolRequestUserInputParams,
  type ToolRequestUserInputResponse,
} from './protocol.js';

const MODELS_CACHE_TTL_MS = 5 * 60_000;
/**
 * Codex 0.153+ holds a per-thread writer lock (`CODEX_HOME/thread-writer-locks`)
 * in whichever app-server process last loaded the thread, for as long as the
 * thread stays loaded — not only while a turn runs. Veneer keeps several
 * long-lived app-servers over one shared sessions tree (one per account and
 * access level), so a chat that moves between them (account failover, Ask↔Allow)
 * has to have the previous process close the thread before the next resumes it.
 * Both maps are process-wide: more than one adapter can exist in a service.
 */
const threadOwners = new Map<string, AppServerClient>();
const liveClients = new Set<AppServerClient>();
const WRITER_LOCKED_RE = /already has an active writer/i;
const THREAD_CLOSE_TIMEOUT_MS = 5_000;

/** Ask `holders` to unload `threadId`; failures are expected (not loaded there) and ignored. */
async function closeThreadOn(holders: Iterable<AppServerClient>, threadId: string): Promise<void> {
  const requests = [...holders].map((holder) => Promise.race([
    holder.request('thread/close', { threadId }),
    new Promise((resolve) => setTimeout(resolve, THREAD_CLOSE_TIMEOUT_MS).unref?.()),
  ]).catch(() => undefined));
  await Promise.all(requests);
}

/** Release the thread from the process that last loaded it, if that is not `client`. */
async function releaseThreadOwner(threadId: string, client: AppServerClient): Promise<void> {
  const owner = threadOwners.get(threadId);
  if (owner && owner !== client && owner.running) await closeThreadOn([owner], threadId);
}

/** Owner unknown (another adapter, or a stale map): ask every other live app-server. */
async function releaseThreadEverywhere(threadId: string, client: AppServerClient): Promise<void> {
  await closeThreadOn([...liveClients].filter((c) => c !== client && c.running), threadId);
}

function isWriterLocked(err: unknown): boolean {
  return WRITER_LOCKED_RE.test((err as Error)?.message ?? '');
}
const CODEX_BROWSER_TOOL_NAME = 'agent_browser';
const desktopUrl = sharedDesktopUrl();
const CODEX_BROWSER_TOOL = {
  type: 'function',
  name: CODEX_BROWSER_TOOL_NAME,
  description:
    'Run one local Agent Browser command. By default the browser is isolated to this conversation; set shared=true to use the user-visible desktop browser. Pass args after agent-browser, for example ["open","https://example.com"], ["snapshot","-i"], ["screenshot"], or ["close"]. This scoped host tool works without Bash.',
  inputSchema: {
    type: 'object',
    properties: {
      args: { type: 'array', items: { type: 'string' }, minItems: 1 },
      timeout_ms: { type: 'number', minimum: 1000, maximum: 120000 },
      shared: {
        type: 'boolean',
        description:
          `Attach to the user-visible shared desktop Chrome. Use when the user asks to watch or take over. Tell them they can watch at ${desktopUrl}.`,
      },
    },
    required: ['args'],
  },
} as const;

function browserResultText(result: BrowserRunResult, shared: boolean, command: string): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const saved = result.screenshotPath && fsSync.existsSync(result.screenshotPath)
    ? `\nSaved to ${result.screenshotPath} (${fsSync.statSync(result.screenshotPath).size} bytes)`
    : '';
  const liveView = shared && result.exitCode === 0 && command !== 'close'
    ? `\nLive view: ${desktopUrl}`
    : '';
  return `${output || `agent-browser exited ${result.exitCode}.`}${saved}${liveView}`;
}

function messageTurnId(msg: JsonRpcMessage): string | null {
  const params = (msg.params ?? {}) as Record<string, unknown>;
  if (typeof params.turnId === 'string') return params.turnId;
  const nativeTurn = params.turn;
  if (nativeTurn && typeof nativeTurn === 'object' && typeof (nativeTurn as { id?: unknown }).id === 'string') {
    return (nativeTurn as { id: string }).id;
  }
  return null;
}

interface CodexSubagentRecord extends SubagentProgress {
  status: SubagentStatus;
  label: string;
  model?: string;
  role?: string;
  effort?: string;
}

interface CodexTokenCount {
  inputTokens: number;
  outputTokens: number;
  /** Cache reads, a subset of inputTokens. Absent on older app-servers. */
  cachedInputTokens?: number;
}

function codexTokenCount(value: unknown): CodexTokenCount | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { inputTokens?: unknown; outputTokens?: unknown; cachedInputTokens?: unknown };
  if (
    typeof raw.inputTokens !== 'number'
    || !Number.isSafeInteger(raw.inputTokens)
    || raw.inputTokens < 0
    || typeof raw.outputTokens !== 'number'
    || !Number.isSafeInteger(raw.outputTokens)
    || raw.outputTokens < 0
  ) return null;
  const cached =
    typeof raw.cachedInputTokens === 'number'
    && Number.isSafeInteger(raw.cachedInputTokens)
    && raw.cachedInputTokens >= 0
    && raw.cachedInputTokens <= raw.inputTokens
      ? raw.cachedInputTokens
      : undefined;
  return {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
  };
}

/** Codex reports a child as done through these; nothing else is terminal. */
function isTerminalSubagentStatus(status: SubagentStatus): boolean {
  return status === 'completed' || status === 'stopped' || status === 'failed';
}

export interface CodexAdapterOptions {
  codexBin: string;
  /** Absolute per-turn ceiling. The inactivity window below is the real guard. */
  turnTimeoutMs: number;
  /**
   * Idle time with no provider progress before the turn is reaped. Omitting it
   * leaves the absolute ceiling as the only guard, which is the pre-watchdog
   * behaviour.
   */
  turnInactivityMs?: number;
  /** Maximum wait for turn/completed after turn/interrupt. */
  interruptCompletionTimeoutMs?: number;
  /** Canonical App Server shadow-transcript store. */
  transcriptsDir: string;
  /** Previous `codex exec` transcript store, read for pre-consolidation chats. */
  legacyTranscriptsDir?: string;
  log?: Pick<Console, 'warn' | 'error'>;
  runBrowser?: typeof runAgentBrowser;
  /** Test seam for the per-access-level app-server environment. */
  buildEnv?: (fullAccess: boolean) => NodeJS.ProcessEnv;
  /**
   * The Codex account new turns run on (read once per turn). Each account has
   * its own CODEX_HOME, so each gets its own long-lived app-server.
   */
  getAccountId?: () => string | null;
  /** CODEX_HOME for an account; called before every spawn so the profile is ready. */
  codexHomeFor?: (accountId: string) => string;
  /** A turn died on the subscription's usage limit — see ../codex/accountFailover.ts. */
  onUsageLimit?: (event: CodexUsageLimitEvent) => void;
}

/** What the adapter reports when Codex ends a turn on a usage limit. */
export interface CodexUsageLimitEvent {
  conversationId: string | null;
  /** Account the turn ran on (captured at spawn), or null if unknown. */
  accountId: string | null;
  text: string;
  at: Date;
}

/** Codex phrases a subscription limit as a turn error; match it, not other failures. */
export const CODEX_USAGE_LIMIT_RE = /usage limit|rate limit|too many requests|\b429\b|quota/i;

/**
 * Canonical Codex adapter over `codex app-server`. One process for the whole
 * adapter's lifetime (spec: LONG_LIVED, not PER_TURN) is multiplexed by thread
 * id — see protocol.ts. Verified live 2026-07-23 against Codex CLI 0.144.4.
 *
 * Two real advantages over the exec adapter, both verified live:
 *  - `item/agentMessage/delta` streams real token-level text, not one final block.
 *  - When a sandboxed action fails, app-server surfaces an actual approval
 *    request (`item/*\/requestApproval`, reason "command failed; retry without
 *    sandbox?") instead of just reporting the failure to the model. On this
 *    host's broken bwrap sandbox (see the shared platform-dev conversation's
 *    chat history for the writeup), that's the difference between "every
 *    tool call quietly fails" and "the user gets asked, and it then works."
 */
export function createCodexAdapter(opts: CodexAdapterOptions): ProviderAdapter {
  const inactivityMs = opts.turnInactivityMs ?? opts.turnTimeoutMs;
  const log = opts.log ?? console;
  const runBrowser = opts.runBrowser ?? runAgentBrowser;
  const interruptCompletionTimeoutMs = opts.interruptCompletionTimeoutMs ?? 5_000;
  fsSync.mkdirSync(opts.transcriptsDir, { recursive: true });
  // Codex runs the agent's shell commands as children of the app-server, so the
  // process environment — not a per-turn argument — decides which HOME those
  // commands see. One long-lived server per access level: the Full Access one
  // runs under the login account's HOME, the safe one under the service home.
  // Both pin CODEX_HOME at Pro's profile, so auth.json and the sessions tree are
  // the same files either way.
  /**
   * Delegated children outlive the turn that spawned them: Codex reports a
   * child's terminal state on whatever later `wait`/`close` call observes it,
   * which is frequently a *different* parent turn. Keeping this per-turn was
   * why an already-finished child could reappear as "running" forever, and why
   * an interrupted parent used to report children stopped that Codex had never
   * said anything about.
   */
  const subagentsByThread = new Map<string, Map<string, CodexSubagentRecord>>();
  // Keyed by account and access level: a Codex account is a CODEX_HOME, and
  // the app-server reads its credential from there at spawn, so switching
  // accounts means a different long-lived process, not a different argument.
  const clients = new Map<string, AppServerClient>();
  // A bounded interrupt fallback can release Veneer before app-server releases
  // its native turn. The next turn on that thread must quarantine unscoped late
  // notifications as well as rejecting messages carrying the old turn id.
  const fallbackInterruptedThreads = new Set<string>();
  function clientFor(fullAccess: boolean, accountId: string | null): AppServerClient {
    const key = `${accountId ?? ''}\u0000${fullAccess ? 'full' : 'safe'}`;
    let existing = clients.get(key);
    if (!existing) {
      const env = (opts.buildEnv ?? agentEnv)(fullAccess);
      if (accountId && opts.codexHomeFor) env.CODEX_HOME = opts.codexHomeFor(accountId);
      existing = new AppServerClient({ codexBin: opts.codexBin, env, log });
      clients.set(key, existing);
      liveClients.add(existing);
    }
    return existing;
  }

  let modelsCache: { at: number; models: ModelOption[] } | null = null;
  async function listModels(): Promise<ModelOption[]> {
    if (modelsCache && Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS) return modelsCache.models;
    const models = await requestModelList(clientFor(false, opts.getAccountId?.() ?? null));
    modelsCache = { at: Date.now(), models };
    return models;
  }

  function runTurn(spec: TurnSpec, onEvent: (e: ConversationEvent) => void, onSessionId?: (id: string) => void): TurnHandle {
    const turnId = spec.turnId;
    // Captured at spawn: the active account is one global setting, so it can
    // move while the turn runs; usage attribution stays with this one.
    const spawnAccountId = opts.getAccountId?.() ?? null;
    const client = clientFor(spec.dangerous ?? false, spawnAccountId);
    let settled = false;
    let killed = false;
    let killReason: 'user' | 'timeout' | null = null;
    let unsubscribe: (() => void) | null = null;
    let resolvedThreadId: string | null = spec.firstTurn ? null : spec.nativeSessionId;
    let resolvedTurnId: string | null = null;
    let interruptRequested = false;
    let interruptFallbackTimer: NodeJS.Timeout | null = null;
    let quarantineUnscopedNativeEvents = false;
    const pendingNativeMessages: JsonRpcMessage[] = [];
    let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
    let totalUsage: {
      totalInputTokens: number;
      totalOutputTokens: number;
      totalTokens: number;
      cachedInputTokens?: number;
    } | undefined;
    let tokenBaseline: CodexTokenCount | undefined;
    // approval server-request id (number|string, whatever the server sent) keyed by its
    // stringified form (Veneer's requestId is always a string).
    type PendingApproval =
      | { id: string | number; kind: 'command' | 'file' }
      | { id: string | number; kind: 'permissions'; permissions: RequestPermissionProfile };
    const pendingApprovalIds = new Map<string, PendingApproval>();
    const pendingQuestionIds = new Map<
      string,
      { id: string | number; nativeIds: Map<string, string> }
    >();
    interface CodexChildProgress {
      seenItems: Set<string>;
      processedResults: Set<string>;
      files: Set<string>;
      commandKinds: Map<string, SafeCommandKind | undefined>;
      actionCount: number;
      linesAdded: number;
      linesRemoved: number;
    }
    const childProgressById = new Map<string, CodexChildProgress>();
    const childUnsubscribes = new Map<string, () => void>();
    function subagentStore(): Map<string, CodexSubagentRecord> {
      const key = resolvedThreadId ?? spec.nativeSessionId;
      let store = subagentsByThread.get(key);
      if (!store) {
        store = new Map();
        subagentsByThread.set(key, store);
      }
      return store;
    }

    const persistable: ConversationEvent[] = [
      { type: 'turn_started', turnId, role: 'user', text: spec.displayPrompt ?? spec.prompt, at: new Date().toISOString(), via: 'web' },
    ];
    let persistedEvents = 0;
    let historyReady = false;
    function pushPersist(e: ConversationEvent): void {
      persistable.push(e);
      if (historyReady) flushShadowState();
    }

    // Live created-file capture, checkpointed alongside durable events and read
    // back by listCreatedFiles. Codex has no Write tool and the shadow
    // transcript persists only bounded previews, so full command text, output,
    // and fileChange paths exist only here, while the turn streams.
    const createdFiles = new Map<string, 'write' | 'bash'>();
    const persistedFiles = new Map<string, 'write' | 'bash'>();
    // A service restart can exit before Codex acknowledges turn/interrupt.
    // Checkpoint completed events as they arrive, not only in finish().
    function flushShadowState(): void {
      if (!resolvedThreadId) return;
      try {
        appendShadowTranscript(opts.transcriptsDir, resolvedThreadId, persistable.slice(persistedEvents));
        persistedEvents = persistable.length;
      } catch (err) {
        log.warn(`[codex] shadow transcript write failed: ${(err as Error).message}`);
      }
      const refs = [...createdFiles].filter(([file, source]) => persistedFiles.get(file) !== source);
      try {
        appendShadowFiles(opts.transcriptsDir, resolvedThreadId, refs.map(([path, source]) => ({ path, source })));
        for (const [file, source] of refs) persistedFiles.set(file, source);
      } catch (err) {
        log.warn(`[codex] created-files sidecar write failed: ${(err as Error).message}`);
      }
    }
    const commandById = new Map<string, string>();
    // A child event can arrive immediately after a buffered spawn, before the
    // parent turn/start response lets us replay that spawn. Seed presentation
    // metadata early so the child's first public event is already complete.
    const reportedSubagentMeta = new Map<string, { model?: string; effort?: string }>();
    const absoluteCandidate = (p: string): string =>
      p.startsWith('~/') ? expandUserPath(p) : path.resolve(spec.cwd, p);
    function recordCommandCandidates(text: string, limit?: number): void {
      for (const candidate of fileCandidates(text, limit)) {
        const abs = absoluteCandidate(candidate);
        if (!createdFiles.has(abs)) createdFiles.set(abs, 'bash');
      }
    }

    function emitSubagent(
      nativeId: string,
      status: SubagentStatus,
      patch: Partial<SubagentProgress> & { label?: string; model?: string; role?: string; effort?: string } = {},
    ): void {
      const store = subagentStore();
      const previous = store.get(nativeId);
      if (previous && isTerminalSubagentStatus(previous.status) && !isTerminalSubagentStatus(status)) {
        // Late spawn/activity echoes may improve presentation metadata, but
        // must never regress a child that its own thread already completed.
        status = previous.status;
        patch = {
          ...(patch.label ? { label: patch.label } : {}),
          ...(patch.model ? { model: patch.model } : {}),
          ...(patch.role ? { role: patch.role } : {}),
          ...(patch.effort ? { effort: patch.effort } : {}),
        };
      }
      const reportedMeta = reportedSubagentMeta.get(nativeId);
      const model = patch.model ?? previous?.model ?? reportedMeta?.model;
      const role = patch.role ?? previous?.role;
      const effort = patch.effort ?? previous?.effort ?? reportedMeta?.effort;
      const startedAt = patch.startedAt ?? previous?.startedAt ?? new Date().toISOString();
      const terminal = isTerminalSubagentStatus(status);
      const terminalAction = terminal
        ? safeTerminalAction(status as 'completed' | 'stopped' | 'failed')
        : null;
      const next: CodexSubagentRecord = {
        ...previous,
        ...patch,
        status,
        label: subagentLabel(patch.label ?? previous?.label),
        ...(model ? { model } : {}),
        ...(role ? { role } : {}),
        ...(effort ? { effort } : {}),
        startedAt,
        ...(terminalAction && patch.currentAction === undefined ? { currentAction: terminalAction } : {}),
        ...(!terminal && status === 'running' && previous?.status === 'queued' && patch.currentAction === undefined
          ? { currentAction: 'Starting' }
          : {}),
        ...(!previous && patch.currentAction === undefined
          ? { currentAction: status === 'queued' ? 'Waiting' : terminalAction ?? 'Starting' }
          : {}),
        ...(terminal && patch.durationMs === undefined && previous?.durationMs === undefined
          ? { durationMs: Math.max(0, Date.now() - Date.parse(startedAt)) }
          : {}),
      };
      if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
      store.set(nativeId, next);
      const meta = {
        label: next.label,
        ...(next.model ? { model: next.model } : {}),
        ...(next.role ? { role: next.role } : {}),
        ...(next.effort ? { effort: next.effort } : {}),
        ...(next.startedAt ? { startedAt: next.startedAt } : {}),
        ...(typeof next.durationMs === 'number' ? { durationMs: next.durationMs } : {}),
        ...(next.currentAction ? { currentAction: next.currentAction } : {}),
        ...(typeof next.actionCount === 'number' ? { actionCount: next.actionCount } : {}),
        ...(typeof next.filesChanged === 'number' ? { filesChanged: next.filesChanged } : {}),
        ...(typeof next.linesAdded === 'number' ? { linesAdded: next.linesAdded } : {}),
        ...(typeof next.linesRemoved === 'number' ? { linesRemoved: next.linesRemoved } : {}),
        ...(typeof next.resultLabel === 'string' ? { resultLabel: next.resultLabel } : {}),
      };
      const agentKey = subagentEventKey('codex', nativeId);
      const event: ConversationEvent = previous
        ? { type: 'subagent_updated', turnId, agentKey, status, ...meta }
        : { type: 'subagent_started', turnId, agentKey, status, ...meta };
      onEvent(event);
      pushPersist(event);
      watchdog.activity(); // a child changing state is the turn's strongest liveness signal
    }

    /**
     * The cross-turn store only needs children Codex might still report on.
     * Dropping the finished ones at each turn boundary keeps it from growing
     * for the life of the adapter process.
     */
    function pruneFinishedSubagents(): void {
      const key = resolvedThreadId ?? spec.nativeSessionId;
      const store = subagentsByThread.get(key);
      if (!store) return;
      for (const [nativeId, record] of store) {
        if (isTerminalSubagentStatus(record.status)) store.delete(nativeId);
      }
      if (store.size === 0) subagentsByThread.delete(key);
    }

    /**
     * Only for events that genuinely end every child: the app-server they run
     * inside died, or the turn never started. A parent interrupt is NOT one of
     * those — the children keep running and Codex reports their real state on a
     * later wait/close, so sweeping here would publish a status Codex never
     * gave us.
     */
    function settleActiveSubagents(status: 'stopped' | 'failed'): void {
      for (const [nativeId, record] of subagentStore()) {
        if (!isTerminalSubagentStatus(record.status)) emitSubagent(nativeId, status);
      }
    }

    function codexAgentStatus(value: unknown): SubagentStatus | null {
      switch (value) {
        case 'pendingInit':
          return 'queued';
        case 'running':
          return 'running';
        case 'completed':
          return 'completed';
        case 'interrupted':
        case 'shutdown':
          return 'stopped';
        case 'errored':
        case 'notFound':
          return 'failed';
        default:
          return null;
      }
    }

    function codexChildProgress(nativeId: string): CodexChildProgress {
      let progress = childProgressById.get(nativeId);
      if (!progress) {
        progress = {
          seenItems: new Set(),
          processedResults: new Set(),
          files: new Set(),
          commandKinds: new Map(),
          actionCount: 0,
          linesAdded: 0,
          linesRemoved: 0,
        };
        childProgressById.set(nativeId, progress);
      }
      return progress;
    }

    function handleChildItem(nativeId: string, item: Record<string, unknown>, completed: boolean): void {
      const itemId = typeof item.id === 'string' ? item.id : '';
      const itemType = typeof item.type === 'string' ? item.type : '';
      if (!itemId || !itemType) return;
      const progress = codexChildProgress(nativeId);
      const countable = itemType === 'commandExecution'
        || itemType === 'fileChange'
        || itemType === 'mcpToolCall'
        || itemType === 'webSearch'
        || itemType === 'imageView';
      if (!progress.seenItems.has(itemId)) {
        progress.seenItems.add(itemId);
        if (countable) progress.actionCount += 1;
        const safe = safeToolAction(itemType, item);
        progress.commandKinds.set(itemId, safe.commandKind);
        emitSubagent(nativeId, 'running', {
          currentAction: itemType === 'agentMessage' ? 'Wrapping up' : safe.action,
          actionCount: progress.actionCount,
          filesChanged: progress.files.size,
          linesAdded: progress.linesAdded,
          linesRemoved: progress.linesRemoved,
          resultLabel: '',
        });
      }
      if (!completed || progress.processedResults.has(itemId)) return;
      progress.processedResults.add(itemId);
      let resultLabel = '';
      if (itemType === 'commandExecution') {
        const failed = typeof item.exitCode === 'number' ? item.exitCode !== 0 : item.status === 'failed';
        const commandKind = progress.commandKinds.get(itemId);
        resultLabel = commandKind === 'test'
          ? failed ? 'Tests failed' : 'Tests passed'
          : failed ? 'Action failed' : '';
      } else if (itemType === 'fileChange') {
        const changes = Array.isArray(item.changes)
          ? item.changes as Array<{ path?: unknown; diff?: unknown }>
          : [];
        for (const change of changes) {
          if (typeof change?.path === 'string' && change.path) progress.files.add(change.path);
          const counts = diffLineCounts(change?.diff);
          progress.linesAdded += counts.added;
          progress.linesRemoved += counts.removed;
        }
        if (item.status === 'failed') resultLabel = 'Change failed';
      } else if (itemType === 'mcpToolCall' && item.error) {
        resultLabel = 'Action failed';
      }
      emitSubagent(nativeId, 'running', {
        actionCount: progress.actionCount,
        filesChanged: progress.files.size,
        linesAdded: progress.linesAdded,
        linesRemoved: progress.linesRemoved,
        resultLabel,
      });
    }

    function handleChildMessage(nativeId: string, msg: JsonRpcMessage): void {
      if (settled || msg.method === DISCONNECTED_METHOD) return;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      if (msg.method === 'item/started' || msg.method === 'item/completed') {
        handleChildItem(nativeId, (params.item ?? {}) as Record<string, unknown>, msg.method === 'item/completed');
      } else if (msg.method === 'turn/completed') {
        const turn = params.turn && typeof params.turn === 'object'
          ? params.turn as Record<string, unknown>
          : {};
        const nativeStatus = String(turn.status ?? '').toLowerCase();
        const status: SubagentStatus = nativeStatus === 'failed' || nativeStatus === 'errored'
          ? 'failed'
          : nativeStatus === 'interrupted' || nativeStatus === 'stopped' || nativeStatus === 'cancelled'
            ? 'stopped'
            : 'completed';
        emitSubagent(nativeId, status, {
          ...(status === 'failed' ? { resultLabel: 'Child agent failed' } : {}),
        });
      } else if (msg.method === 'error') {
        emitSubagent(nativeId, 'running', { resultLabel: 'Action failed' });
      }
      // Child-thread interaction is intentionally unsupported, matching the
      // old no-handler behavior without leaving app-server waiting forever.
      if (msg.id !== undefined) client.respondError(msg.id, -32000, 'Child agent interaction is not supported');
    }

    function subscribeToSubagent(nativeId: string): void {
      if (childUnsubscribes.has(nativeId) || isTerminalSubagentStatus(subagentStore().get(nativeId)?.status ?? 'running')) return;
      childUnsubscribes.set(nativeId, client.subscribe(nativeId, (msg) => handleChildMessage(nativeId, msg)));
    }

    /** Learn child thread ids before a parent turn/start response continuation
     * runs. App-server can send spawn + first child item back-to-back in one
     * stdout tick, so waiting to replay the buffered spawn loses that item. */
    function subscribeReportedSubagents(item: Record<string, unknown>): void {
      if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string' && item.agentThreadId) {
        subscribeToSubagent(item.agentThreadId);
      }
      if (item.type !== 'collabAgentToolCall' || !Array.isArray(item.receiverThreadIds)) return;
      for (const nativeId of item.receiverThreadIds) {
        if (typeof nativeId !== 'string' || !nativeId) continue;
        reportedSubagentMeta.set(nativeId, {
          ...(typeof item.model === 'string' && item.model ? { model: item.model } : {}),
          ...(typeof item.reasoningEffort === 'string' && item.reasoningEffort
            ? { effort: item.reasoningEffort }
            : {}),
        });
        subscribeToSubagent(nativeId);
      }
    }

    /**
     * A `wait`/`list` collab call proves nothing: a turn looping on those with
     * no child ever changing state is exactly the wedged shape the watchdog
     * exists to reap. The liveness signal is the child status such a call
     * *reports*, which emitSubagent counts separately.
     */
    function isBarePollItem(item: Record<string, unknown>): boolean {
      return item.type === 'collabAgentToolCall' && isPollingToolName(String(item.tool ?? ''));
    }

    function handleSubagentItem(item: Record<string, unknown>): boolean {
      if (item.type === 'subAgentActivity') {
        const nativeId = typeof item.agentThreadId === 'string' ? item.agentThreadId : '';
        if (!nativeId) return true;
        const kind = typeof item.kind === 'string' ? item.kind.toLowerCase() : '';
        const status: SubagentStatus = kind === 'completed' || kind === 'finished'
          ? 'completed'
          : kind === 'interrupted' || kind === 'shutdown' || kind === 'stopped' || kind === 'killed'
            ? 'stopped'
            : kind === 'errored' || kind === 'failed'
              ? 'failed'
              : kind === 'queued' || kind === 'pendinginit'
                ? 'queued'
                : 'running';
        emitSubagent(nativeId, status, {
          label: labelFromAgentPath(item.agentPath),
        });
        if (!isTerminalSubagentStatus(status)) subscribeToSubagent(nativeId);
        return true;
      }
      if (item.type !== 'collabAgentToolCall') return false;

      // Every collab tool call carries agentsStates, not just spawnAgent — and
      // `wait`/`close` are where a child's terminal status actually shows up.
      // Reading only spawnAgent was why children stayed "running" forever.
      const spawning = item.tool === 'spawnAgent';
      const states = item.agentsStates && typeof item.agentsStates === 'object'
        ? (item.agentsStates as Record<string, { status?: unknown }>)
        : {};
      const receiverIds = Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
        : [];
      const nativeIds = [...new Set([...receiverIds, ...Object.keys(states)])];
      if (spawning && !nativeIds.length && item.status === 'failed') nativeIds.push(`failed:${String(item.id ?? '')}`);

      for (const nativeId of nativeIds) {
        reportedSubagentMeta.set(nativeId, {
          ...(typeof item.model === 'string' && item.model ? { model: item.model } : {}),
          ...(typeof item.reasoningEffort === 'string' && item.reasoningEffort
            ? { effort: item.reasoningEffort }
            : {}),
        });
        const reported = codexAgentStatus(states[nativeId]?.status);
        // Without a reported status we may only assume liveness for a spawn —
        // the child was just launched. On any other call, saying nothing is
        // the honest answer: never invent a terminal state Codex did not send.
        const status = reported ?? (spawning ? (item.status === 'failed' ? 'failed' : 'running') : null);
        if (!status) continue;
        emitSubagent(nativeId, status, {
          ...(typeof item.model === 'string' && item.model ? { model: item.model } : {}),
          ...(typeof item.reasoningEffort === 'string' && item.reasoningEffort ? { effort: item.reasoningEffort } : {}),
        });
        if (receiverIds.includes(nativeId) && !isTerminalSubagentStatus(status)) subscribeToSubagent(nativeId);
      }
      return true;
    }

    // Liveness, not elapsed time: a turn that is streaming, running a tool or
    // moving a child forward is alive however long it has been going. Only the
    // absolute ceiling bounds a turn that never stops looking busy.
    const watchdog = createTurnWatchdog({
      inactivityMs,
      ceilingMs: opts.turnTimeoutMs,
      onExpire: (reason) => {
        onEvent({
          type: 'error',
          message: turnTimeoutMessage(reason, inactivityMs, opts.turnTimeoutMs),
          fatal: false,
        });
        kill('timeout');
      },
    });
    /** Tool calls currently holding the inactivity window open, by item id. */
    const heldToolIds = new Set<string>();
    function holdForTool(itemId: string, toolName: string): void {
      if (isPollingToolName(toolName) || heldToolIds.has(itemId)) return;
      heldToolIds.add(itemId);
      watchdog.hold();
    }
    function releaseTool(itemId: string): void {
      if (heldToolIds.delete(itemId)) watchdog.release();
    }

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    function finish(): void {
      if (settled) return;
      settled = true;
      watchdog.stop();
      heldToolIds.clear();
      pruneFinishedSubagents();
      if (interruptFallbackTimer) {
        clearTimeout(interruptFallbackTimer);
        interruptFallbackTimer = null;
      }
      unsubscribe?.();
      for (const stop of childUnsubscribes.values()) stop();
      childUnsubscribes.clear();
      pendingApprovalIds.clear();
      pendingQuestionIds.clear();
      flushShadowState();
      resolveDone();
    }

    function permissionResponse(
      requested: RequestPermissionProfile,
      allow: boolean,
    ): PermissionsRequestApprovalResponse {
      if (!allow) return { permissions: {}, scope: 'turn' };
      // Construct a grant from only the two additions Codex requested. Never
      // substitute a named profile or danger-full-access here.
      return {
        permissions: {
          ...(requested.network !== null ? { network: requested.network } : {}),
          ...(requested.fileSystem !== null ? { fileSystem: requested.fileSystem } : {}),
        },
        scope: 'turn',
      };
    }

    function cancelPendingApprovals(): void {
      for (const pending of pendingApprovalIds.values()) {
        if (pending.kind === 'permissions') {
          client.respond(pending.id, permissionResponse(pending.permissions, false));
        } else {
          client.respond(pending.id, { decision: 'cancel' });
        }
      }
      pendingApprovalIds.clear();
    }

    function questionResponse(
      nativeIds: Map<string, string>,
      answers: QuestionAnswers,
    ): ToolRequestUserInputResponse {
      const nativeAnswers: ToolRequestUserInputResponse['answers'] = {};
      for (const [publicId, nativeId] of nativeIds) {
        nativeAnswers[nativeId] = { answers: answers[publicId] ?? [] };
      }
      return { answers: nativeAnswers };
    }

    function cancelPendingQuestions(): void {
      for (const pending of pendingQuestionIds.values()) {
        client.respond(pending.id, questionResponse(pending.nativeIds, {}));
      }
      pendingQuestionIds.clear();
    }

    /** Release Stop if app-server does not send the required native completion. */
    function finishInterrupted(reason: 'user' | 'timeout' = 'user', quarantine = false): void {
      if (settled) return;
      if (quarantine && resolvedThreadId && resolvedTurnId) {
        fallbackInterruptedThreads.add(resolvedThreadId);
      }
      // Deliberately NOT settling children here: interrupting the parent says
      // nothing about the delegated work, and Codex reports the real state on a
      // later wait/close.
      // The user hit Stop or steered — confirm with a muted notice, not a red
      // error. On a timeout the turn timer already surfaced its own message.
      if (reason === 'user') onEvent({ type: 'notice', message: 'Stopped.' });
      onEvent({
        type: 'turn_done',
        turnId,
        outcome: reason === 'user' ? 'interrupted_by_user' : 'timed_out',
      });
      finish();
    }

    function armInterruptFallback(reason: 'user' | 'timeout'): void {
      if (settled || interruptFallbackTimer) return;
      interruptFallbackTimer = setTimeout(
        () => finishInterrupted(reason, true),
        interruptCompletionTimeoutMs,
      );
      interruptFallbackTimer.unref?.();
    }

    function requestNativeInterrupt(reason: 'user' | 'timeout'): boolean {
      if (!resolvedThreadId || !resolvedTurnId || interruptRequested) return false;
      interruptRequested = true;
      armInterruptFallback(reason);
      // Current app-server contract: success is only an acknowledgement. The
      // matching turn/completed notification is the native lifecycle boundary.
      void client
        .request('turn/interrupt', { threadId: resolvedThreadId, turnId: resolvedTurnId })
        .catch((err) => log.warn(`[codex] turn interrupt failed: ${(err as Error).message}`));
      return true;
    }

    function handleServerMessage(msg: JsonRpcMessage): void {
      if (settled) {
        if (msg.id !== undefined) client.respondError(msg.id, -32000, 'Turn is already complete');
        return;
      }
      const method = msg.method;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const incomingTurnId = messageTurnId(msg);

      if (method !== DISCONNECTED_METHOD && (method?.startsWith('turn/') || method?.startsWith('item/'))) {
        // Turn and item events without a native turn id cannot safely be routed
        // on a multiplexed thread. Buffer valid early events until turn/start
        // returns its id, then reject anything from an older native turn.
        if (!incomingTurnId) {
          if (msg.id !== undefined) client.respondError(msg.id, -32000, 'Missing native turn id');
          return;
        }
        if (!resolvedTurnId) {
          if (method === 'item/started' || method === 'item/completed') {
            subscribeReportedSubagents((params.item ?? {}) as Record<string, unknown>);
          }
          pendingNativeMessages.push(msg);
          return;
        }
        if (incomingTurnId !== resolvedTurnId) {
          if (msg.id !== undefined) client.respondError(msg.id, -32000, 'No handler for this native turn');
          return;
        }
      }

      if (
        quarantineUnscopedNativeEvents
        && !incomingTurnId
        && (method === 'thread/tokenUsage/updated' || method === 'error')
      ) {
        return;
      }

      switch (method) {
        case DISCONNECTED_METHOD: {
          if (killed && killReason) {
            finishInterrupted(killReason);
            break;
          }
          settleActiveSubagents('stopped');
          onEvent({ type: 'error', message: 'Codex app-server disconnected unexpectedly.', fatal: false });
          onEvent({ type: 'turn_done', turnId, outcome: 'failed' });
          finish();
          break;
        }
        case 'item/agentMessage/delta': {
          watchdog.activity();
          onEvent({ type: 'text_delta', turnId, text: String(params.delta ?? '') });
          break;
        }
        case 'item/started': {
          const item = (params.item ?? {}) as Record<string, unknown>;
          if (!isBarePollItem(item)) watchdog.activity();
          if (handleSubagentItem(item)) {
            break;
          } else if (item.type === 'commandExecution') {
            if (typeof item.command === 'string') commandById.set(String(item.id), item.command);
            // A long build is blocked, not dead: hold the window until it ends.
            holdForTool(String(item.id), 'shell');
            const e: ConversationEvent = {
              type: 'tool_started',
              turnId,
              toolId: String(item.id),
              toolName: 'shell',
              displayName: 'Running a command',
              inputPreview: previewOf(item.command ?? ''),
            };
            onEvent(e);
            pushPersist(e);
          } else if (item.type === 'mcpToolCall') {
            const toolName = `mcp__${item.server ?? 'tool'}__${item.tool ?? ''}`;
            holdForTool(String(item.id), toolName);
            const connectorDetails = connectorInputDetails(toolName, item.arguments ?? {});
            const agentMessageDetails = agentMessageInputDetails(toolName, item.arguments ?? {});
            const e: ConversationEvent = {
              type: 'tool_started',
              turnId,
              toolId: String(item.id),
              toolName,
              displayName: displayNameForTool(toolName),
              inputPreview: previewOf(item.arguments ?? {}),
              ...(connectorDetails ? { connectorDetails } : {}),
              ...(agentMessageDetails ? { agentMessageDetails } : {}),
            };
            onEvent(e);
            pushPersist(e);
          }
          break;
        }
        case 'item/completed': {
          const item = (params.item ?? {}) as Record<string, unknown>;
          if (!isBarePollItem(item)) watchdog.activity();
          releaseTool(String(item.id));
          if (handleSubagentItem(item)) {
            break;
          } else if (item.type === 'agentMessage' && item.text) {
            const e: ConversationEvent = { type: 'text_final', turnId, markdown: String(item.text), at: new Date().toISOString() };
            onEvent(e);
            pushPersist(e);
          } else if (item.type === 'reasoning') {
            onEvent({ type: 'thinking', turnId });
          } else if (item.type === 'commandExecution') {
            const ok = (item.exitCode ?? 0) === 0;
            if (ok) {
              // A successful command is a producer signal: harvest watched file
              // paths from the full command and its full output (the output
              // matters when the command constructs the name dynamically).
              const command = commandById.get(String(item.id)) ?? (typeof item.command === 'string' ? item.command : '');
              if (command) recordCommandCandidates(command);
              if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput) {
                recordCommandCandidates(boundedResultText(item.aggregatedOutput), MAX_BASH_RESULT_FILES);
              }
            }
            const e: ConversationEvent = {
              type: 'tool_finished',
              turnId,
              toolId: String(item.id),
              ok,
              resultPreview: previewOf(item.aggregatedOutput ?? ''),
            };
            onEvent(e);
            pushPersist(e);
          } else if (item.type === 'fileChange') {
            const changes = Array.isArray(item.changes) ? (item.changes as { path: string; kind: { type?: string } | string }[]) : [];
            if (item.status !== 'failed') {
              // fileChange paths are exact (Codex's Write equivalent), so the
              // watched-text-extension set is trusted, same as Claude's Write.
              for (const change of changes) {
                if (typeof change?.path !== 'string') continue;
                if (!WRITE_EXTS.has(path.extname(change.path).toLowerCase())) continue;
                createdFiles.set(absoluteCandidate(change.path), 'write');
              }
            }
            const displayName = changes.length === 1 ? 'Editing a file' : `Editing ${changes.length} files`;
            const inputPreview = previewOf(
              changes.map((c) => `${typeof c.kind === 'string' ? c.kind : c.kind?.type}: ${c.path}`).join(', '),
            );
            const started: ConversationEvent = { type: 'tool_started', turnId, toolId: String(item.id), toolName: 'file_change', displayName, inputPreview };
            const finished: ConversationEvent = {
              type: 'tool_finished',
              turnId,
              toolId: String(item.id),
              ok: item.status !== 'failed',
              resultPreview: inputPreview,
            };
            onEvent(started);
            pushPersist(started);
            onEvent(finished);
            pushPersist(finished);
          } else if (item.type === 'mcpToolCall') {
            const toolName = `mcp__${item.server ?? 'tool'}__${item.tool ?? ''}`;
            const connectorDetails = connectorResultDetails(toolName, item.result ?? item.error ?? '');
            const e: ConversationEvent = {
              type: 'tool_finished',
              turnId,
              toolId: String(item.id),
              ok: !item.error,
              resultPreview: previewOf(item.result ?? item.error ?? ''),
              ...(connectorDetails ? { connectorDetails } : {}),
            };
            onEvent(e);
            pushPersist(e);
          }
          break;
        }
        case 'item/tool/call': {
          if (msg.id === undefined) break;
          const tool = String(params.tool ?? '');
          if (tool !== CODEX_BROWSER_TOOL_NAME) {
            client.respond(msg.id, {
              success: false,
              contentItems: [{ type: 'inputText', text: `Unsupported client-hosted tool: ${tool}` }],
            });
            break;
          }
          const callId = String(params.callId ?? msg.id);
          const input = (params.arguments ?? {}) as Record<string, unknown>;
          const started: ConversationEvent = {
            type: 'tool_started',
            turnId,
            toolId: callId,
            toolName: 'mcp__agent_browser__run',
            displayName: displayNameForTool('mcp__agent_browser__run'),
            inputPreview: previewOf(input),
          };
          onEvent(started);
          pushPersist(started);
          const shared = input.shared === true;
          const command = String((Array.isArray(input.args) ? input.args[0] : '') ?? '').toLowerCase();
          void runBrowser(input.args, {
            conversationId: spec.conversationId ?? spec.nativeSessionId,
            workspaceDir: spec.cwd,
            timeoutMs: input.timeout_ms === undefined ? undefined : Number(input.timeout_ms),
            shared,
          })
            .then((result) => {
              const text = browserResultText(result, shared, command);
              const contentItems: Array<{ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }> = [
                { type: 'inputText', text },
              ];
              const images: string[] = [];
              if (result.screenshotPath && result.exitCode === 0 && fsSync.existsSync(result.screenshotPath)) {
                const image = fsSync.readFileSync(result.screenshotPath);
                const mediaId = saveImageBytes(image, 'image/png');
                if (mediaId) images.push(mediaId);
                if (image.length <= 5 * 1024 * 1024) {
                  contentItems.push({ type: 'inputImage', imageUrl: `data:image/png;base64,${image.toString('base64')}` });
                }
              }
              client.respond(msg.id!, { success: result.exitCode === 0, contentItems });
              const finished: ConversationEvent = {
                type: 'tool_finished',
                turnId,
                toolId: callId,
                ok: result.exitCode === 0,
                resultPreview: previewOf(text),
                ...(images.length ? { images } : {}),
              };
              onEvent(finished);
              pushPersist(finished);
            })
            .catch((error) => {
              const message = (error as Error).message;
              client.respond(msg.id!, {
                success: false,
                contentItems: [{ type: 'inputText', text: `Agent Browser error: ${message}` }],
              });
              const finished: ConversationEvent = {
                type: 'tool_finished',
                turnId,
                toolId: callId,
                ok: false,
                resultPreview: previewOf(message),
              };
              onEvent(finished);
              pushPersist(finished);
            });
          break;
        }
        case 'item/tool/requestUserInput': {
          if (msg.id === undefined) break;
          const request = params as unknown as ToolRequestUserInputParams;
          const rawQuestions = Array.isArray(request.questions) ? request.questions : [];
          const malformed =
            rawQuestions.length < 1 ||
            rawQuestions.length > 3 ||
            rawQuestions.some(
              (question) =>
                !question ||
                typeof question.id !== 'string' ||
                typeof question.header !== 'string' ||
                question.header.length > 100 ||
                typeof question.question !== 'string' ||
                !question.question.trim() ||
                question.question.length > 4_000 ||
                (Array.isArray(question.options) && question.options.length > 20) ||
                (!question.isOther && (!Array.isArray(question.options) || question.options.length === 0)) ||
                (Array.isArray(question.options) && question.options.some(
                  (option) =>
                    !option ||
                    typeof option.label !== 'string' ||
                    !option.label.trim() ||
                    option.label.length > 200 ||
                    typeof option.description !== 'string' ||
                    option.description.length > 500,
                )),
            );
          if (malformed) {
            client.respondError(msg.id, -32602, 'Invalid structured question request');
            log.warn('[codex] rejected malformed item/tool/requestUserInput request');
            break;
          }
          // Secret values must never cross Veneer's normalized event seam, DB,
          // logs, or browser API. Fail before constructing any public event.
          if (rawQuestions.some((question) => question.isSecret)) {
            client.respondError(msg.id, -32602, 'Sensitive input is not supported in chat questions');
            log.warn('[codex] rejected sensitive item/tool/requestUserInput request');
            break;
          }

          const requestId = crypto.randomUUID();
          const nativeIds = new Map<string, string>();
          const questions = rawQuestions.map((question, index) => {
            const publicId = `q${index + 1}`;
            nativeIds.set(publicId, question.id);
            return {
              id: publicId,
              ...(question.header.trim() ? { header: question.header.trim() } : {}),
              question: question.question.trim(),
              options: (question.options ?? []).map((option) => ({
                label: String(option.label ?? '').trim(),
                value: String(option.label ?? '').trim(),
                ...(String(option.description ?? '').trim()
                  ? { description: String(option.description).trim() }
                  : {}),
              })).filter((option) => option.label),
              multi: false,
              allowOther: Boolean(question.isOther),
            };
          });
          pendingQuestionIds.set(requestId, { id: msg.id, nativeIds });
          watchdog.hold();
          onEvent({
            type: 'question_asked',
            requestId,
            turnId,
            questions,
            responseMode: 'provider',
            blocking: Boolean(request.isBlocking),
            autoResolutionMs:
              typeof request.autoResolutionMs === 'number' && Number.isFinite(request.autoResolutionMs)
                ? Math.min(15 * 60_000, Math.max(0, request.autoResolutionMs))
                : null,
          });
          break;
        }
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval': {
          if (msg.id === undefined) break;
          const requestId = String(msg.id);
          const isCommand = method === 'item/commandExecution/requestApproval';
          pendingApprovalIds.set(requestId, { id: msg.id, kind: isCommand ? 'command' : 'file' });
          watchdog.hold(); // matches the Claude adapter: the human owns the clock while a decision is pending
          const e: ConversationEvent = {
            type: 'approval_requested',
            requestId,
            toolName: isCommand ? 'shell' : 'file_change',
            displayName: isCommand ? 'Run a command' : 'Change files',
            input: params,
            inputPreview: previewOf(params.command ?? params.itemId ?? ''),
            policyReason: String(params.reason ?? 'This action needs your approval.'),
          };
          onEvent(e);
          pushPersist(e);
          break;
        }
        case 'item/permissions/requestApproval': {
          if (msg.id === undefined) break;
          const request = params as unknown as PermissionsRequestApprovalParams;
          const permissions = request.permissions;
          if (
            !permissions ||
            typeof permissions !== 'object' ||
            !Object.prototype.hasOwnProperty.call(permissions, 'network') ||
            !Object.prototype.hasOwnProperty.call(permissions, 'fileSystem')
          ) {
            client.respondError(msg.id, -32602, 'Invalid permission approval request');
            log.warn('[codex] rejected malformed item/permissions/requestApproval request');
            break;
          }
          const requestId = String(msg.id);
          pendingApprovalIds.set(requestId, { id: msg.id, kind: 'permissions', permissions });
          watchdog.hold();
          const wantsNetwork = permissions.network !== null;
          const wantsFiles = permissions.fileSystem !== null;
          const displayName =
            wantsNetwork && wantsFiles
              ? 'Allow network and file access'
              : wantsNetwork
                ? 'Allow network access'
                : wantsFiles
                  ? 'Allow file access'
                  : 'Allow requested access';
          const e: ConversationEvent = {
            type: 'approval_requested',
            requestId,
            toolName: 'permissions',
            displayName,
            input: { permissions, reason: request.reason },
            inputPreview: displayName,
            policyReason: request.reason ?? 'Codex needs additional access to complete this action.',
          };
          onEvent(e);
          pushPersist(e);
          break;
        }
        case 'serverRequest/resolved': {
          const nativeRequestId = String(params.requestId ?? '');
          let released = pendingApprovalIds.delete(nativeRequestId);
          for (const [requestId, pending] of pendingQuestionIds) {
            if (String(pending.id) !== nativeRequestId) continue;
            pendingQuestionIds.delete(requestId);
            released = true;
            break;
          }
          if (released) watchdog.release();
          break;
        }
        case 'thread/tokenUsage/updated': {
          const tokenUsage = params.tokenUsage as { total?: unknown; last?: unknown } | undefined;
          const last = codexTokenCount(tokenUsage?.last);
          const total = codexTokenCount(tokenUsage?.total);
          if (last) {
            // cachedInputTokens is a subset of inputTokens in the app-server
            // contract, so adding it here would double-count cached context.
            // It is dropped outright: the turn-level figure comes off `total`,
            // and a stray last-call value would otherwise leak into turn_done.
            lastUsage = { inputTokens: last.inputTokens, outputTokens: last.outputTokens };
          }
          if (last && total) {
            tokenBaseline ??= {
              inputTokens: Math.max(0, total.inputTokens - last.inputTokens),
              outputTokens: Math.max(0, total.outputTokens - last.outputTokens),
              ...(total.cachedInputTokens !== undefined && last.cachedInputTokens !== undefined
                ? { cachedInputTokens: Math.max(0, total.cachedInputTokens - last.cachedInputTokens) }
                : {}),
            };
            const totalInputTokens = total.inputTokens - tokenBaseline.inputTokens;
            const totalOutputTokens = total.outputTokens - tokenBaseline.outputTokens;
            // Cache reads are a subset of input, so the turn's share only makes
            // sense when both ends of the subtraction carried the figure.
            const turnCached =
              total.cachedInputTokens !== undefined && tokenBaseline.cachedInputTokens !== undefined
                ? total.cachedInputTokens - tokenBaseline.cachedInputTokens
                : undefined;
            if (totalInputTokens >= 0 && totalOutputTokens >= 0) {
              totalUsage = {
                totalInputTokens,
                totalOutputTokens,
                totalTokens: totalInputTokens + totalOutputTokens,
                ...(turnCached !== undefined && turnCached >= 0 && turnCached <= totalInputTokens
                  ? { cachedInputTokens: turnCached }
                  : {}),
              };
            }
          }
          break;
        }
        case 'turn/completed': {
          const turn = (params.turn ?? {}) as {
            id?: string;
            status?: 'completed' | 'interrupted' | 'failed';
            error?: { message?: string } | null;
          };
          const outcome =
            killReason === 'user'
              ? 'interrupted_by_user'
              : killReason === 'timeout'
                ? 'timed_out'
                : turn.status === 'failed' || turn.error
                  ? 'failed'
                  : 'completed';
          // An interrupted or timed-out parent leaves its children alone; only a
          // real terminal report from Codex may change a child's status.
          let usageLimitText: string | null = null;
          if (turn.error && outcome === 'failed') {
            settleActiveSubagents('failed');
            const message = turn.error.message ?? 'Turn failed';
            if (CODEX_USAGE_LIMIT_RE.test(message)) usageLimitText = message;
            const e: ConversationEvent = { type: 'error', message, fatal: false };
            onEvent(e);
            pushPersist(e);
          }
          if (outcome === 'interrupted_by_user') onEvent({ type: 'notice', message: 'Stopped.' });
          const done: ConversationEvent = {
            type: 'turn_done',
            turnId,
            outcome,
            usage: lastUsage ? { ...lastUsage, ...totalUsage } : undefined,
          };
          onEvent(done);
          pushPersist(done);
          finish();
          // The subscription, not the work, ended this turn. Reported after
          // turn_done so the failover's continuation queues behind a finished
          // turn. Best effort: a throw here must not derail the stream.
          if (usageLimitText && opts.onUsageLimit) {
            try {
              opts.onUsageLimit({
                conversationId: spec.conversationId ?? null,
                accountId: spawnAccountId,
                text: usageLimitText,
                at: new Date(),
              });
            } catch (err) {
              log.warn(`[codex] usage-limit failover failed: ${(err as Error).message}`);
            }
          }
          break;
        }
        case 'error': {
          const e: ConversationEvent = { type: 'error', message: String(params.message ?? 'Something went wrong'), fatal: false };
          onEvent(e);
          pushPersist(e);
          break;
        }
        default:
          if (msg.id !== undefined) {
            // Protocol drift must fail closed. A successful empty response can
            // accidentally grant or acknowledge a capability; an explicit
            // method-not-supported error lets Codex recover visibly.
            client.respondError(msg.id, -32601, `Unsupported server request: ${method ?? 'unknown'}`);
            log.warn(`[codex] rejected unsupported server request: ${method ?? 'unknown'}`);
          }
          break; // notifications such as configWarning/thread/started carry no id
      }
    }

    async function start(): Promise<void> {
      try {
        // Normal conversations get a real sandbox + real approval prompts;
        // Full Access gets an unrestricted sandbox and never asks, matching
        // Claude's --dangerously-skip-permissions behavior.
        const sandbox = spec.dangerous ? 'danger-full-access' : 'workspace-write';
        const approvalPolicy = spec.dangerous ? 'never' : 'on-request';
        // Inject every materialized MCP server (built-in agents server + the
        // user's connectors + toolbox servers) as a per-thread config override
        // (config.toml-shaped). Passed on both start and resume so the agent
        // token — and any connector installed mid-conversation — is current
        // every turn. Shaping (tool_timeout_sec for agents, mcp-remote
        // wrapping for headered remote servers) lives in codexMcpServers.
        const mcpServers = codexMcpServers(spec.mcpConfigPath);
        const config = Object.keys(mcpServers).length ? { mcp_servers: mcpServers } : undefined;
        let threadId: string;
        // History is retained across a fork; the chat just gets a new native id.
        const fork = async (): Promise<string> => {
          const res = (await client.request('thread/fork', {
            threadId: spec.nativeSessionId,
            cwd: spec.cwd,
            sandbox,
            approvalPolicy,
            model: spec.model ?? undefined,
            config,
            developerInstructions: spec.developerInstructions ?? undefined,
            dynamicTools: [CODEX_BROWSER_TOOL],
          })) as { thread: { id: string } };
          await recordCodexFork(opts, res.thread.id, spec.nativeSessionId);
          onSessionId?.(res.thread.id);
          return res.thread.id;
        };
        if (spec.firstTurn) {
          const res = (await client.request('thread/start', {
            cwd: spec.cwd,
            sandbox,
            approvalPolicy,
            model: spec.model ?? undefined,
            reasoningEffort: spec.effort ?? undefined,
            config,
            developerInstructions: spec.developerInstructions ?? undefined,
            dynamicTools: [CODEX_BROWSER_TOOL],
          })) as { thread: { id: string } };
          threadId = res.thread.id;
          onSessionId?.(threadId);
        } else if (spec.refreshDeveloperInstructions) {
          // A loaded app-server thread can ignore resume-time overrides. Fork
          // once when the durable developer hash changes: history is retained,
          // a new native id is returned, and the next turn cannot run with stale
          // or missing Core Veneer rules.
          await releaseThreadOwner(spec.nativeSessionId, client);
          threadId = await fork();
        } else {
          const resume = async (): Promise<string> => {
            const res = (await client.request('thread/resume', {
              threadId: spec.nativeSessionId,
              sandbox,
              approvalPolicy,
              config,
              developerInstructions: spec.developerInstructions ?? undefined,
              // Accepted by current app-server builds even though older schema
              // snapshots omitted it; refreshes the host tool on resumed chats.
              dynamicTools: [CODEX_BROWSER_TOOL],
            })) as { thread?: { id: string } };
            return res.thread?.id ?? spec.nativeSessionId;
          };
          // The process that last loaded this thread holds its writer lock
          // until it closes the thread (see threadOwners).
          await releaseThreadOwner(spec.nativeSessionId, client);
          try {
            threadId = await resume();
          } catch (err) {
            if (!isWriterLocked(err)) throw err;
            await releaseThreadEverywhere(spec.nativeSessionId, client);
            try {
              threadId = await resume();
            } catch (retryErr) {
              if (!isWriterLocked(retryErr)) throw retryErr;
              // Nothing we can reach will release it (another service, or a
              // process that ignores thread/close): continue on a fork rather
              // than leaving the chat stuck behind the lock.
              threadId = await fork();
              onEvent({
                type: 'notice',
                message: 'Codex kept this thread open in another process; Veneer continued it in a new thread with the full history.',
              });
            }
          }
        }
        threadOwners.set(threadId, client);
        resolvedThreadId = threadId;
        quarantineUnscopedNativeEvents = fallbackInterruptedThreads.delete(threadId);
        // A Stop/timeout that landed while thread/start|resume was in flight only set
        // `killed` (no thread id existed to interrupt) — bail before running the turn.
        // kill() has already settled `done`.
        if (killed) return;
        historyReady = true;
        flushShadowState();
        unsubscribe = client.subscribe(threadId, handleServerMessage);
        const started = (await client.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: spec.prompt }],
          effort: spec.effort ?? undefined,
        })) as { turn?: { id?: string } };
        resolvedTurnId = started.turn?.id ?? null;
        if (!resolvedTurnId) throw new Error('turn/start did not return a native turn id');
        if (killed && killReason) requestNativeInterrupt(killReason);
        for (const message of pendingNativeMessages.splice(0)) handleServerMessage(message);
        // Resolution happens via the 'turn/completed' notification above.
      } catch (err) {
        if (settled) return;
        if (killed && killReason) {
          armInterruptFallback(killReason);
          return;
        }
        settleActiveSubagents('failed');
        const message = (err as Error).message;
        const looksUnauthenticated = /not logged in|no .*(credential|auth)|401|unauthorized/i.test(message);
        onEvent({
          type: 'error',
          message: looksUnauthenticated
            ? "Codex isn't connected — ask your administrator to connect a Codex account in Settings."
            : `Could not start the assistant: ${message}`,
          fatal: true,
        });
        onEvent({ type: 'turn_done', turnId, outcome: 'failed' });
        finish();
      }
    }
    void start();

    // Codex cannot cancel a delegated child independently of the parent turn,
    // so "Send now" and an explicit Stop take the same path here.
    function kill(reason: TurnKillReason = 'user'): void {
      if (killed) return;
      killed = true;
      const internal = reason === 'timeout' ? 'timeout' : 'user';
      killReason = internal;
      cancelPendingApprovals();
      cancelPendingQuestions();
      if (resolvedThreadId) {
        // If turn/start is still resolving, start() sends the interrupt as soon
        // as its native id arrives. Either way, Stop has one bounded deadline.
        armInterruptFallback(internal);
        requestNativeInterrupt(internal);
      } else {
        // No thread id yet (Stop/timeout during thread/start|resume): there's nothing
        // to interrupt. The in-flight start() sees `killed` at its next await boundary
        // and bails; settle now so `done` can't hang forever.
        finishInterrupted(internal);
      }
    }

    function respondToApproval(requestId: string, decision: ApprovalDecision): boolean {
      const pending = pendingApprovalIds.get(requestId);
      if (pending === undefined) return false;
      pendingApprovalIds.delete(requestId);
      if (pending.kind === 'permissions') {
        client.respond(
          pending.id,
          permissionResponse(pending.permissions, decision.behavior === 'allow'),
        );
      } else {
        client.respond(pending.id, { decision: decision.behavior === 'allow' ? 'accept' : 'decline' });
      }
      watchdog.release(); // the human answered — the turn is live again
      return true;
    }

    function respondToQuestion(requestId: string, answers: QuestionAnswers): boolean {
      const pending = pendingQuestionIds.get(requestId);
      if (!pending) return false;
      pendingQuestionIds.delete(requestId);
      client.respond(pending.id, questionResponse(pending.nativeIds, answers));
      watchdog.release();
      return true;
    }

    async function steer(text: string): Promise<boolean> {
      const threadId = resolvedThreadId;
      const expectedTurnId = resolvedTurnId;
      if (settled || killed || !threadId || !expectedTurnId) return false;
      try {
        await client.request('turn/steer', {
          threadId,
          expectedTurnId,
          clientUserMessageId: crypto.randomUUID(),
          input: [{ type: 'text', text }],
        });
        if (settled || killed) return false;
        const event: ConversationEvent = {
          type: 'turn_started',
          turnId,
          role: 'user',
          text,
          at: new Date().toISOString(),
          via: 'web',
        };
        pushPersist(event);
        onEvent(event);
        return true;
      } catch (err) {
        log.warn(`[codex] turn steer failed; retaining queued fallback: ${(err as Error).message}`);
        return false;
      }
    }

    return { done, kill, steer, respondToApproval, respondToQuestion };
  }

  function compactSession(spec: CompactSessionSpec): CompactSessionHandle {
    const client = clientFor(spec.dangerous ?? false, opts.getAccountId?.() ?? null);
    const threadId = spec.nativeSessionId;
    let settled = false;
    let requested = false;
    let killed = false;
    let timedOut = false;
    let nativeTurnId: string | null = null;
    let sawCompactionItem = false;
    let sawCompletedItem = false;
    let sawCompletedTurn = false;
    let failureMessage = '';
    let timer: NodeJS.Timeout | null = null;
    let interruptFallback: NodeJS.Timeout | null = null;
    let unsubscribe: (() => void) | null = null;
    let resolveDone!: (result: { contextTokens: null }) => void;
    let rejectDone!: (err: Error) => void;

    const done = new Promise<{ contextTokens: null }>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    function finish(err?: Error): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (interruptFallback) clearTimeout(interruptFallback);
      unsubscribe?.();
      unsubscribe = null;
      if (err) rejectDone(err);
      else {
        try {
          appendShadowTranscript(opts.transcriptsDir, threadId, [
            { type: 'notice', message: CONTEXT_COMPACTED_NOTICE },
          ]);
        } catch (writeError) {
          log.warn(`[codex] compaction notice write failed: ${(writeError as Error).message}`);
        }
        resolveDone({ contextTokens: null });
      }
    }

    function completionError(): Error {
      if (timedOut) return new Error('Codex context compaction timed out.');
      if (killed) return new Error('Codex context compaction was interrupted.');
      return new Error(failureMessage || 'Codex could not compact the thread.');
    }

    function maybeFinish(): void {
      if (!sawCompletedTurn || !sawCompletedItem) return;
      if (killed || failureMessage) finish(completionError());
      else finish();
    }

    function requestInterrupt(): void {
      if (!nativeTurnId || settled) return;
      void client
        .request('turn/interrupt', { threadId, turnId: nativeTurnId })
        .catch((err) => log.warn(`[codex] compaction interrupt failed: ${(err as Error).message}`));
    }

    function armInterruptFallback(): void {
      if (interruptFallback || settled) return;
      interruptFallback = setTimeout(() => finish(completionError()), interruptCompletionTimeoutMs);
      interruptFallback.unref?.();
    }

    function handleCompactionMessage(msg: JsonRpcMessage): void {
      if (settled) return;
      const method = msg.method;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const incomingTurnId = messageTurnId(msg);

      if (method === DISCONNECTED_METHOD) {
        finish(new Error('Codex app-server disconnected while compacting.'));
        return;
      }

      // thread/resume can replay thread-scoped notifications. Ignore those
      // until compact/start has actually been sent so stale lifecycle events
      // cannot be mistaken for this maintenance turn.
      if (!requested) {
        if (msg.id !== undefined) {
          client.respondError(msg.id, -32000, 'Context compaction has not started');
        }
        return;
      }

      if (method === 'turn/started' && incomingTurnId && !nativeTurnId) {
        nativeTurnId = incomingTurnId;
        if (killed) requestInterrupt();
      }

      if (method === 'item/started' || method === 'item/completed') {
        const item = (params.item ?? {}) as Record<string, unknown>;
        if (item.type === 'contextCompaction' && incomingTurnId) {
          if (nativeTurnId && nativeTurnId !== incomingTurnId) return;
          nativeTurnId = incomingTurnId;
          sawCompactionItem = true;
          if (method === 'item/completed') sawCompletedItem = true;
          if (killed) requestInterrupt();
          maybeFinish();
        }
        return;
      }

      if (method === 'error' && (!incomingTurnId || !nativeTurnId || incomingTurnId === nativeTurnId)) {
        const error = params.error as { message?: unknown } | undefined;
        failureMessage = typeof error?.message === 'string'
          ? error.message
          : typeof params.message === 'string'
            ? params.message
            : 'Codex reported an error while compacting.';
        return;
      }

      if (method === 'turn/completed' && incomingTurnId) {
        if (nativeTurnId && incomingTurnId !== nativeTurnId) return;
        nativeTurnId = incomingTurnId;
        const turn = (params.turn ?? {}) as {
          status?: 'completed' | 'interrupted' | 'failed';
          error?: { message?: unknown } | null;
        };
        if (turn.status === 'failed' || turn.status === 'interrupted' || turn.error) {
          const message = turn.error?.message;
          failureMessage = typeof message === 'string'
            ? message
            : turn.status === 'interrupted'
              ? 'Codex context compaction was interrupted.'
              : 'Codex could not compact the thread.';
        }
        sawCompletedTurn = true;
        // A failed native turn may never complete its compaction item.
        if (failureMessage || killed) finish(completionError());
        else if (!sawCompactionItem) finish(new Error('Codex completed without a context compaction event.'));
        else maybeFinish();
        return;
      }

      if (msg.id !== undefined) {
        client.respondError(msg.id, -32601, `Unsupported server request during compaction: ${method ?? 'unknown'}`);
      }
    }

    unsubscribe = client.subscribe(threadId, handleCompactionMessage);
    // Compaction is one bounded non-interactive request, so it is guarded by
    // the inactivity window rather than the multi-hour turn ceiling.
    timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      requestInterrupt();
      armInterruptFallback();
    }, inactivityMs);
    timer.unref?.();

    void (async () => {
      try {
        // Reload persisted threads after an app-server restart before asking it
        // to compact. Subscribe first so no lifecycle notification can race us.
        await releaseThreadOwner(threadId, client);
        await client.request('thread/resume', { threadId });
        threadOwners.set(threadId, client);
        if (killed || settled) {
          finish(completionError());
          return;
        }
        requested = true;
        await client.request('thread/compact/start', { threadId });
        // Completion is notification-driven; the request intentionally returns
        // immediately with an empty result.
      } catch (err) {
        finish(err as Error);
      }
    })();

    function kill(): void {
      if (killed || settled) return;
      killed = true;
      if (!requested) {
        finish(completionError());
        return;
      }
      requestInterrupt();
      armInterruptFallback();
    }

    return { done, kill };
  }

  return {
    id: 'codex',
    // Placeholder until thread/start resolves the real thread id (see onSessionId) — same
    // pattern as the exec adapter; conversationManager overwrites it once the real id lands.
    mintSessionId: () => crypto.randomUUID(),
    runTurn,
    compactSession,
    readTranscript: (conv) => readCodexHistory(opts, conv.nativeSessionId),
    // Display history comes from Veneer's own shadow transcript; this is the
    // native rollout file resume needs, archived as cheap insurance. Named
    // rollout-<timestamp>-<thread>.jsonl, so it is only findable while it
    // exists — a restore has nowhere to put it back.
    nativeTranscriptPath: (conv) => findRolloutFile(conv.nativeSessionId),
    readModel: (conv) => readCodexModel(conv.nativeSessionId),
    listModels,
    listCreatedFiles: (conv) => readCodexHistoryFiles(opts, conv.nativeSessionId),
  };
}
