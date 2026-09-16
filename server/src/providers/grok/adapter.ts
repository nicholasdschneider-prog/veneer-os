import crypto from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';
import { agentEnv, currentHomes, expandUserPath, proGrokHome } from '../../homes.js';
import type { ConversationEvent, SubagentStatus } from '../../runtime/events.js';
import { displayNameForTool, previewOf } from '../../runtime/events.js';
import { connectorInputDetails, connectorResultDetails } from '../../runtime/connectorToolDetails.js';
import { agentMessageInputDetails } from '../../runtime/agentMessageToolDetails.js';
import { subagentEventKey, subagentLabel } from '../../runtime/subagents.js';
import { MAX_BASH_RESULT_FILES, WRITE_EXTS, boundedResultText, fileCandidates } from '../fileScan.js';
import type {
  ApprovalDecision,
  ModelOption,
  ProviderAdapter,
  TurnHandle,
  TurnKillReason,
  TurnSpec,
} from '../types.js';
import { createTurnWatchdog, isPollingToolName, turnTimeoutMessage } from '../turnWatchdog.js';
import { grokMcpServers } from '../agentsMcp.js';
import {
  appendShadowFiles,
  appendShadowTranscript,
  readGrokTranscript,
  readLegacyOutboxFiles,
  readShadowFiles,
  readShadowModel,
  writeShadowModel,
} from './transcript.js';
import { disableVendorCompatScanners, ensureGrokProfile, grokAuthFile } from './profile.js';
import {
  AcpClient,
  DISCONNECTED_METHOD,
  isAuthenticationError,
  type GrokAvailableModel,
  type GrokInitializeResult,
  type JsonRpcMessage,
} from './protocol.js';

const MODELS_CACHE_TTL_MS = 5 * 60_000;
const INITIALIZE_TIMEOUT_MS = 8_000;

/**
 * Grok is not connected until a subscription login has written auth.json into
 * the pinned GROK_HOME. This exact wording is what the user sees on a pre-login
 * turn and is what listModels' empty result means.
 */
const NOT_CONNECTED_MESSAGE = 'Grok is not connected. Connect it in Settings → Providers.';

/**
 * `grok-imagine-*` entries are image/video generation endpoints, not coding
 * models — they appear in the same availableModels list and must never reach
 * the chat model picker.
 */
const NON_CODING_MODEL_PREFIX = 'grok-imagine';

/** Fallback default when `initialize` does not report a currentModelId. */
const DEFAULT_MODEL_ID = 'grok-4.5';

/** Slider order for Grok's known reasoning-effort ids. Unknown ids sort after. */
const GROK_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'];

/**
 * ACP `ToolKind` → Veneer's tool vocabulary. Grok's ACP stream has no tool-name
 * field for built-in tools (only a human `title` and this coarse `kind`), so the
 * kind is what the UI's tool rows are keyed on. MCP tools are handled
 * separately: they arrive namespaced and get the `mcp__server__tool` name every
 * other provider uses, so connector rendering and display names come for free.
 */
const KIND_TOOLS: Record<string, { name: string; display: string }> = {
  read: { name: 'Read', display: 'Reading a file' },
  edit: { name: 'file_change', display: 'Editing a file' },
  delete: { name: 'file_delete', display: 'Deleting a file' },
  move: { name: 'file_move', display: 'Moving a file' },
  search: { name: 'search', display: 'Searching' },
  execute: { name: 'shell', display: 'Running a command' },
  think: { name: 'think', display: 'Thinking' },
  fetch: { name: 'WebFetch', display: 'Reading a web page' },
  other: { name: 'tool', display: 'Using a tool' },
};

/**
 * How long Veneer keeps listening to a Grok session after its parent turn ends.
 *
 * Grok's background subagents outlive the prompt that spawned them: one
 * observed child reported `subagent_finished` 55 s after its parent's
 * `session/prompt` resolved, and Veneer had already unsubscribed, so the
 * completion was never shown. Staying subscribed briefly closes that window
 * without holding a session open indefinitely.
 */
const LATE_SUBAGENT_WINDOW_MS = 5 * 60 * 1000;

export interface GrokAdapterOptions {
  grokBin: string;
  /** Absolute per-turn ceiling. The inactivity window below is the real guard. */
  turnTimeoutMs: number;
  /**
   * Idle time with no provider progress before the turn is reaped. Omitting it
   * leaves the absolute ceiling as the only guard, which is the pre-watchdog
   * behaviour.
   */
  turnInactivityMs?: number;
  /** Maximum wait for the session/prompt response after session/cancel. */
  cancelCompletionTimeoutMs?: number;
  /** Canonical Grok shadow-transcript store (<dataDir>/grok-transcripts). */
  transcriptsDir: string;
  log?: Pick<Console, 'warn' | 'error'>;
  /** Test seam for the per-access-level agent environment. */
  buildEnv?: (fullAccess: boolean) => NodeJS.ProcessEnv;
  /** Test seam for the retired File Box compatibility roots. */
  legacyOutboxHomes?: readonly string[];
}

