import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';
import type { ConversationEvent, SubagentProgress, SubagentStatus } from '../../runtime/events.js';
import { displayNameForTool, previewOf } from '../../runtime/events.js';
import { changedLineCounts, safeTerminalAction, safeToolAction, type SafeCommandKind } from '../../runtime/subagentProgress.js';
import { saveToolResultImages } from '../../runtime/media.js';
import { connectorInputDetails, connectorResultDetails } from '../../runtime/connectorToolDetails.js';
import { agentMessageInputDetails } from '../../runtime/agentMessageToolDetails.js';
import type {
  ApprovalDecision,
  CompactSessionHandle,
  CompactSessionSpec,
  ModelOption,
  ProviderAdapter,
  ProviderId,
  SteerDelivery,
  TurnHandle,
  TurnKillReason,
  TurnSpec,
} from '../types.js';
import { createTurnWatchdog, isPollingToolName, turnTimeoutMessage } from '../turnWatchdog.js';
import { controlResponseLine, parseWireLine, type RateLimitInfo } from './wire.js';
import { claudeNativeTranscriptPath, readClaudeAiTitle, readClaudeModel, readClaudeTranscript } from './transcript.js';
import { displayClaudeRateLimitMessage, isClaudeSessionLimitMessage } from './rateLimitMessage.js';
import type { ClaudeSessionLimitEvent } from './accountFailover.js';
import { collectClaudeSessionFiles } from './sessionFiles.js';
import {
  CLAUDE_SUBAGENT_TOOL,
  claudeAgentLaunchStatus,
  claudeSubagentKey,
  claudeSubagentStarted,
  parseClaudeTaskNotification,
} from './subagents.js';
import { agentEnv } from '../../homes.js';
import { forwardNetSuiteDiagnosticChunk } from '../../connectors/netsuite/diagnostics.js';

const KILL_GRACE_MS = 5_000;
const MODELS_CACHE_TTL_MS = 5 * 60_000;
const INERT_PRINT_MODE_TOOLS = [
  'ScheduleWakeup',
  'CronCreate',
  'CronList',
  'CronDelete',
  'Monitor',
].join(',');
/**
 * The "Latest models comparison" table at
 * https://platform.claude.com/docs/en/about-claude/models/overview — one
 * model per family plus the previous Opus release, not the full catalog
 * `GET /v1/models` returns (which also lists legacy/deprecated snapshots like
 * Fable 5, Opus 4.7/4.6, Sonnet 4.6/4.5, Opus 4.5/4.1). Excludes Claude
 * Mythos 5 (Project Glasswing-gated, not generally available). Update this
 * set when Anthropic ships a new generation — see shared/models.md in the
 * claude-api skill.
 */
const LATEST_CLAUDE_MODEL_IDS = new Set([
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
]);

/**
 * The half of the foreground-subagent trade Claude agents have to know about.
 *
 * CLAUDE_CODE_DISABLE_BACKGROUND_TASKS also removes `run_in_background` Bash,
 * so the "start a dev server, then curl it" pattern would otherwise block on
 * the Bash timeout. Detaching with the shell does still work — the flag turns
 * off the harness feature, not Unix.
 */
export const CLAUDE_BACKGROUND_TASK_RULE =
  '- Background Bash tasks are disabled in this runtime. Start a dev server or any other long-running process detached (for example `nohup <command> > /tmp/<name>.log 2>&1 & disown`) and poll its log or port, rather than running it in the foreground.';

export interface ClaudeAdapterOptions {
  /** Provider identity. OpenRouter deliberately reuses this Claude Code harness. */
  id?: Extract<ProviderId, 'claude' | 'openrouter'>;
  claudeBin: string;
  /** Absolute per-turn ceiling. The inactivity window below is the real guard. */
  turnTimeoutMs: number;
  /**
   * Idle time with no provider progress before the turn is reaped. Omitting it
   * leaves the absolute ceiling as the only guard, which is the pre-watchdog
   * behaviour.
   */
  turnInactivityMs?: number;
  /** Alternate Claude Code profile root (credentials, settings, and transcripts). */
  configDir?: string;
  /** Provider-specific environment construction and credential status. */
  prepareSpawnEnv?: (
    spec: Pick<TurnSpec, 'dangerous' | 'model'>,
  ) => { env: NodeJS.ProcessEnv; hasCredential: boolean };
  /** Base agent environment, optionally extended with approved runtime credentials. */
  buildEnv?: (fullAccess: boolean) => NodeJS.ProcessEnv;
  /** Provider-specific model catalog. The adapter supplies caching. */
  loadModels?: () => Promise<ModelOption[]>;
  /** Invalidate the model cache when a settings-backed allowlist changes. */
  modelsCacheKey?: () => string;
  missingCredentialMessage?: string;
  /**
   * In-app Claude token (secrets.json), or null. Precedence: this over the
   * legacy CLAUDE_CODE_OAUTH_TOKEN env var so an in-app connect/logout wins
   * without touching the env file. Read per-turn so logout takes effect live.
   */
  getOauthToken?: () => string | null;
  /**
   * Passive subscription-usage capture: every `rate_limit_event` the CLI emits
   * on the stream is forwarded here (source 'stream'). The usage store keeps the
   * newest snapshot per rateLimitType. Optional so tests/other callers can skip it.
   */
  onRateLimit?: (info: RateLimitInfo, accountId: string | null) => void;
  /** Id of the account `getOauthToken` currently resolves to; read once per spawn. */
  getAccountId?: () => string | null;
  /**
   * The turn ended because the subscription hit its session limit (a 429
   * `rate_limit` assistant message followed by a failed result). Drives
   * automatic account failover; see providers/claude/accountFailover.ts.
   */
  onSessionLimit?: (event: ClaudeSessionLimitEvent) => void;
  log?: Pick<Console, 'warn' | 'error'>;
}

