import fs from 'node:fs/promises';
import path from 'node:path';
import { serviceHome } from '../../homes.js';
import type { ConversationEvent } from '../../runtime/events.js';
import { CONTEXT_COMPACTED_NOTICE, VENEER_RESTARTED_NOTICE, displayNameForTool, previewOf } from '../../runtime/events.js';
import { safeTerminalAction } from '../../runtime/subagentProgress.js';
import { saveToolResultImages } from '../../runtime/media.js';
import { connectorInputDetails, connectorResultDetails } from '../../runtime/connectorToolDetails.js';
import { agentMessageInputDetails } from '../../runtime/agentMessageToolDetails.js';
import { displayClaudeRateLimitMessage } from './rateLimitMessage.js';
import {
  CLAUDE_SUBAGENT_TOOL,
  claudeAgentLaunchStatus,
  claudeSubagentKey,
  claudeSubagentStarted,
  parseClaudeTaskNotification,
} from './subagents.js';

/**
 * Rehydrate a conversation from Claude Code's native session JSONL at
 * ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl (spec §7.2). Parsing
 * logic ported from Veneer services/claude-transcript.js, trimmed to the
 * prototype's needs: user/assistant text + tool summaries.
 */

// Title/model scans stay small; the transcript window is wider because a
// single base64 screenshot in a tool_result row can be 1 MB+ of JSONL — a 2 MB
// tail would push real history out after a couple of screenshots.
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

export function claudeProjectKeyForCwd(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export function claudeSessionFilePath(
  cwd: string,
  sessionId: string,
  home = serviceHome(),
  configDir?: string,
): string {
  return path.join(configDir ?? path.join(home, '.claude'), 'projects', claudeProjectKeyForCwd(cwd), `${sessionId}.jsonl`);
}

interface JsonlRow {
  type?: string;
  isSidechain?: boolean;
  /** Native context summary, retained for resume but never a visible user turn. */
  isCompactSummary?: boolean;
  /** Claude Code marks the user-looking row it writes when its process is stopped. */
  interruptedByShutdown?: boolean;
  /** Claude Code marks its automatic post-interruption continuation as metadata. */
  isMeta?: boolean;
  error?: string;
  isApiErrorMessage?: boolean;
  apiErrorStatus?: number;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      output_tokens?: number;
    };
  };
  toolUseResult?: {
    status?: string;
    description?: string;
    resolvedModel?: string;
    totalDurationMs?: number;
    totalToolUseCount?: number;
    toolStats?: {
      editFileCount?: number;
      linesAdded?: number;
      linesRemoved?: number;
    };
  };
}

interface RawBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

const CLAUDE_INTERRUPTION_MARKERS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);
const CLAUDE_CONTINUATION_PROMPT = 'Continue from where you left off.';
const CLAUDE_NO_RESPONSE = 'No response requested.';

/** Return text only when the native row contains exactly one text message. */
function soleTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block = content[0] as RawBlock | undefined;
  return block?.type === 'text' && typeof block.text === 'string' ? block.text.trim() : null;
}

function coerceToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as RawBlock[])
    .map((c) => (c?.type === 'text' ? (c.text ?? '') : c?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

export async function readTail(filePath: string, maxBytes: number): Promise<string> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return '';
  }
  if (stat.size <= maxBytes) return fs.readFile(filePath, 'utf8');
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    await fh.read(buf, 0, maxBytes, stat.size - maxBytes);
    let str = buf.toString('utf8');
    const nl = str.indexOf('\n');
    if (nl >= 0) str = str.slice(nl + 1); // drop the partial first line
    return str;
  } finally {
    await fh.close();
  }
}

/**
 * Claude Code resolves a symlinked working directory before it chooses the
 * ~/.claude/projects key. Veneer project roots can be symlinks, so try the
 * configured path first (it may be a migration alias), then its real path.
 */
export async function readClaudeSessionTail(
  cwd: string,
  sessionId: string,
  maxBytes: number,
  configDir?: string,
): Promise<string> {
  const primaryPath = claudeSessionFilePath(cwd, sessionId, serviceHome(), configDir);
  const primary = await readTail(primaryPath, maxBytes);
  if (primary) return primary;

  let realCwd: string;
  try {
    realCwd = await fs.realpath(cwd);
  } catch {
    return '';
  }
  if (realCwd === path.resolve(cwd)) return '';
  return readTail(claudeSessionFilePath(realCwd, sessionId, serviceHome(), configDir), maxBytes);
}