interface AcpToolUpdate {
  toolCallId?: unknown;
  title?: unknown;
  kind?: unknown;
  status?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  locations?: unknown;
  _meta?: Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Flatten ACP tool `content` items into previewable text. */
function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === 'diff') {
      parts.push(`diff: ${String(entry.path ?? '')}`);
      continue;
    }
    const inner = entry.content;
    if (inner && typeof inner === 'object') {
      const text = str((inner as Record<string, unknown>).text);
      if (text) parts.push(text);
    } else if (typeof inner === 'string') {
      parts.push(inner);
    }
  }
  return parts.join('\n');
}

/** Paths named by an ACP tool call's `locations`. */
function toolLocations(locations: unknown): string[] {
  if (!Array.isArray(locations)) return [];
  const out: string[] = [];
  for (const item of locations) {
    if (!item || typeof item !== 'object') continue;
    const p = str((item as Record<string, unknown>).path);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Grok 1.0.3 sometimes reports every built-in call as kind=other/title=tool.
 * The raw input still carries the real command. Only accept explicit command
 * fields so a URL or a read-only file argument cannot become a deliverable.
 */
function toolCommand(rawInput: unknown, kind: unknown): string | undefined {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const input = rawInput as Record<string, unknown>;
    return str(input.command) ?? str(input.cmd);
  }
  if (kind === 'execute') return str(rawInput);
  if (typeof rawInput === 'string' && rawInput.length <= 64 * 1024 && rawInput.trimStart().startsWith('{')) {
    try {
      return toolCommand(JSON.parse(rawInput), kind);
    } catch {
      /* not structured input */
    }
  }
  return undefined;
}

/**
 * Grok's tool identity lives in a vendor `_meta` extension, not in ACP proper.
 * `x.ai/tool` is the authoritative one (it carries the real registered name,
 * including for subagent tools); `toolName` is the older spelling and `title`
 * is only a human label.
 */
function grokMetaToolName(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta) return undefined;
  const vendor = meta['x.ai/tool'];
  if (vendor && typeof vendor === 'object') {
    const name = str((vendor as Record<string, unknown>).name);
    if (name) return name;
  }
  return str(meta.toolName);
}

/** Grok's lifecycle rails for one delegated agent. */
const SUBAGENT_SPAWNED = 'subagent_spawned';
const SUBAGENT_FINISHED = 'subagent_finished';

/**
 * Map one of Grok's subagent lifecycle payloads onto the normalized model.
 *
 * Both rails matter. The live rail is a `session/update` (or a vendor-prefixed
 * notification of the same shape); the replay rail is the same events re-sent
 * by `session/load`, and a resumed chat is exactly where a child spawned by an
 * earlier turn is still running. Returning null means "not a lifecycle event".
 */
export function grokSubagentLifecycle(
  kind: string,
  payload: Record<string, unknown>,
): { nativeId: string; status: SubagentStatus; label?: string; model?: string } | null {
  const normalized = kind.split('/').pop() ?? kind;
  if (normalized !== SUBAGENT_SPAWNED && normalized !== SUBAGENT_FINISHED) return null;
  const nativeId =
    str(payload.subagentId) ??
    str(payload.subagent_id) ??
    str(payload.agentId) ??
    str(payload.agent_id) ??
    str(payload.id);
  if (!nativeId) return null;
  const label = str(payload.description) ?? str(payload.task) ?? str(payload.name) ?? str(payload.title);
  const model = str(payload.model);
  if (normalized === SUBAGENT_SPAWNED) {
    return { nativeId, status: 'running', ...(label ? { label } : {}), ...(model ? { model } : {}) };
  }
  // Only an explicit failure signal downgrades a finish; Grok reports success
  // by omission, and guessing 'failed' would libel a child that did its job.
  const failed =
    payload.error !== undefined && payload.error !== null
      ? true
      : payload.success === false || payload.status === 'failed' || payload.status === 'error';
  return {
    nativeId,
    status: failed ? 'failed' : 'completed',
    ...(label ? { label } : {}),
    ...(model ? { model } : {}),
  };
}

/**
 * Resolve a Veneer tool name for one ACP tool call.
 *
 * MCP tools reach ACP with a `server__tool` name; every other Veneer provider
 * reports `mcp__server__tool`, and the chat UI keys connector rendering and
 * display names off that form — so normalize, rather than leaking Grok's
 * spelling into transcripts.
 */