/**
 * PER_TURN strategy (spec §7.1 fallback, chosen for the prototype): each user
 * message spawns one `claude -p` process that exits at turn end. Verified on
 * Claude Code 2.1.200 — message as one stdin NDJSON line (`--input-format
 * stream-json`), `--session-id` on the first turn, `--resume` afterwards.
 * stdin stays OPEN through the turn so approval control_responses can be
 * written; closed after `result`. See docs/protocol-notes.md.
 */
export function createClaudeAdapter(opts: ClaudeAdapterOptions): ProviderAdapter {
  const inactivityMs = opts.turnInactivityMs ?? opts.turnTimeoutMs;
  const log = opts.log ?? console;

  const nativeCompactionFailure = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text) return null;
    // Claude Code can report insufficient history as a synthetic assistant
    // message while still emitting compact_boundary and a nominally successful
    // result. Treat every observed wording as not-ready, never as compaction.
    if (
      /^Error:/i.test(text)
      || /^(?:No|Not enough) (?:messages|(?:chat )?history) to compact\.?$/i.test(text)
    ) {
      return text;
    }
    return null;
  };

  function spawnEnvironment(spec: Pick<TurnSpec, 'dangerous' | 'model'>): {
    env: NodeJS.ProcessEnv;
    hasCredential: boolean;
  } {
    const appToken = opts.getOauthToken?.() ?? null;
    // Alternate Claude Code-backed providers supply a fully sanitized profile
    // environment. The normal Claude path overlays its in-app OAuth token.
    const prepared = opts.prepareSpawnEnv?.(spec);
    const env: NodeJS.ProcessEnv = prepared?.env ?? (opts.buildEnv ?? agentEnv)(spec.dangerous ?? false);
    if (!prepared && appToken) env.CLAUDE_CODE_OAUTH_TOKEN = appToken;
    return {
      env,
      hasCredential: prepared?.hasCredential ?? Boolean(appToken || process.env.CLAUDE_CODE_OAUTH_TOKEN),
    };
  }

  let modelsCache: { at: number; models: ModelOption[]; key?: string } | null = null;
  /**
   * Anthropic's public Models API (`GET /v1/models`) — authenticated with the
   * same `sk-ant-oat01-…` OAuth token this app already mints via `claude
   * setup-token` and hands the CLI as CLAUDE_CODE_OAUTH_TOKEN. OAuth tokens go
   * on `Authorization: Bearer`, not `x-api-key`, plus the `oauth-2025-04-20`
   * beta header — see docs/protocol-notes.md "Connecting a Claude subscription
   * in-app". Returns [] (free-text fallback in the UI) if no token is
   * connected yet or the call fails for any reason.
   */
  async function listModels(): Promise<ModelOption[]> {
    const cacheKey = opts.modelsCacheKey?.();
    if (
      modelsCache &&
      modelsCache.key === cacheKey &&
      Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS
    ) return modelsCache.models;
    if (opts.loadModels) {
      try {
        const models = await opts.loadModels();
        modelsCache = { at: Date.now(), models, key: cacheKey };
        return models;
      } catch {
        return modelsCache?.models ?? [];
      }
    }
    const token = opts.getOauthToken?.() ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) return [];
    try {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
        },
      });
      if (!res.ok) return modelsCache?.models ?? [];
      const body = (await res.json()) as { data?: { id: string; display_name?: string }[] };
      const models = (body.data ?? [])
        .filter((m) => LATEST_CLAUDE_MODEL_IDS.has(m.id))
        .map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
      modelsCache = { at: Date.now(), models, key: cacheKey };
      return models;
    } catch {
      return modelsCache?.models ?? [];
    }
  }

  function argsFor(spec: TurnSpec): string[] {
    const args = ['-p'];
    if (spec.firstTurn) args.push('--session-id', spec.nativeSessionId);
    else args.push('--resume', spec.nativeSessionId);
    args.push(
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--replay-user-messages',
    );
    // Claude accepts this provider-level block on both create and resume. That
    // makes the core rules effective on the first post-upgrade resumed turn,
    // while the agent/project portion remains the chat's fixed DB snapshot.
    // The background-task rule always rides along: it explains the runtime the
    // spawn environment below actually creates, so it cannot be conditional on
    // a caller having supplied chat instructions.
    args.push(
      '--append-system-prompt',
      [spec.developerInstructions?.trim(), CLAUDE_BACKGROUND_TASK_RULE].filter(Boolean).join('\n'),
    );
    args.push('--verbose', '--include-partial-messages');
    // These native tools require an interactive Claude Code runtime. In -p
    // they can report success and end the turn even though nothing can wake it.
    // Veneer's durable agents MCP tools replace them for Claude and OpenRouter.
    args.push('--disallowedTools', INERT_PRINT_MODE_TOOLS);
    if (spec.dangerous) {
      // Full Access: no approval round trip. Skips permissions entirely — no
      // --permission-prompt-tool/--permission-mode (they'd conflict).
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-prompt-tool', 'stdio');
      args.push('--permission-mode', 'acceptEdits');
    }
    // Toolbox materialization (spec §11.3): MCP servers + the allow/deny
    // pre-allowlist come from per-spawn files; everything not pre-allowed falls
    // through to the control_request approval path. --strict-mcp-config isolates
    // the spawn from the running user's ~/.claude MCP servers.
    if (spec.mcpConfigPath) args.push('--mcp-config', spec.mcpConfigPath, '--strict-mcp-config');
    // Full Access settings files contain preferences only; permission keys are
    // omitted by the materializer, so passing the file cannot narrow or expand
    // the bypass-permissions behavior.
    if (spec.settingsPath) args.push('--settings', spec.settingsPath);
    if (spec.model) args.push('--model', spec.model);
    if (spec.effort) args.push('--effort', spec.effort);
    return args;
  }

  // onSessionId unused: Claude's session id is minted up front and never
  // changes mid-conversation, unlike Codex which discovers its own.
  function runTurn(spec: TurnSpec, onEvent: (e: ConversationEvent) => void): TurnHandle {
    const turnId = spec.turnId;
    // The normal Claude provider takes the agent environment (Full Access runs
    // under the login account's HOME; Pro's Claude profile stays pinned by
    // CLAUDE_CONFIG_DIR either way) and overlays the in-app token. Alternate
    // Claude Code-backed providers construct their own sanitized environment so
    // credentials cannot bleed between profiles.
    const prepared = spawnEnvironment(spec);
    const env = prepared.env;
    // The agents `ask_user` tool blocks while the user answers; the CLI enforces
    // a hard per-call MCP tool timeout (progress notifications don't extend it),
    // so raise the ceiling past the server-side question window (10 min).
    // Operator-set values still win.
    if (!env.MCP_TOOL_TIMEOUT) env.MCP_TOOL_TIMEOUT = '960000';
    // Run every delegated agent in the foreground. In -p mode a backgrounded
    // subagent is worse than slow: the parent sends its final reply without
    // waiting, so even a child that finishes in time reports into a void, and
    // one that overruns Claude's background grace is killed outright. The
    // documented cost is that `run_in_background` Bash goes away too — the
    // Claude-only instruction in argsFor() tells agents to detach long
    // processes themselves instead.
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
    const hasToken = prepared.hasCredential;
    const child = spawn(opts.claudeBin, argsFor(spec), {
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let settled = false;
    let sawResult = false;
    // Which subscription this turn is spending. Captured at spawn: the active
    // account is one global setting, so it can move while the turn runs.
    const spawnAccountId = opts.getAccountId?.() ?? null;
    /** Text of a 429 `rate_limit` message seen this turn; drives failover at turn end. */
    let sessionLimitText: string | null = null;
    // OpenRouter can stream the complete text without following it with the
    // usual assistant envelope. Keep the uncommitted stream so result/tool
    // boundaries can still produce the text_final the UI requires.
    let pendingStreamText = '';
    let stderrTail = '';
    let diagnosticBuffer = '';
    // Context occupancy of the most recent main-thread API call (input +
    // cache read/creation). The result message's usage can't provide this —
    // it aggregates every call in the turn.
    let lastContextTokens: number | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    // Why the child was deliberately terminated, if it was. Lets the close
    // handler tell an intentional stop (user hit Stop / steered, or the turn
    // timer fired) apart from a genuine crash, so we don't cry "stopped
    // unexpectedly" over something the user did on purpose.
    let killReason: 'user' | 'timeout' | null = null;
    /** Pending can_use_tool requests: requestId → original tool input (echoed back on allow). */
    const pendingApprovals = new Map<string, unknown>();
    /** Agent tool ids stay private here; normalized events carry only hashed keys. */
    const subagentToolIds = new Set<string>();
    type ClaudeSubagentRecord = SubagentProgress & {
      status: SubagentStatus;
      label?: string;
      model?: string;
    };
    const subagentRecords = new Map<string, ClaudeSubagentRecord>();
    interface ClaudeChildProgress {
      seenToolIds: Set<string>;
      files: Set<string>;
      childToolKinds: Map<string, SafeCommandKind | undefined>;
      actionCount: number;
      linesAdded: number;
      linesRemoved: number;
    }
    const childProgressByAgent = new Map<string, ClaudeChildProgress>();
    const toolNamesById = new Map<string, string>();
    function updateSubagent(
      toolUseId: string,
      status: SubagentStatus,
      patch: Partial<SubagentProgress> & { label?: string; model?: string } = {},
    ): void {
      const previous = subagentRecords.get(toolUseId);
      const startedAt = patch.startedAt ?? previous?.startedAt;
      const terminal = status === 'completed' || status === 'stopped' || status === 'failed';
      const next: ClaudeSubagentRecord = {
        ...previous,
        ...patch,
        status,
        ...(terminal && patch.currentAction === undefined ? { currentAction: safeTerminalAction(status) } : {}),
        ...(terminal && patch.durationMs === undefined && previous?.durationMs === undefined && startedAt
          ? { durationMs: Math.max(0, Date.now() - Date.parse(startedAt)) }
          : {}),
      };
      if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
      subagentRecords.set(toolUseId, next);
      onEvent({
        type: 'subagent_updated',
        turnId,
        agentKey: claudeSubagentKey(toolUseId),
        status,
        ...(next.label ? { label: next.label } : {}),
        ...(next.model ? { model: next.model } : {}),
        ...(next.startedAt ? { startedAt: next.startedAt } : {}),
        ...(typeof next.durationMs === 'number' ? { durationMs: next.durationMs } : {}),
        ...(next.currentAction ? { currentAction: next.currentAction } : {}),
        ...(typeof next.actionCount === 'number' ? { actionCount: next.actionCount } : {}),
        ...(typeof next.filesChanged === 'number' ? { filesChanged: next.filesChanged } : {}),
        ...(typeof next.linesAdded === 'number' ? { linesAdded: next.linesAdded } : {}),
        ...(typeof next.linesRemoved === 'number' ? { linesRemoved: next.linesRemoved } : {}),
        ...(typeof next.resultLabel === 'string' ? { resultLabel: next.resultLabel } : {}),
      });
    }
    function rememberSubagentStart(
      toolUseId: string,
      event: Extract<ConversationEvent, { type: 'subagent_started' }>,
    ): void {
      subagentRecords.set(toolUseId, {
        status: event.status,
        label: event.label,
        ...(event.model ? { model: event.model } : {}),
        ...(event.startedAt ? { startedAt: event.startedAt } : {}),
        ...(event.currentAction ? { currentAction: event.currentAction } : {}),
      });
    }
    function childProgress(toolUseId: string): ClaudeChildProgress {
      let progress = childProgressByAgent.get(toolUseId);
      if (!progress) {
        progress = {
          seenToolIds: new Set(),
          files: new Set(),
          childToolKinds: new Map(),
          actionCount: 0,
          linesAdded: 0,
          linesRemoved: 0,
        };
        childProgressByAgent.set(toolUseId, progress);
      }
      return progress;
    }
    function childFilePath(input: unknown): string | null {
      if (!input || typeof input !== 'object') return null;
      const value = (input as Record<string, unknown>).file_path
        ?? (input as Record<string, unknown>).notebook_path
        ?? (input as Record<string, unknown>).path;
      return typeof value === 'string' && value ? value : null;
    }
    function emitClaudeChildTool(parentToolUseId: string, block: { id?: string; name?: string; input?: unknown }): void {
      if (!block.id) return;
      const progress = childProgress(parentToolUseId);
      if (progress.seenToolIds.has(block.id)) return;
      progress.seenToolIds.add(block.id);
      progress.actionCount += 1;
      const safe = safeToolAction(block.name, block.input);
      progress.childToolKinds.set(block.id, safe.commandKind);
      const editTool = block.name === 'Edit'
        || block.name === 'Write'
        || block.name === 'MultiEdit'
        || block.name === 'NotebookEdit';
      const filePath = editTool ? childFilePath(block.input) : null;
      if (filePath) progress.files.add(filePath);
      const input = block.input && typeof block.input === 'object'
        ? block.input as Record<string, unknown>
        : {};
      const edits = Array.isArray(input.edits) ? input.edits : [input];
      for (const edit of edits) {
        if (!edit || typeof edit !== 'object') continue;
        const counts = changedLineCounts(
          (edit as Record<string, unknown>).old_string,
          (edit as Record<string, unknown>).new_string,
        );
        progress.linesAdded += counts.added;
        progress.linesRemoved += counts.removed;
      }
      updateSubagent(parentToolUseId, 'running', {
        currentAction: safe.action,
        actionCount: progress.actionCount,
        filesChanged: progress.files.size,
        linesAdded: progress.linesAdded,
        linesRemoved: progress.linesRemoved,
        resultLabel: '',
      });
    }
    function emitClaudeChildResult(parentToolUseId: string, block: { tool_use_id?: string; is_error?: boolean }): void {
      if (!block.tool_use_id) return;
      const progress = childProgress(parentToolUseId);
      const commandKind = progress.childToolKinds.get(block.tool_use_id);
      const resultLabel = commandKind === 'test'
        ? block.is_error ? 'Tests failed' : 'Tests passed'
        : block.is_error ? 'Action failed' : '';
      if (resultLabel) updateSubagent(parentToolUseId, 'running', { resultLabel });
    }
    function settleActiveSubagents(status: 'stopped' | 'failed'): void {
      for (const [toolUseId, current] of subagentRecords) {
        if (current.status === 'running') updateSubagent(toolUseId, status);
      }
    }
    /**
     * Inputs awaiting the CLI's --replay-user-messages acknowledgement. The
     * initial prompt has no resolver but occupies the first slot so an
     * identical steer cannot accidentally match its replay.
     */
    const pendingInputs: { text: string; resolve: ((accepted: boolean) => void) | null }[] = [
      { text: spec.prompt, resolve: null },
    ];

    // The inactivity window is suspended while a human owns the clock (a
    // pending approval — the manager auto-denies on its own timeout) and while
    // a real tool call is still running, so a 40-minute build is not mistaken
    // for a hang. Poll-style calls deliberately hold nothing open.
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
    /** Tool calls currently holding the inactivity window open, by tool_use id. */
    const heldToolIds = new Set<string>();
    function holdForTool(toolId: string, toolName: string): void {
      if (isPollingToolName(toolName) || heldToolIds.has(toolId)) return;
      heldToolIds.add(toolId);
      watchdog.hold();
    }
    function releaseTool(toolId: string): void {
      if (!heldToolIds.delete(toolId)) return;
      watchdog.release();
    }
    /** True once we know this tool_use id belongs to a poll-style call. */
    function isPollingToolId(toolUseId: string): boolean {
      const name = toolNamesById.get(toolUseId);
      return name !== undefined && isPollingToolName(name);
    }

    // Claude Code has no way to cancel a delegated agent independently of the
    // process, so "Send now" and an explicit Stop are the same action here.
    function kill(reason: TurnKillReason = 'user'): void {
      if (child.exitCode !== null || child.killed) return;
      killReason = reason === 'timeout' ? 'timeout' : 'user';
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
    }

    function writeLine(line: string): boolean {
      if (child.exitCode !== null || !child.stdin.writable) return false;
      try {
        child.stdin.write(line + '\n');
        return true;
      } catch {
        return false;
      }
    }

    const done = new Promise<void>((resolve) => {
      const finish = (): void => {
        if (settled) return;
        settled = true;
        watchdog.stop();
        heldToolIds.clear();
        if (killTimer) clearTimeout(killTimer);
        pendingApprovals.clear();
        for (const pending of pendingInputs.splice(0)) pending.resolve?.(false);
        resolve();
      };

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const wire = parseWireLine(line);
        if (!wire) return;
        try {
          handleWire(wire);
        } catch (err) {
          log.warn(`[${opts.id ?? 'claude'}] event mapping failed: ${(err as Error).message}`);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderrTail = (stderrTail + text).slice(-4000);
        diagnosticBuffer = forwardNetSuiteDiagnosticChunk(diagnosticBuffer, text, log);
      });

      child.on('error', (err) => {
        settleActiveSubagents('failed');
        onEvent({ type: 'error', message: `Could not start the assistant: ${err.message}`, fatal: true });
        onEvent({ type: 'turn_done', turnId, outcome: 'failed' });
        finish();
      });

      child.on('close', (code) => {
        if (settled) return; // error handler already settled — no second bubble/turn_done
        if (!sawResult) {
          settleActiveSubagents(killReason || code === 0 ? 'stopped' : 'failed');
          let outcome: 'completed' | 'interrupted_by_user' | 'timed_out' | 'failed' = 'completed';
          if (killReason === 'user') {
            // The user hit Stop or steered with a new message — not a failure.
            onEvent({ type: 'notice', message: 'Stopped.' });
            outcome = 'interrupted_by_user';
          } else if (killReason === 'timeout') {
            // The turn timer already surfaced its own message; stay quiet here.
            outcome = 'timed_out';
          } else if (code !== 0 && code !== null) {
            outcome = 'failed';
            if (!hasToken) {
              // No in-app token and no env fallback: the box has no Claude
              // subscription connected. Give a clear, actionable message
              // instead of a raw CLI auth error.
              onEvent({
                type: 'error',
                message:
                  opts.missingCredentialMessage ??
                  "Claude isn't connected — ask your administrator to connect a Claude account in Settings.",
                fatal: false,
              });
            } else {
              const detail = stderrTail.trim().split('\n').pop() ?? '';
              onEvent({
                type: 'error',
                message: `The assistant stopped unexpectedly (exit ${code}).${detail ? ` ${previewOf(detail)}` : ''}`,
                fatal: false,
              });
            }
          }
          onEvent({ type: 'turn_done', turnId, outcome });
        }
        finish();
      });

      function handleWire(wire: NonNullable<ReturnType<typeof parseWireLine>>): void {
        switch (wire.kind) {
          case 'init':
            break; // session_id confirmed; nothing user-visible.
          case 'stream_event': {
            // Sub-agent chatter is not rendered, but it still proves the turn
            // is alive — count it before dropping it.
            watchdog.activity();
            if (wire.msg.parent_tool_use_id) break; // sub-agent chatter
            const ev = wire.msg.event;
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
              pendingStreamText += ev.delta.text;
              onEvent({ type: 'text_delta', turnId, text: ev.delta.text });
            } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
              // Thinking deltas are not streamed verbatim; a single marker suffices.
            } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
              onEvent({ type: 'thinking', turnId });
            }
            break;
          }
          case 'assistant': {
            // A message whose only content is another poll is not progress —
            // that is precisely the loop the watchdog is here to break.
            if (
              wire.msg.parent_tool_use_id
              || wire.msg.message.content.some(
                (block) =>
                  (block.type === 'text' && block.text)
                  || (block.type === 'tool_use' && !isPollingToolName(block.name ?? '')),
              )
            ) {
              watchdog.activity();
            }
            if (wire.msg.parent_tool_use_id) {
              for (const block of wire.msg.message.content) {
                if (block.type === 'tool_use') emitClaudeChildTool(wire.msg.parent_tool_use_id, block);
              }
              break;
            }
            const mu = wire.msg.message.usage;
            if (mu) {
              lastContextTokens =
                (mu.input_tokens ?? 0) + (mu.cache_read_input_tokens ?? 0) + (mu.cache_creation_input_tokens ?? 0);
            }
            const textParts: string[] = [];
            const hasToolUse = wire.msg.message.content.some((block) => block.type === 'tool_use');
            const hasText = wire.msg.message.content.some((block) => block.type === 'text' && block.text);
            if (hasToolUse && !hasText && pendingStreamText) {
              onEvent({
                type: 'text_final',
                turnId,
                markdown: pendingStreamText,
                at: new Date().toISOString(),
              });
              pendingStreamText = '';
            }
            for (const block of wire.msg.message.content) {
              if (block.type === 'text' && block.text) textParts.push(block.text);
              else if (block.type === 'tool_use' && block.id) {
                const toolName = block.name ?? 'tool';
                if (toolName === CLAUDE_SUBAGENT_TOOL) {
                  subagentToolIds.add(block.id);
                  // Foreground subagents run inside this tool call: the parent
                  // is legitimately blocked until the child reports back.
                  holdForTool(block.id, toolName);
                  const started = claudeSubagentStarted(
                    turnId,
                    block.id,
                    block.input,
                    new Date().toISOString(),
                  );
                  rememberSubagentStart(block.id, started);
                  onEvent(started);
                  continue;
                }
                toolNamesById.set(block.id, toolName);
                holdForTool(block.id, toolName);
                const connectorDetails = connectorInputDetails(toolName, block.input ?? {});
                const agentMessageDetails = agentMessageInputDetails(toolName, block.input ?? {});
                onEvent({
                  type: 'tool_started',
                  turnId,
                  toolId: block.id,
                  toolName,
                  displayName: displayNameForTool(toolName),
                  inputPreview: previewOf(block.input ?? {}),
                  ...(connectorDetails ? { connectorDetails } : {}),
                  ...(agentMessageDetails ? { agentMessageDetails } : {}),
                });
              }
            }
            if (textParts.length) {
              const at = new Date();
              pendingStreamText = '';
              // A subscription session limit arrives as a synthetic assistant
              // message flagged only with isApiErrorMessage (no status on the
              // stream); the turn ends right after it.
              const joinedText = textParts.join('\n\n');
              if (
                isClaudeSessionLimitMessage(joinedText, {
                  isApiErrorMessage: wire.msg.isApiErrorMessage,
                  apiErrorStatus: wire.msg.apiErrorStatus,
                  error: wire.msg.error,
                  model: wire.msg.message.model,
                })
              ) {
                sessionLimitText = joinedText;
              }
              onEvent({
                type: 'text_final',
                turnId,
                markdown: displayClaudeRateLimitMessage(
                  textParts.join('\n\n'),
                  {
                    isApiErrorMessage: wire.msg.isApiErrorMessage,
                    apiErrorStatus: wire.msg.apiErrorStatus,
                    error: wire.msg.error,
                    model: wire.msg.message.model,
                  },
                  at,
                ),
                at: at.toISOString(),
              });
            }
            break;
          }
          case 'user': {
            if (wire.msg.parent_tool_use_id) {
              watchdog.activity();
              const childContent = wire.msg.message.content;
              if (Array.isArray(childContent)) {
                for (const block of childContent) {
                  if (block.type === 'tool_result') emitClaudeChildResult(wire.msg.parent_tool_use_id, block);
                }
              }
              break;
            }
            const content = wire.msg.message.content;
            const notificationText = typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? content.filter((block) => block.type === 'text' && block.text).map((block) => block.text).join('\n')
                : '';
            const notification = notificationText ? parseClaudeTaskNotification(notificationText) : null;
            if (notification) {
              watchdog.activity(); // a child changing state is real progress
              updateSubagent(notification.toolUseId, notification.status);
              break;
            }
            const replayedText =
              typeof content === 'string'
                ? content.trim()
                : Array.isArray(content)
                  ? content
                      .filter((block) => block.type === 'text' && block.text)
                      .map((block) => block.text)
                      .join('\n')
                      .trim()
                  : '';
            if (replayedText) {
              watchdog.activity();
              const index = pendingInputs.findIndex((pending) => pending.text.trim() === replayedText);
              if (index >= 0) {
                const [pending] = pendingInputs.splice(index, 1);
                if (pending?.resolve) {
                  // An echo arriving inside the kill grace window is worthless:
                  // this turn is being discarded, so whatever the CLI says it
                  // read will never produce a reply. Reporting it as accepted
                  // would let the caller drop its durable copy and lose the
                  // message entirely.
                  if (killReason) {
                    pending.resolve(false);
                  } else {
                    onEvent({
                      type: 'turn_started',
                      turnId,
                      role: 'user',
                      text: pending.text,
                      at: new Date().toISOString(),
                      via: 'web',
                    });
                    pending.resolve(true);
                  }
                }
              }
            }
            if (!Array.isArray(content)) break;
            for (const block of content) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                if (!isPollingToolId(block.tool_use_id)) watchdog.activity();
                releaseTool(block.tool_use_id);
                if (subagentToolIds.has(block.tool_use_id)) {
                  const result = wire.msg.toolUseResult;
                  updateSubagent(block.tool_use_id, claudeAgentLaunchStatus(result?.status, Boolean(block.is_error)), {
                    ...(result?.description ? { label: result.description } : {}),
                    ...(result?.resolvedModel ? { model: result.resolvedModel } : {}),
                    ...(typeof result?.totalDurationMs === 'number' ? { durationMs: result.totalDurationMs } : {}),
                    ...(typeof result?.totalToolUseCount === 'number' ? { actionCount: result.totalToolUseCount } : {}),
                    ...(typeof result?.toolStats?.editFileCount === 'number'
                      ? { filesChanged: result.toolStats.editFileCount }
                      : {}),
                    ...(typeof result?.toolStats?.linesAdded === 'number'
                      ? { linesAdded: result.toolStats.linesAdded }
                      : {}),
                    ...(typeof result?.toolStats?.linesRemoved === 'number'
                      ? { linesRemoved: result.toolStats.linesRemoved }
                      : {}),
                  });
                  continue;
                }
                const images = saveToolResultImages(block.content);
                const toolName = toolNamesById.get(block.tool_use_id) ?? '';
                const connectorDetails = connectorResultDetails(toolName, block.content);
                onEvent({
                  type: 'tool_finished',
                  turnId,
                  toolId: block.tool_use_id,
                  ok: !block.is_error,
                  resultPreview: previewOf(coerceToolResultText(block.content)),
                  ...(images.length ? { images } : {}),
                  ...(connectorDetails ? { connectorDetails } : {}),
                });
              }
            }
            break;
          }
          case 'control_request': {
            const requestId = wire.msg.request_id;
            const toolName = wire.msg.request.tool_name ?? 'tool';
            pendingApprovals.set(requestId, wire.msg.request.input ?? {});
            watchdog.hold();
            onEvent({
              type: 'approval_requested',
              requestId,
              toolName,
              displayName: displayNameForTool(toolName),
              input: wire.msg.request.input ?? {},
              inputPreview: previewOf(wire.msg.request.input ?? {}),
              policyReason: 'This action is not pre-approved and needs a human decision.',
            });
            break;
          }
          case 'result': {
            sawResult = true;
            // Turn is over — nothing more to write; the process exits after this.
            try {
              child.stdin.end();
            } catch {
              /* already closed */
            }
            const outcome =
              killReason === 'user'
                ? 'interrupted_by_user'
                : killReason === 'timeout'
                  ? 'timed_out'
                  : wire.msg.is_error
                    ? 'failed'
                    : 'completed';
            if (pendingStreamText) {
              onEvent({
                type: 'text_final',
                turnId,
                markdown: pendingStreamText,
                at: new Date().toISOString(),
              });
              pendingStreamText = '';
            }
            if (outcome === 'interrupted_by_user' || outcome === 'timed_out') {
              settleActiveSubagents('stopped');
              if (outcome === 'interrupted_by_user') onEvent({ type: 'notice', message: 'Stopped.' });
            } else if (wire.msg.is_error && outcome === 'failed') {
              settleActiveSubagents('failed');
              const message = wire.msg.result ?? `Turn failed (${wire.msg.subtype})`;
              onEvent({
                type: 'error',
                message: previewOf(
                  displayClaudeRateLimitMessage(message, { resultError: true }),
                  500,
                ),
                fatal: false,
              });
            }
            // inputTokens = context occupancy, so prefer the LAST call's usage
            // (tracked off assistant messages). The result usage is a whole-turn
            // aggregate — cache reads recur every round trip, so on tool-heavy
            // turns that sum exceeds the context window several times over.
            const u = wire.msg.usage;
            const aggregateInput = u
              ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
              : null;
            const aggregateOutput = u?.output_tokens ?? 0;
            onEvent({
              type: 'turn_done',
              turnId,
              outcome,
              usage: u
                ? {
                    inputTokens: lastContextTokens ?? aggregateInput ?? 0,
                    outputTokens: aggregateOutput,
                    totalInputTokens: aggregateInput ?? 0,
                    totalOutputTokens: aggregateOutput,
                    totalTokens: (aggregateInput ?? 0) + aggregateOutput,
                    cachedInputTokens: u.cache_read_input_tokens ?? 0,
                    cacheWriteInputTokens: u.cache_creation_input_tokens ?? 0,
                  }
                : undefined,
            });
            // The subscription, not the work, ended this turn. Report it after
            // turn_done so the failover's continuation queues behind a finished
            // turn. Best effort: a throw here must not derail the stream.
            if (outcome === 'failed' && sessionLimitText && opts.onSessionLimit) {
              try {
                opts.onSessionLimit({
                  conversationId: spec.conversationId ?? null,
                  accountId: spawnAccountId,
                  text: sessionLimitText,
                  at: new Date(),
                });
              } catch (err) {
                log.warn(`[${opts.id ?? 'claude'}] session-limit failover failed: ${(err as Error).message}`);
              }
            }
            break;
          }
          case 'rate_limit':
            // Passive usage capture — never user-visible, best-effort (a throw
            // here must not derail the turn, so the store's own writes are guarded).
            try {
              opts.onRateLimit?.(wire.msg.rate_limit_info, spawnAccountId);
            } catch (err) {
              log.warn(`[${opts.id ?? 'claude'}] rate-limit capture failed: ${(err as Error).message}`);
            }
            break;
          case 'skip':
            break;
        }
      }
    });

    // Prompt goes in as one NDJSON line; stdin stays open for control responses
    // and is closed when `result` arrives (verified on 2.1.200).
    writeLine(
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: spec.prompt }] } }),
    );

    function respondToApproval(requestId: string, decision: ApprovalDecision): boolean {
      if (!pendingApprovals.has(requestId)) return false;
      const input = pendingApprovals.get(requestId);
      const line =
        decision.behavior === 'allow'
          ? controlResponseLine(requestId, { behavior: 'allow', updatedInput: input })
          : controlResponseLine(requestId, decision);
      if (!writeLine(line)) return false;
      pendingApprovals.delete(requestId);
      watchdog.release(); // the human answered — the turn is live again
      return true;
    }

    // The CLI only replays an injected user message after its current tool call
    // (or generation) finishes, which can be many minutes. Waiting for that echo
    // before reporting success turned every busy turn into a false negative, so
    // a successful write is reported immediately and the echo is surfaced
    // separately as `acknowledged`.
    async function steer(text: string): Promise<boolean | SteerDelivery> {
      if (settled || killReason || child.exitCode !== null || !child.stdin.writable) return false;
      let resolveAck!: (accepted: boolean) => void;
      const acknowledged = new Promise<boolean>((resolve) => (resolveAck = resolve));
      const pending = { text, resolve: resolveAck };
      pendingInputs.push(pending);
      const line = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      });
      if (!writeLine(line)) {
        const index = pendingInputs.indexOf(pending);
        if (index >= 0) pendingInputs.splice(index, 1);
        return false;
      }
      return { delivered: true, acknowledged };
    }

    return { done, kill, steer, respondToApproval };
  }

  function compactSession(spec: CompactSessionSpec): CompactSessionHandle {
    const { env } = spawnEnvironment({ dangerous: spec.dangerous });
    // In headless Claude Code an exact slash command passed to -p is handled by
    // the CLI's native command parser (synthetic, zero-token response). Do not
    // send /compact through the ordinary stream-json user-message path.
    const child = spawn(
      opts.claudeBin,
      [
        '-p',
        '/compact',
        '--resume',
        spec.nativeSessionId,
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      {
        cwd: spec.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      },
    );

    let settled = false;
    let killed = false;
    let timedOut = false;
    let sawResult = false;
    let sawCompactBoundary = false;
    let nativeError = '';
    let stderrTail = '';
    let killTimer: NodeJS.Timeout | null = null;
    let turnTimer: NodeJS.Timeout | null = null;
    let resolveDone!: (result: { contextTokens: null }) => void;
    let rejectDone!: (err: Error) => void;

    const done = new Promise<{ contextTokens: null }>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (turnTimer) clearTimeout(turnTimer);
      if (killTimer) clearTimeout(killTimer);
      if (err) rejectDone(err);
      else resolveDone({ contextTokens: null });
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        sawCompactBoundary = true;
      } else if (msg.type === 'assistant') {
        const message = msg.message as { model?: unknown; content?: unknown } | undefined;
        if (message?.model === '<synthetic>' && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (!block || typeof block !== 'object') continue;
            const text = (block as { text?: unknown }).text;
            nativeError ||= nativeCompactionFailure(text) ?? '';
          }
        }
      } else if (msg.type === 'result') {
        sawResult = true;
        nativeError ||= nativeCompactionFailure(msg.result) ?? '';
        if (msg.is_error === true && !nativeError) {
          const errors = Array.isArray(msg.errors)
            ? msg.errors.filter((error): error is string => typeof error === 'string' && Boolean(error.trim()))
            : [];
          nativeError = errors[0]?.trim() || 'Claude Code could not compact the session.';
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2_000);
    });
    child.on('error', (err) => finish(new Error(`Claude Code failed to start: ${err.message}`)));
    child.on('close', (code) => {
      rl.close();
      if (killed) {
        finish(new Error(timedOut ? 'Claude context compaction timed out.' : 'Claude context compaction was interrupted.'));
      } else if (nativeError) {
        finish(new Error(nativeError));
      } else if (code === 0 && sawResult && sawCompactBoundary) {
        finish();
      } else {
        const detail = stderrTail.trim();
        finish(new Error(
          detail || (code === 0 && sawResult
            ? 'Claude Code did not report a native compaction boundary.'
            : `Claude context compaction exited with code ${code ?? 'unknown'}.`),
        ));
      }
    });

    // Compaction is one bounded non-interactive request, so it is guarded by
    // the inactivity window rather than the multi-hour turn ceiling.
    turnTimer = setTimeout(() => {
      timedOut = true;
      kill();
    }, inactivityMs);
    turnTimer.unref?.();

    function kill(): void {
      if (killed || child.exitCode !== null) return;
      killed = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    }

    return { done, kill };
  }

  return {
    id: opts.id ?? 'claude',
    mintSessionId: () => crypto.randomUUID(),
    runTurn,
    ...((opts.id ?? 'claude') === 'claude' ? { compactSession } : {}),
    readTranscript: (conv) => readClaudeTranscript(conv.cwd, conv.nativeSessionId, opts.configDir),
    // Claude Code deletes session JSONLs after cleanupPeriodDays (30 by
    // default), so this file is what the transcript archive protects.
    nativeTranscriptPath: (conv) => claudeNativeTranscriptPath(conv.cwd, conv.nativeSessionId, opts.configDir),
    readTitle: (conv) => readClaudeAiTitle(conv.cwd, conv.nativeSessionId, opts.configDir),
    readModel: (conv) => readClaudeModel(conv.cwd, conv.nativeSessionId, opts.configDir),
    listModels,
    listCreatedFiles: (conv) => collectClaudeSessionFiles(conv.cwd, conv.nativeSessionId, opts.configDir),
  };
}

function coerceToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
        return (c as { text?: string }).text ?? '';
      }
      if (c && typeof c === 'object' && (c as { type?: string }).type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