/**
 * The file readClaudeSessionTail actually reads, for the transcript archive.
 * Prefers whichever of the two candidate keys (configured cwd, realpath'd cwd)
 * holds the session today; falls back to the primary path so a restore has a
 * canonical destination when Claude Code has already purged the file.
 */
export async function claudeNativeTranscriptPath(
  cwd: string,
  sessionId: string,
  configDir?: string,
): Promise<string> {
  const primaryPath = claudeSessionFilePath(cwd, sessionId, serviceHome(), configDir);
  if (await fileExists(primaryPath)) return primaryPath;
  try {
    const realCwd = await fs.realpath(cwd);
    if (realCwd !== path.resolve(cwd)) {
      const alt = claudeSessionFilePath(realCwd, sessionId, serviceHome(), configDir);
      if (await fileExists(alt)) return alt;
    }
  } catch {
    // cwd is gone; the primary path is still the right place to restore into.
  }
  return primaryPath;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function parseClaudeTranscript(content: string): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  // Assistant messages stream as multiple rows sharing one message id; merge.
  const textFinalByMessageId = new Map<string, { event: Extract<ConversationEvent, { type: 'text_final' }>; parts: string[] }>();
  const turnUsageByMessageId = new Map<
    string,
    { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number }
  >();
  let lastTextFinalForTurn: Extract<ConversationEvent, { type: 'text_final' }> | null = null;
  const finalizeTurnUsage = (): void => {
    if (lastTextFinalForTurn && turnUsageByMessageId.size > 0) {
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let cachedInputTokens = 0;
      let cacheWriteInputTokens = 0;
      for (const usage of turnUsageByMessageId.values()) {
        totalInputTokens += usage.inputTokens;
        totalOutputTokens += usage.outputTokens;
        cachedInputTokens += usage.cachedInputTokens;
        cacheWriteInputTokens += usage.cacheWriteInputTokens;
      }
      if (totalInputTokens + totalOutputTokens > 0) {
        lastTextFinalForTurn.usage = {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          totalInputTokens,
          totalOutputTokens,
          totalTokens: totalInputTokens + totalOutputTokens,
          cachedInputTokens,
          cacheWriteInputTokens,
        };
      }
    }
    turnUsageByMessageId.clear();
    lastTextFinalForTurn = null;
  };
  const toolFinishedByToolId = new Map<string, Extract<ConversationEvent, { type: 'tool_finished' }>>();
  const toolNamesById = new Map<string, string>();
  const subagentTurnByToolId = new Map<string, string>();
  const subagentStartedAtByToolId = new Map<string, string>();
  const terminalProgress = (
    toolUseId: string,
    status: 'completed' | 'stopped' | 'failed',
    at: string,
  ): { currentAction: string; durationMs?: number } => {
    const startedAt = subagentStartedAtByToolId.get(toolUseId);
    const durationMs = startedAt ? Date.parse(at) - Date.parse(startedAt) : Number.NaN;
    return {
      currentAction: safeTerminalAction(status),
      ...(Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs) } : {}),
    };
  };
  // Agent launches that have not reached a terminal event yet. A turn the
  // user stopped never writes a tool_result or task-notification for its
  // agents, so the next typed prompt is the only proof they are gone.
  const unsettledSubagentIds = new Set<string>();
  const settleOrphanedSubagents = (at: string): void => {
    for (const toolUseId of unsettledSubagentIds) {
      events.push({
        type: 'subagent_updated',
        turnId: subagentTurnByToolId.get(toolUseId) ?? turnId,
        agentKey: claudeSubagentKey(toolUseId),
        status: 'stopped',
        ...terminalProgress(toolUseId, 'stopped', at),
      });
    }
    unsettledSubagentIds.clear();
  };
  // Headless native commands are persisted as user-looking XML envelopes.
  // They maintain Claude's session but are not messages the user sent in
  // Veneer. Hide that bookkeeping while preserving one neutral confirmation
  // for a successful native /compact command.
  const nativeCommandRows = new Set<string>();
  // Stopping Claude produces a second native-only chain on the next resume:
  // interruption marker -> meta continuation -> synthetic no-response reply.
  // UUID ancestry plus Claude's native flags keeps look-alike human text visible.
  const nativeInterruptionRows = new Set<string>();
  let nativeContinuationPending = false;
  let nativeCommandWasCompaction = false;
  let compactionNoticeEmittedForCommand = false;
  let turnCounter = 0;
  let turnId = 't0';

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let row: JsonlRow;
    try {
      row = JSON.parse(line) as JsonlRow;
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    if (row.isSidechain || row.isCompactSummary) continue;

    const at = row.timestamp ?? new Date(0).toISOString();

    if (row.type === 'user') {
      const mc = row.message?.content;
      const soleText = soleTextContent(mc);
      if (
        row.uuid &&
        row.interruptedByShutdown === true &&
        soleText !== null &&
        CLAUDE_INTERRUPTION_MARKERS.has(soleText)
      ) {
        nativeInterruptionRows.add(row.uuid);
        continue;
      }
      if (
        row.uuid &&
        row.isMeta === true &&
        row.parentUuid &&
        nativeInterruptionRows.has(row.parentUuid) &&
        soleText === CLAUDE_CONTINUATION_PROMPT
      ) {
        nativeInterruptionRows.add(row.uuid);
        continue;
      }
      // A runner kill (ship/restart/crash) leaves no interruption marker, so the
      // meta continuation's parent is an ordinary row. Claude's own isMeta flag
      // still identifies it; hide the pair and say why the turn resumed.
      if (row.uuid && row.isMeta === true && soleText === CLAUDE_CONTINUATION_PROMPT) {
        nativeInterruptionRows.add(row.uuid);
        events.push({ type: 'notice', message: VENEER_RESTARTED_NOTICE, at });
        continue;
      }
      if (typeof mc === 'string') {
        if (/^\s*<(?:local-command-(?:caveat|stdout|stderr)|command-(?:name|message|args))\b/i.test(mc)) {
          const commandName = mc.match(/^\s*<command-name>\s*([^<]+?)\s*<\/command-name>/i)?.[1];
          if (commandName !== undefined) {
            nativeCommandWasCompaction = commandName.trim().toLowerCase() === '/compact';
            compactionNoticeEmittedForCommand = false;
          }
          const isCompactionStdout = /^\s*<local-command-stdout>\s*Compacted\b/i.test(mc);
          if (isCompactionStdout) {
            nativeContinuationPending = true;
            if (nativeCommandWasCompaction && !compactionNoticeEmittedForCommand) {
              events.push({ type: 'notice', message: CONTEXT_COMPACTED_NOTICE });
              compactionNoticeEmittedForCommand = true;
            }
          }
          // Output closes the native command. Do not let a malformed or
          // partial later envelope inherit an earlier /compact identity.
          if (/^\s*<local-command-(?:stdout|stderr)\b/i.test(mc)) {
            nativeCommandWasCompaction = false;
          }
          if (row.uuid) nativeCommandRows.add(row.uuid);
          continue;
        }
        nativeContinuationPending = false;
        nativeCommandWasCompaction = false;
        compactionNoticeEmittedForCommand = false;
        const notification = parseClaudeTaskNotification(mc);
        if (notification) {
          const notificationTurnId = subagentTurnByToolId.get(notification.toolUseId) ?? turnId;
          events.push({
            type: 'subagent_updated',
            turnId: notificationTurnId,
            agentKey: claudeSubagentKey(notification.toolUseId),
            status: notification.status,
            ...terminalProgress(notification.toolUseId, notification.status, at),
          });
          unsettledSubagentIds.delete(notification.toolUseId);
          continue;
        }
        // A real typed user prompt → new turn.
        const text = mc.trim();
        if (!text) continue;
        finalizeTurnUsage();
        settleOrphanedSubagents(at);
        turnCounter += 1;
        turnId = `t${turnCounter}`;
        events.push({ type: 'turn_started', turnId, role: 'user', text, at, via: 'web' });
      } else if (Array.isArray(mc)) {
        const textBlocks = (mc as RawBlock[])
          .filter((block) => block?.type === 'text' && block.text)
          .map((block) => block.text!.trim());
        if (nativeContinuationPending) {
          nativeContinuationPending = false;
          if (textBlocks.length === 1 && textBlocks[0] === CLAUDE_CONTINUATION_PROMPT) {
            if (row.uuid) nativeCommandRows.add(row.uuid);
            continue;
          }
        }
        nativeCommandWasCompaction = false;
        compactionNoticeEmittedForCommand = false;
        const notificationText = (mc as RawBlock[])
          .filter((block) => block?.type === 'text' && block.text)
          .map((block) => block.text)
          .join('\n');
        const notification = notificationText ? parseClaudeTaskNotification(notificationText) : null;
        if (notification) {
          events.push({
            type: 'subagent_updated',
            turnId: subagentTurnByToolId.get(notification.toolUseId) ?? turnId,
            agentKey: claudeSubagentKey(notification.toolUseId),
            status: notification.status,
            ...terminalProgress(notification.toolUseId, notification.status, at),
          });
          unsettledSubagentIds.delete(notification.toolUseId);
          continue;
        }
        for (const block of mc as RawBlock[]) {
          if (block?.type === 'text' && block.text?.trim()) {
            finalizeTurnUsage();
            settleOrphanedSubagents(at);
            turnCounter += 1;
            turnId = `t${turnCounter}`;
            events.push({ type: 'turn_started', turnId, role: 'user', text: block.text.trim(), at, via: 'web' });
          } else if (block?.type === 'tool_result' && block.tool_use_id) {
            const subagentTurnId = subagentTurnByToolId.get(block.tool_use_id);
            if (subagentTurnId) {
              const status = claudeAgentLaunchStatus(row.toolUseResult?.status, Boolean(block.is_error));
              const terminal = status === 'completed' || status === 'stopped' || status === 'failed';
              if (terminal) unsettledSubagentIds.delete(block.tool_use_id);
              const fallbackProgress: { currentAction?: string; durationMs?: number } = terminal
                ? terminalProgress(block.tool_use_id, status, at)
                : {};
              events.push({
                type: 'subagent_updated',
                turnId: subagentTurnId,
                agentKey: claudeSubagentKey(block.tool_use_id),
                status,
                ...(row.toolUseResult?.description ? { label: row.toolUseResult.description } : {}),
                ...(row.toolUseResult?.resolvedModel ? { model: row.toolUseResult.resolvedModel } : {}),
                ...(typeof row.toolUseResult?.totalDurationMs === 'number'
                  ? { durationMs: row.toolUseResult.totalDurationMs }
                  : fallbackProgress.durationMs === undefined ? {} : { durationMs: fallbackProgress.durationMs }),
                ...(typeof row.toolUseResult?.totalToolUseCount === 'number'
                  ? { actionCount: row.toolUseResult.totalToolUseCount }
                  : {}),
                ...(typeof row.toolUseResult?.toolStats?.editFileCount === 'number'
                  ? { filesChanged: row.toolUseResult.toolStats.editFileCount }
                  : {}),
                ...(typeof row.toolUseResult?.toolStats?.linesAdded === 'number'
                  ? { linesAdded: row.toolUseResult.toolStats.linesAdded }
                  : {}),
                ...(typeof row.toolUseResult?.toolStats?.linesRemoved === 'number'
                  ? { linesRemoved: row.toolUseResult.toolStats.linesRemoved }
                  : {}),
                ...(fallbackProgress.currentAction ? { currentAction: fallbackProgress.currentAction } : {}),
              });
              continue;
            }
            const images = saveToolResultImages(block.content);
            const toolName = toolNamesById.get(block.tool_use_id) ?? '';
            const connectorDetails = connectorResultDetails(toolName, block.content);
            const ev: Extract<ConversationEvent, { type: 'tool_finished' }> = {
              type: 'tool_finished',
              turnId,
              toolId: block.tool_use_id,
              ok: !block.is_error,
              resultPreview: previewOf(coerceToolResultText(block.content)),
              ...(images.length ? { images } : {}),
              ...(connectorDetails ? { connectorDetails } : {}),
            };
            toolFinishedByToolId.set(block.tool_use_id, ev);
            events.push(ev);
          }
        }
      }
      continue;
    }

    if (row.type === 'assistant') {
      if (
        row.parentUuid &&
        nativeInterruptionRows.has(row.parentUuid) &&
        row.message?.model === '<synthetic>' &&
        soleTextContent(row.message.content) === CLAUDE_NO_RESPONSE
      ) {
        continue;
      }
      if (row.parentUuid && nativeCommandRows.has(row.parentUuid)) {
        if (row.uuid) nativeCommandRows.add(row.uuid);
        continue;
      }
      const messageId = row.message?.id;
      const rawUsage = row.message?.usage;
      const cachedInputTokens = rawUsage?.cache_read_input_tokens ?? 0;
      const cacheWriteInputTokens = rawUsage?.cache_creation_input_tokens ?? 0;
      const totalInputTokens = rawUsage
        ? (rawUsage.input_tokens ?? 0) + cachedInputTokens + cacheWriteInputTokens
        : 0;
      const totalOutputTokens = rawUsage?.output_tokens ?? 0;
      const usageKey = messageId ?? row.uuid;
      if (rawUsage && usageKey) {
        turnUsageByMessageId.set(usageKey, {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cachedInputTokens,
          cacheWriteInputTokens,
        });
      }
      const blocks = Array.isArray(row.message?.content) ? (row.message.content as RawBlock[]) : [];
      const displayText = (text: string): string => displayClaudeRateLimitMessage(
        text,
        {
          isApiErrorMessage: row.isApiErrorMessage,
          apiErrorStatus: row.apiErrorStatus,
          error: row.error,
          model: row.message?.model,
        },
        new Date(at),
      );
      for (const block of blocks) {
        if (block?.type === 'text' && block.text) {
          const text = displayText(block.text);
          if (messageId && textFinalByMessageId.has(messageId)) {
            const entry = textFinalByMessageId.get(messageId)!;
            entry.parts.push(text);
            entry.event.markdown = entry.parts.join('\n\n');
            entry.event.at = at;
            lastTextFinalForTurn = entry.event;
          } else {
            const event: Extract<ConversationEvent, { type: 'text_final' }> = {
              type: 'text_final',
              turnId,
              markdown: text,
              at,
            };
            if (messageId) textFinalByMessageId.set(messageId, { event, parts: [text] });
            events.push(event);
            lastTextFinalForTurn = event;
          }
        } else if (block?.type === 'tool_use' && block.id) {
          const toolName = block.name ?? 'tool';
          if (toolName === CLAUDE_SUBAGENT_TOOL) {
            subagentTurnByToolId.set(block.id, turnId);
            subagentStartedAtByToolId.set(block.id, at);
            unsettledSubagentIds.add(block.id);
            events.push(claudeSubagentStarted(turnId, block.id, block.input, at));
            continue;
          }
          toolNamesById.set(block.id, toolName);
          const connectorDetails = connectorInputDetails(toolName, block.input ?? {});
          const agentMessageDetails = agentMessageInputDetails(toolName, block.input ?? {});
          events.push({
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
      continue;
    }

    // queue-operation, attachment, last-prompt, mode, file-history-snapshot,
    // system rows: noise for the rehydrated transcript.
  }

  finalizeTurnUsage();

  return events;
}

export async function readClaudeTranscript(cwd: string, sessionId: string, configDir?: string): Promise<ConversationEvent[]> {
  if (!cwd || !sessionId) return [];
  const content = await readClaudeSessionTail(cwd, sessionId, MAX_TRANSCRIPT_BYTES, configDir);
  if (!content) return [];
  return parseClaudeTranscript(content);
}

/**
 * Claude Code periodically writes an `ai-title` row into its own session
 * JSONL — the same auto-generated short summary it uses for the terminal
 * title, refreshed as the conversation evolves. Returns the latest one found.
 */
export function pickLatestAiTitle(content: string): string | null {
  let title: string | null = null;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let row: { type?: string; aiTitle?: string };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type === 'ai-title' && typeof row.aiTitle === 'string' && row.aiTitle.trim()) {
      title = row.aiTitle.trim();
    }
  }
  return title;
}

export async function readClaudeAiTitle(cwd: string, sessionId: string, configDir?: string): Promise<string | null> {
  if (!cwd || !sessionId) return null;
  const content = await readClaudeSessionTail(cwd, sessionId, MAX_READ_BYTES, configDir);
  if (!content) return null;
  return pickLatestAiTitle(content);
}

/**
 * Each `assistant` row in the session JSONL echoes the model that produced it
 * (`<synthetic>` for internal calls like title generation — skip those).
 * Returns the most recent real model, i.e. what actually answered the user.
 */
export function pickLatestModel(content: string): string | null {
  let model: string | null = null;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let row: JsonlRow;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const m = row?.type === 'assistant' ? (row.message as { model?: string } | undefined)?.model : undefined;
    if (m && m !== '<synthetic>') model = m;
  }
  return model;
}

export async function readClaudeModel(cwd: string, sessionId: string, configDir?: string): Promise<string | null> {
  if (!cwd || !sessionId) return null;
  const content = await readClaudeSessionTail(cwd, sessionId, MAX_READ_BYTES, configDir);
  if (!content) return null;
  return pickLatestModel(content);
}