export function grokToolIdentity(update: AcpToolUpdate): { toolName: string; displayName: string } {
  const raw = grokMetaToolName(update._meta) ?? str(update.title);
  if (raw?.startsWith('mcp__')) return { toolName: raw, displayName: displayNameForTool(raw) };
  const namespaced = raw ? /^([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$/.exec(raw) : null;
  if (namespaced) {
    const toolName = `mcp__${namespaced[1]}__${namespaced[2]}`;
    return { toolName, displayName: displayNameForTool(toolName) };
  }
  if (toolCommand(update.rawInput, update.kind)) {
    return { toolName: KIND_TOOLS.execute!.name, displayName: KIND_TOOLS.execute!.display };
  }
  if (toolLocations(update.locations).length) {
    return { toolName: KIND_TOOLS.edit!.name, displayName: KIND_TOOLS.edit!.display };
  }
  const kind = KIND_TOOLS[String(update.kind ?? 'other')] ?? KIND_TOOLS.other!;
  return { toolName: kind.name, displayName: kind.display };
}

/** Per-model thinking levels from ACP `initialize`, ordered for the slider. */
function grokEffortOptions(meta: GrokAvailableModel['_meta']): Pick<ModelOption, 'efforts' | 'defaultEffort'> {
  const seen = new Set<string>();
  const efforts: string[] = [];
  for (const entry of meta?.reasoningEfforts ?? []) {
    const id = (entry.value ?? entry.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    efforts.push(id);
  }
  if (!efforts.length) return {};
  efforts.sort((a, b) => {
    const ia = GROK_EFFORT_ORDER.indexOf(a);
    const ib = GROK_EFFORT_ORDER.indexOf(b);
    return (ia === -1 ? GROK_EFFORT_ORDER.length : ia) - (ib === -1 ? GROK_EFFORT_ORDER.length : ib)
      || a.localeCompare(b);
  });
  const current = meta?.reasoningEffort?.trim();
  return current ? { efforts, defaultEffort: current } : { efforts };
}

/** `initialize._meta.modelState` → the new-conversation picker's options. */
export function toModelOptions(result: GrokInitializeResult | null | undefined): ModelOption[] {
  const state = result?._meta?.modelState;
  const defaultId = state?.currentModelId ?? DEFAULT_MODEL_ID;
  return (state?.availableModels ?? [])
    .map((m) => {
      const id = m.modelId ?? '';
      const context = m._meta?.totalContextTokens;
      // ModelOption has no context field, and this adapter owns no UI, so the
      // window rides in the label — it is the difference between grok-4.5's
      // 500K and everything else's 256K, which is the whole reason to pick one.
      const window = typeof context === 'number' && context > 0 ? ` (${Math.round(context / 1000)}K)` : '';
      const option: ModelOption = { id, label: `${m.name ?? id}${window}` };
      if (id === defaultId) option.isDefault = true;
      Object.assign(option, grokEffortOptions(m._meta));
      return option;
    })
    .filter((m) => m.id.length > 0 && !m.id.startsWith(NON_CODING_MODEL_PREFIX));
}

/**
 * Canonical Grok adapter over `grok agent --always-approve --no-leader stdio`,
 * which speaks the Agent Client Protocol (JSON-RPC 2.0 over NDJSON). One
 * long-lived process per access level (spec: LONG_LIVED, not PER_TURN),
 * multiplexed by ACP session id — see protocol.ts. Verified live 2026-08-12
 * against grok 1.0.3.
 *
 * Access-level isolation is enforced three ways, all in the child environment
 * built here: HOME (login vs service), `GROK_SANDBOX` (kernel-enforced
 * filesystem/network profile), and `--no-leader` (never share a backend
 * process). `XAI_API_KEY` is stripped so a turn can only ever spend the
 * subscription this box is logged into.
 */
export function createGrokAdapter(opts: GrokAdapterOptions): ProviderAdapter {
  const inactivityMs = opts.turnInactivityMs ?? opts.turnTimeoutMs;
  const log = opts.log ?? console;
  const cancelCompletionTimeoutMs = opts.cancelCompletionTimeoutMs ?? 5_000;
  fsSync.mkdirSync(opts.transcriptsDir, { recursive: true });

  /**
   * The environment for one Grok agent process.
   *
   * `XAI_API_KEY` is present in the Veneer service environment (other features
   * use it) and the Grok CLI will silently prefer it over the signed-in
   * subscription, billing the API account per token. Deleting it — along with
   * the `GROK_CODE_XAI_API_KEY` alias the CLI also honours — is the only way to
   * guarantee a turn runs on the subscription in `GROK_HOME/auth.json`.
   */
  function grokEnv(fullAccess: boolean): NodeJS.ProcessEnv {
    const env = { ...(opts.buildEnv ?? agentEnv)(fullAccess) };
    delete env.XAI_API_KEY;
    delete env.GROK_CODE_XAI_API_KEY;
    if (!env.GROK_HOME?.trim()) env.GROK_HOME = proGrokHome();
    env.GROK_DISABLE_AUTOUPDATER = '1';
    // Grok's sandbox is a process-lifetime kernel policy (Seatbelt/Landlock)
    // applied to the agent and every command it spawns, and it is OFF by
    // default — so it must be set explicitly on both paths, never left to
    // whatever the ambient environment happens to hold. `workspace` = read
    // anywhere, write only cwd + GROK_HOME + temp; `off` = the unrestricted
    // Full Access equivalent of Codex's danger-full-access. A profile that
    // cannot be applied makes the CLI refuse to start rather than run
    // unprotected, which is the failure mode we want.
    env.GROK_SANDBOX = fullAccess ? 'off' : 'workspace';
    // Turn off Grok's Claude/Cursor compatibility scanners, which are ON by
    // default and would otherwise import the login account's Claude Code hooks,
    // permission rules, MCP servers and instruction files into every turn. The
    // Claude *skills* scanner is deliberately left enabled — Veneer's own skill
    // store is a Claude-visible skills directory. See profile.ts for the
    // measurements and for the second half of this lockdown.
    disableVendorCompatScanners(env);
    return env;
  }

  function grokHomeFor(fullAccess: boolean): string {
    return grokEnv(fullAccess).GROK_HOME ?? proGrokHome();
  }

  const clients = new Map<boolean, AcpClient>();
  function clientFor(fullAccess: boolean): AcpClient {
    let existing = clients.get(fullAccess);
    if (!existing) {
      const env = grokEnv(fullAccess);
      existing = new AcpClient({
        grokBin: opts.grokBin,
        env,
        log,
        // Vendor-config isolation is re-applied on every (re)spawn: the profile
        // directory is on disk and an operator or an upgrade could change it
        // between spawns. See profile.ts for the exposure this closes.
        onBeforeSpawn: () => ensureGrokProfile(env.GROK_HOME ?? proGrokHome(), log),
      });
      clients.set(fullAccess, existing);
    }
    return existing;
  }

  let modelsCache: { at: number; models: ModelOption[] } | null = null;
  async function listModels(): Promise<ModelOption[]> {
    // auth.json's presence IS the UI gate: with no subscription login, Grok's
    // initialize still reports a model list, but every session/new would fail.
    if (!fsSync.existsSync(grokAuthFile(grokHomeFor(false)))) return [];
    if (modelsCache && Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS) return modelsCache.models;
    const initialize = clientFor(false)
      .initialize()
      .then(toModelOptions)
      .catch(() => [] as ModelOption[]);
    const timeout = new Promise<ModelOption[]>((resolve) => {
      const timer = setTimeout(() => resolve([]), INITIALIZE_TIMEOUT_MS);
      timer.unref?.();
    });
    const models = await Promise.race([initialize, timeout]);
    if (models.length) modelsCache = { at: Date.now(), models };
    return models;
  }

  function runTurn(
    spec: TurnSpec,
    onEvent: (e: ConversationEvent) => void,
    onSessionId?: (id: string) => void,
  ): TurnHandle {
    const turnId = spec.turnId;
    const fullAccess = spec.dangerous ?? false;
    const client = clientFor(fullAccess);
    let settled = false;
    let killed = false;
    let killReason: TurnKillReason | null = null;
    let unsubscribe: (() => void) | null = null;
    let resolvedSessionId: string | null = spec.firstTurn ? null : spec.nativeSessionId;
    let promptSent = false;
    let cancelRequested = false;
    let cancelFallbackTimer: NodeJS.Timeout | null = null;
    /**
     * `session/load` REPLAYS the entire session history as `session/update`
     * notifications before its own response resolves. Without this gate every
     * resumed chat would render its whole past a second time.
     */
    let suppressingReplay = false;
    let pendingText = '';
    let thinkingEmitted = false;

    const persistable: ConversationEvent[] = [
      { type: 'turn_started', turnId, role: 'user', text: spec.displayPrompt ?? spec.prompt, at: new Date().toISOString(), via: 'web' },
    ];
    function pushPersist(e: ConversationEvent): void {
      persistable.push(e);
    }
    function emit(e: ConversationEvent): void {
      onEvent(e);
      pushPersist(e);
    }

    // Live created-file capture, flushed to the sidecar in finish() and read
    // back by listCreatedFiles. The shadow transcript persists only bounded
    // previews, so full paths exist only here, while the turn streams.
    const createdFiles = new Map<string, 'write' | 'bash'>();
    const absoluteCandidate = (p: string): string =>
      p.startsWith('~/') ? expandUserPath(p) : path.resolve(spec.cwd, p);
    function recordCommandCandidates(text: string, limit?: number): void {
      for (const candidate of fileCandidates(text, limit)) {
        const abs = absoluteCandidate(candidate);
        if (!createdFiles.has(abs)) createdFiles.set(abs, 'bash');
      }
    }
    /** An `edit` tool call names its output exactly, so watched text types are trusted. */
    function recordEditedLocations(locations: string[]): void {
      for (const location of locations) {
        if (!WRITE_EXTS.has(path.extname(location).toLowerCase())) continue;
        createdFiles.set(absoluteCandidate(location), 'write');
      }
    }

    // Grok runs with --always-approve, so nothing here ever pauses for a human;
    // the holds below are entirely about tool calls that are legitimately slow.
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
    /** Tool calls currently holding the inactivity window open, by ACP tool call id. */
    const heldToolIds = new Set<string>();
    function holdForTool(toolId: string, toolName: string): void {
      if (isPollingToolName(toolName) || heldToolIds.has(toolId)) return;
      heldToolIds.add(toolId);
      watchdog.hold();
    }
    function releaseTool(toolId: string): void {
      if (heldToolIds.delete(toolId)) watchdog.release();
    }

    /** Children seen on this session, by Grok's subagent id. */
    const subagentStatuses = new Map<string, SubagentStatus>();
    const subagentLabels = new Map<string, string>();
    function emitSubagent(
      nativeId: string,
      status: SubagentStatus,
      patch: { label?: string; model?: string } = {},
    ): void {
      const previous = subagentStatuses.get(nativeId);
      if (previous === status && !patch.label && !patch.model) return;
      subagentStatuses.set(nativeId, status);
      const agentKey = subagentEventKey('grok', nativeId);
      const meta = {
        label: subagentLabel(patch.label ?? subagentLabels.get(nativeId)),
        ...(patch.model ? { model: patch.model } : {}),
      };
      if (patch.label) subagentLabels.set(nativeId, patch.label);
      const event: ConversationEvent =
        previous === undefined
          ? { type: 'subagent_started', turnId, agentKey, status, ...meta }
          : { type: 'subagent_updated', turnId, agentKey, status, ...meta };
      // After the parent settles this is a late child completion: still worth
      // showing live, but the shadow transcript for this turn is already written.
      onEvent(event);
      if (!settled) pushPersist(event);
      watchdog.activity();
    }

    /** Returns true when the payload was a subagent lifecycle event. */
    function handleSubagentLifecycle(kind: string, payload: Record<string, unknown>): boolean {
      const parsed = grokSubagentLifecycle(kind, payload);
      if (!parsed) return false;
      emitSubagent(parsed.nativeId, parsed.status, {
        ...(parsed.label ? { label: parsed.label } : {}),
        ...(parsed.model ? { model: parsed.model } : {}),
      });
      return true;
    }

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    /** Emit whatever assistant text has accumulated as one durable message. */
    function flushText(): void {
      const text = pendingText.trim();
      pendingText = '';
      if (!text) return;
      emit({ type: 'text_final', turnId, markdown: text, at: new Date().toISOString() });
    }

    function finish(): void {
      if (settled) return;
      settled = true;
      watchdog.stop();
      heldToolIds.clear();
      if (cancelFallbackTimer) {
        clearTimeout(cancelFallbackTimer);
        cancelFallbackTimer = null;
      }
      keepListeningForLateChildren();
      if (resolvedSessionId) {
        try {
          appendShadowTranscript(opts.transcriptsDir, resolvedSessionId, persistable);
        } catch (err) {
          log.warn(`[grok] shadow transcript write failed: ${(err as Error).message}`);
        }
        try {
          appendShadowFiles(
            opts.transcriptsDir,
            resolvedSessionId,
            [...createdFiles].map(([p, source]) => ({ path: p, source })),
          );
        } catch (err) {
          log.warn(`[grok] created-files sidecar write failed: ${(err as Error).message}`);
        }
      }
      resolveDone();
    }

    /**
     * Grok's background children can finish after their parent turn does, so
     * dropping the subscription at `finish()` is what made those completions
     * invisible. Hold it for a bounded window instead: only subagent lifecycle
     * events are still acted on (see handleServerMessage), and an explicit Stop
     * cancels the children anyway, so there is nothing left to hear.
     */
    function keepListeningForLateChildren(): void {
      const drop = unsubscribe;
      unsubscribe = null;
      if (!drop) return;
      // An explicit Stop cancelled the children too, so there is nothing left
      // to hear; likewise when no child was ever live on this turn.
      if (killReason === 'user' || !hasLiveChildren()) {
        drop();
        return;
      }
      const timer = setTimeout(() => drop(), LATE_SUBAGENT_WINDOW_MS);
      timer.unref?.();
    }

    function hasLiveChildren(): boolean {
      for (const status of subagentStatuses.values()) {
        if (status === 'queued' || status === 'running') return true;
      }
      return false;
    }

    /** Release Stop if Grok never answers the cancelled session/prompt. */
    function finishInterrupted(reason: TurnKillReason = 'user'): void {
      if (settled) return;
      flushText();
      // Stop is the user's own action — a muted notice, not a red error. On a
      // timeout the turn timer already surfaced its own message.
      if (reason !== 'timeout') onEvent({ type: 'notice', message: 'Stopped.' });
      onEvent({ type: 'turn_done', turnId, outcome: reason === 'timeout' ? 'timed_out' : 'interrupted_by_user' });
      finish();
    }

    function armCancelFallback(reason: TurnKillReason): void {
      if (settled || cancelFallbackTimer) return;
      cancelFallbackTimer = setTimeout(() => finishInterrupted(reason), cancelCompletionTimeoutMs);
      cancelFallbackTimer.unref?.();
    }

    /**
     * ACP cancellation is a notification, and the authoritative end of the turn
     * is still the session/prompt response (stopReason 'cancelled') — same
     * contract as Codex's turn/interrupt acknowledgement, same bounded fallback.
     */
    function requestCancel(): void {
      if (!resolvedSessionId || !promptSent || cancelRequested) return;
      cancelRequested = true;
      // Grok defaults a missing `cancelSubagents` to true, which is right only
      // for an explicit user Stop. A "Send now" replaces the parent while its
      // children keep working (Grok's own send-now behaves that way), and a
      // Veneer timeout is our guard firing, not a decision to abandon the
      // delegated work — so both must say so out loud.
      const cancelSubagents = killReason === 'user';
      void client
        .notify('session/cancel', { sessionId: resolvedSessionId, cancelSubagents })
        .catch((err) => log.warn(`[grok] session cancel failed: ${(err as Error).message}`));
    }

    function completeTurn(stopReason: string): void {
      if (settled) return;
      flushText();
      const outcome =
        killReason === 'timeout'
          ? 'timed_out'
          : killReason
            ? 'interrupted_by_user'
            : stopReason === 'cancelled'
              ? 'interrupted_by_user'
              : stopReason === 'refusal'
                ? 'failed'
                : 'completed';
      if (stopReason === 'refusal') {
        emit({ type: 'error', message: 'Grok declined to complete this request.', fatal: false });
      } else if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
        emit({
          type: 'notice',
          message:
            stopReason === 'max_tokens'
              ? 'Grok reached its response length limit for this turn.'
              : 'Grok reached its step limit for this turn.',
        });
      }
      if (outcome === 'interrupted_by_user') onEvent({ type: 'notice', message: 'Stopped.' });
      onEvent({ type: 'turn_done', turnId, outcome });
      finish();
    }

    function handleSessionUpdate(update: Record<string, unknown>): void {
      const kind = String(update.sessionUpdate ?? '');
      // Child lifecycle never reaches here: handleServerMessage reads it off
      // every rail first, including the replay one this function sits behind.
      switch (kind) {
        case 'agent_message_chunk': {
          const text = str((update.content as Record<string, unknown> | undefined)?.text) ?? '';
          if (!text) break;
          watchdog.activity();
          thinkingEmitted = false;
          pendingText += text;
          onEvent({ type: 'text_delta', turnId, text });
          break;
        }
        case 'agent_thought_chunk': {
          watchdog.activity();
          // One marker per contiguous run of reasoning, not one per token.
          if (thinkingEmitted) break;
          thinkingEmitted = true;
          onEvent({ type: 'thinking', turnId });
          break;
        }
        case 'tool_call': {
          const call = update as AcpToolUpdate;
          const toolId = str(call.toolCallId);
          if (!toolId) break;
          // Text written before a tool call is its own message; flushing here
          // keeps the interleaving the user actually saw.
          flushText();
          thinkingEmitted = false;
          const { toolName, displayName } = grokToolIdentity(call);
          // A poll proves nothing; anything else is real work in flight and
          // holds the inactivity window open until it reports back.
          if (!isPollingToolName(toolName)) watchdog.activity();
          holdForTool(toolId, toolName);
          const input = call.rawInput ?? str(call.title) ?? '';
          const connectorDetails = connectorInputDetails(toolName, input);
          const agentMessageDetails = agentMessageInputDetails(toolName, input);
          emit({
            type: 'tool_started',
            turnId,
            toolId,
            toolName,
            displayName,
            inputPreview: previewOf(input),
            ...(connectorDetails ? { connectorDetails } : {}),
            ...(agentMessageDetails ? { agentMessageDetails } : {}),
          });
          const command = toolCommand(call.rawInput, call.kind);
          toolNames.set(toolId, {
            toolName,
            command: Boolean(command),
          });
          if (command) recordCommandCandidates(command);
          if (call.status === 'completed' || call.status === 'failed') finishToolCall(call);
          break;
        }
        case 'tool_call_update': {
          const call = update as AcpToolUpdate;
          if (call.status !== 'completed' && call.status !== 'failed') break;
          finishToolCall(call);
          break;
        }
        // 'plan', 'user_message_chunk', 'available_commands_update' and future
        // update kinds carry nothing the normalized event model represents.
        default:
          break;
      }
    }

    const toolNames = new Map<string, { toolName: string; command: boolean }>();

    function finishToolCall(call: AcpToolUpdate): void {
      const toolId = str(call.toolCallId);
      if (!toolId) return;
      const known = toolNames.get(toolId);
      const toolName = known?.toolName ?? grokToolIdentity(call).toolName;
      const command = known?.command ?? Boolean(toolCommand(call.rawInput, call.kind));
      const ok = call.status !== 'failed';
      releaseTool(toolId);
      if (!isPollingToolName(toolName)) watchdog.activity();
      const resultText = toolContentText(call.content) || previewOf(call.rawOutput ?? '');
      if (ok) {
        const locations = toolLocations(call.locations);
        // locations are exact output paths even when Grok loses the ACP kind.
        if (locations.length) recordEditedLocations(locations);
        // A successful command is a producer signal: harvest watched paths from
        // its full output, which is where a dynamically-named file shows up.
        if (command && resultText) {
          recordCommandCandidates(boundedResultText(resultText), MAX_BASH_RESULT_FILES);
        }
      }
      toolNames.delete(toolId);
      const connectorDetails = connectorResultDetails(toolName, call.rawOutput ?? resultText);
      emit({
        type: 'tool_finished',
        turnId,
        toolId,
        ok,
        resultPreview: previewOf(resultText),
        ...(connectorDetails ? { connectorDetails } : {}),
      });
    }

    function handleServerMessage(msg: JsonRpcMessage): void {
      const method = msg.method;
      const params = (msg.params ?? {}) as Record<string, unknown>;

      // Grok publishes child lifecycle on a vendor-prefixed notification as
      // well as inside session/update. Both were being dropped: the first by
      // the "carries nothing we model" fall-through below, the second by the
      // replay gate. Read it before either gate can swallow it.
      if (method && msg.id === undefined && method !== 'session/update') {
        if (handleSubagentLifecycle(method, params)) return;
      }
      if (method === 'session/update') {
        const update = params.update;
        if (update && typeof update === 'object') {
          const inner = update as Record<string, unknown>;
          if (handleSubagentLifecycle(String(inner.sessionUpdate ?? ''), inner)) return;
        }
      }

      if (settled) {
        // Past the turn boundary only late child completions (handled above)
        // still matter; everything else belongs to a turn nobody is watching.
        if (msg.id !== undefined) client.respondError(msg.id, -32000, 'Turn is already complete');
        return;
      }

      if (method === DISCONNECTED_METHOD) {
        if (killed && killReason) {
          finishInterrupted(killReason);
          return;
        }
        flushText();
        onEvent({ type: 'error', message: 'Grok disconnected unexpectedly.', fatal: false });
        onEvent({ type: 'turn_done', turnId, outcome: 'failed' });
        finish();
        return;
      }

      if (method === 'session/update') {
        // Everything session/load replays is already in the shadow transcript.
        if (suppressingReplay) return;
        const update = params.update;
        if (update && typeof update === 'object') handleSessionUpdate(update as Record<string, unknown>);
        return;
      }

      if (msg.id === undefined) return; // any other notification carries nothing we model

      if (method === 'session/request_permission') {
        // Both access levels spawn with --always-approve, so this should never
        // fire. If a future build asks anyway, answer 'cancelled': it is the
        // fail-closed reply that still releases the agent instead of hanging.
        log.warn('[grok] unexpected permission request while running with --always-approve');
        client.respond(msg.id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      // Protocol drift must fail closed. A successful empty response can
      // accidentally acknowledge a capability we do not implement (we declared
      // no filesystem or terminal capabilities); an explicit
      // method-not-supported error lets Grok recover visibly.
      client.respondError(msg.id, -32601, `Unsupported agent request: ${method ?? 'unknown'}`);
      log.warn(`[grok] rejected unsupported agent request: ${method ?? 'unknown'}`);
    }

    async function start(): Promise<void> {
      try {
        // Inject every materialized MCP server (built-in agents server + the
        // user's connectors + toolbox servers) on BOTH session/new and
        // session/load — the per-turn agent token rides in those headers/env,
        // and a connector installed mid-conversation must appear immediately.
        const mcpServers = grokMcpServers(spec.mcpConfigPath);
        let sessionId: string;
        if (spec.firstTurn) {
          const res = (await client.request('session/new', { cwd: spec.cwd, mcpServers })) as {
            sessionId?: string;
          };
          sessionId = res?.sessionId ?? '';
          if (!sessionId) throw new Error('session/new did not return a session id');
          resolvedSessionId = sessionId;
          onSessionId?.(sessionId);
          unsubscribe = client.subscribe(sessionId, handleServerMessage);
        } else {
          sessionId = spec.nativeSessionId;
          resolvedSessionId = sessionId;
          suppressingReplay = true;
          // Subscribe first: the replay starts before session/load resolves, and
          // dropping it here is what the suppression gate is for.
          unsubscribe = client.subscribe(sessionId, handleServerMessage);
          try {
            await client.request('session/load', { sessionId, cwd: spec.cwd, mcpServers });
          } finally {
            suppressingReplay = false;
          }
        }
        // A Stop/timeout that landed while session/new|load was in flight has
        // already armed the fallback (or settled) — bail before running a turn.
        if (killed || settled) return;

        // set_model requires modelId. Effort rides in _meta.reasoningEffort
        // (camelCase only). Omitting that field resets the session to Grok's
        // default (high), so a picked level must be sent every turn.
        const requestedModel = spec.model?.trim() || null;
        const requestedEffort = spec.effort?.trim() || null;
        if (requestedModel || requestedEffort) {
          const modelId = requestedModel ?? (await readShadowModel(opts.transcriptsDir, sessionId));
          if (modelId) {
            try {
              await client.request('session/set_model', {
                sessionId,
                modelId,
                ...(requestedEffort ? { _meta: { reasoningEffort: requestedEffort } } : {}),
              });
              writeShadowModel(opts.transcriptsDir, sessionId, modelId);
            } catch (err) {
              // Never fail a turn over the picker: the session keeps the agent's
              // default model, and readModel keeps reporting whatever last stuck.
              log.warn(`[grok] could not select model ${modelId}: ${(err as Error).message}`);
            }
          }
          if (killed || settled) return;
        }

        promptSent = true;
        if (killed) {
          // Stop landed during set_model; cancel the prompt we are about to send
          // as soon as it exists.
          requestCancel();
        }
        const res = (await client.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: wirePrompt(spec) }],
        })) as { stopReason?: string };
        completeTurn(String(res?.stopReason ?? 'end_turn'));
      } catch (err) {
        if (settled) return;
        if (killed && killReason) {
          armCancelFallback(killReason);
          return;
        }
        flushText();
        const message = (err as Error).message;
        onEvent({
          type: 'error',
          message: isAuthenticationError(err) ? NOT_CONNECTED_MESSAGE : `Could not start the assistant: ${message}`,
          fatal: true,
        });
        onEvent({ type: 'turn_done', turnId, outcome: 'failed' });
        finish();
      }
    }
    void start();

    function kill(reason: TurnKillReason = 'user'): void {
      if (killed) return;
      killed = true;
      killReason = reason;
      if (resolvedSessionId) {
        // If session/prompt is still in flight, its 'cancelled' response is the
        // real boundary; either way Stop has one bounded deadline.
        armCancelFallback(reason);
        requestCancel();
      } else {
        // No session id yet (Stop during session/new): there is nothing to
        // cancel. The in-flight start() sees `killed` at its next await
        // boundary and bails; settle now so `done` cannot hang forever.
        finishInterrupted(reason);
      }
    }

    /**
     * ACP has no developer-instructions parameter, so Veneer's core rules and
     * the chat's fixed context ride in the prompt itself. Only on the turns
     * where they are new — the first turn, or when the durable context changed
     * — so a long chat does not repeat them every turn.
     */
    function wirePrompt(turn: TurnSpec): string {
      const instructions = turn.developerInstructions?.trim();
      if (!instructions || !(turn.firstTurn || turn.refreshDeveloperInstructions)) return turn.prompt;
      return `${instructions}\n\n---\n\n${turn.prompt}`;
    }

    /** Grok runs with --always-approve; nothing ever reaches Veneer's approval seam. */
    function respondToApproval(_requestId: string, _decision: ApprovalDecision): boolean {
      return false;
    }

    return { done, kill, respondToApproval };
  }

  return {
    id: 'grok',
    // Placeholder until session/new resolves the real ACP session id (see
    // onSessionId) — same pattern as Codex; conversationManager overwrites it.
    mintSessionId: () => crypto.randomUUID(),
    runTurn,
    readTranscript: (conv) => readGrokTranscript(opts.transcriptsDir, conv.nativeSessionId),
    readModel: (conv) => readShadowModel(opts.transcriptsDir, conv.nativeSessionId),
    listModels,
    listCreatedFiles: async (conv) => {
      const homes = opts.legacyOutboxHomes ?? Object.values(currentHomes());
      const [shadow, legacy] = await Promise.all([
        readShadowFiles(opts.transcriptsDir, conv.nativeSessionId),
        readLegacyOutboxFiles(conv.nativeSessionId, homes),
      ]);
      const bySource = new Map(shadow.map((ref) => [ref.path, ref.source]));
      for (const ref of legacy) if (!bySource.has(ref.path)) bySource.set(ref.path, ref.source);
      return [...bySource].map(([filePath, source]) => ({ path: filePath, source }));
    },
  };
}
