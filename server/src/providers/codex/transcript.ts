import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { proCodexHome } from '../../homes.js';
import {
  connectorInputDetails,
  connectorResultDetails,
  sanitizeConnectorDetails,
} from '../../runtime/connectorToolDetails.js';
import { agentMessageInputDetails, isAgentSendMessageTool } from '../../runtime/agentMessageToolDetails.js';
import type { ConversationEvent } from '../../runtime/events.js';
import type { CreatedFileRef } from '../types.js';

/**
 * Codex's own native session files (`~/.codex/sessions/**\/rollout-*.jsonl`)
 * are the raw Responses-API item log — richer and less stable than what we
 * need, and undocumented enough (no public schema for `response_item` types
 * like `local_shell_call`) that parsing it for rehydration would be guessing.
 * Instead this adapter writes its OWN normalized transcript — one JSONL file
 * per (resolved) native session id, containing exactly the ConversationEvents
 * already mapped from the Codex provider stream — and reads that back.
 * Two deliberately narrow exceptions best-effort scan Codex's native rollout:
 * the model name, which isn't present in the --json event stream, and safe
 * allowlisted connector details for normalized events written before that
 * metadata existed. The latter never returns a raw native payload.
 */

export function shadowTranscriptPath(transcriptsDir: string, nativeSessionId: string): string {
  return path.join(transcriptsDir, `${nativeSessionId}.jsonl`);
}

/** Append normalized events without replacing previously displayed history. */
export function appendShadowTranscript(transcriptsDir: string, nativeSessionId: string, events: ConversationEvent[]): void {
  if (!events.length) return;
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fsSync.appendFileSync(shadowTranscriptPath(transcriptsDir, nativeSessionId), lines);
}

export async function readCodexTranscript(transcriptsDir: string, nativeSessionId: string, maxBytes?: number): Promise<ConversationEvent[]> {
  if (!nativeSessionId) return [];
  let content: string;
  try {
    content = await readPrefix(shadowTranscriptPath(transcriptsDir, nativeSessionId), maxBytes);
  } catch {
    return [];
  }
  const events: ConversationEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as ConversationEvent);
    } catch {
      /* corrupt line — skip it, don't fail the whole rehydrate */
    }
  }
  return backfillConnectorDetails(events, nativeSessionId);
}

/**
 * Sidecar for created-file refs, one JSONL per thread next to the shadow
 * transcript. Needed because the shadow transcript persists only bounded
 * previews of command inputs/outputs — full paths must be captured live, at
 * turn time, when the adapter still has the complete item payloads.
 */
export function shadowFilesPath(transcriptsDir: string, nativeSessionId: string): string {
  return path.join(transcriptsDir, `${nativeSessionId}.files.jsonl`);
}

/** Append newly captured created-file refs alongside durable chat events. */
export function appendShadowFiles(transcriptsDir: string, nativeSessionId: string, refs: CreatedFileRef[]): void {
  if (!refs.length) return;
  const lines = refs.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fsSync.appendFileSync(shadowFilesPath(transcriptsDir, nativeSessionId), lines);
}

/** All refs recorded for a thread, deduped by path ('write' beats 'bash'). */
export async function readShadowFiles(transcriptsDir: string, nativeSessionId: string, maxBytes?: number): Promise<CreatedFileRef[]> {
  if (!nativeSessionId) return [];
  let content: string;
  try {
    content = await readPrefix(shadowFilesPath(transcriptsDir, nativeSessionId), maxBytes);
  } catch {
    return [];
  }
  const bySource = new Map<string, 'write' | 'bash'>();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let ref: CreatedFileRef;
    try {
      ref = JSON.parse(line) as CreatedFileRef;
    } catch {
      continue; // corrupt line — skip it, don't fail the whole listing
    }
    if (typeof ref?.path !== 'string' || !path.isAbsolute(ref.path)) continue;
    const source = ref.source === 'write' ? 'write' : 'bash';
    if (bySource.get(ref.path) !== 'write') bySource.set(ref.path, source);
  }
  return [...bySource].map(([p, source]) => ({ path: p, source }));
}

// Pro's own Codex profile, addressed by path. Never `$HOME/.codex`: a Full
// Access agent runs with the login account's HOME, and its native session
// history still belongs in the service directory.
const sessionsDir = (): string => path.join(process.env.CODEX_HOME || proCodexHome(), 'sessions');
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_CONNECTOR_READ_BYTES = 8 * 1024 * 1024;

async function listDescending(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort().reverse();
  } catch {
    return [];
  }
}

/**
 * Codex shards its native session files under sessions/<year>/<month>/<day>/
 * and names them rollout-<timestamp>-<thread_id>.jsonl — there's no direct
 * lookup by thread id, so this walks the tree newest-first (nearly always a
 * same-day hit) until it finds a match. Best-effort: any failure returns null.
 */
export async function findRolloutFile(threadId: string): Promise<string | null> {
  for (const year of await listDescending(sessionsDir())) {
    const yearDir = path.join(sessionsDir(), year);
    for (const month of await listDescending(yearDir)) {
      const monthDir = path.join(yearDir, month);
      for (const day of await listDescending(monthDir)) {
        const dayDir = path.join(monthDir, day);
        const files = await fs.readdir(dayDir).catch(() => [] as string[]);
        const match = files.find((f) => f.endsWith(`${threadId}.jsonl`));
        if (match) return path.join(dayDir, match);
      }
    }
  }
  return null;
}

/** A fork inherits only the bytes that existed when it was created. */
async function readPrefix(filePath: string, maxBytes?: number): Promise<string> {
  if (maxBytes === undefined) return fs.readFile(filePath, 'utf8');
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.toString('utf8', 0, offset);
  } finally {
    await handle.close();
  }
}

async function readTail(filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.stat(filePath);
  if (stat.size <= maxBytes) return fs.readFile(filePath, 'utf8');
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    await fh.read(buf, 0, maxBytes, stat.size - maxBytes);
    let str = buf.toString('utf8');
    const nl = str.indexOf('\n');
    if (nl >= 0) str = str.slice(nl + 1);
    return str;
  } finally {
    await fh.close();
  }
}

interface NativeConnectorRecord {
  input?: ReturnType<typeof connectorInputDetails>;
  result?: ReturnType<typeof connectorResultDetails>;
  agentMessage?: ReturnType<typeof agentMessageInputDetails>;
}

function nativeResult(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if ('Ok' in record) return record.Ok;
  if ('Err' in record) return { successful: false, error: record.Err };
  return value;
}

/** Recover only fields accepted by connectorToolDetails' explicit allowlist.
 * This exists for historical normalized rows; new rows persist these details
 * at event creation time and never need to inspect the native rollout. */
async function readNativeConnectorRecords(nativeSessionId: string): Promise<Map<string, NativeConnectorRecord>> {
  const records = new Map<string, NativeConnectorRecord>();
  try {
    const file = await findRolloutFile(nativeSessionId);
    if (!file) return records;
    const content = await readTail(file, MAX_CONNECTOR_READ_BYTES);
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let row: {
        type?: string;
        payload?: {
          type?: string;
          call_id?: unknown;
          invocation?: { server?: unknown; tool?: unknown; arguments?: unknown };
          result?: unknown;
        };
      };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = row.type === 'event_msg' && row.payload?.type === 'mcp_tool_call_end'
        ? row.payload
        : undefined;
      if (!payload) continue;
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      const server = typeof payload.invocation?.server === 'string' ? payload.invocation.server : undefined;
      const tool = typeof payload.invocation?.tool === 'string' ? payload.invocation.tool : undefined;
      if (!callId || !server || !tool) continue;
      const toolName = `mcp__${server}__${tool}`;
      const input = connectorInputDetails(toolName, payload.invocation?.arguments);
      const result = connectorResultDetails(toolName, nativeResult(payload.result));
      const agentMessage = agentMessageInputDetails(toolName, payload.invocation?.arguments);
      if (input || result || agentMessage) records.set(callId, { input, result, agentMessage });
    }
  } catch {
    // Native history is best-effort; normalized transcript remains usable.
  }
  return records;
}

async function backfillConnectorDetails(
  events: ConversationEvent[],
  nativeSessionId: string,
): Promise<ConversationEvent[]> {
  const connectorToolIds = new Set<string>();
  const agentMessageToolIds = new Set<string>();
  for (const event of events) {
    if (
      event.type === 'tool_started' &&
      event.source?.kind === 'connector' &&
      connectorInputDetails(event.toolName, {})
    ) {
      connectorToolIds.add(event.toolId);
    }
    if (event.type === 'tool_started' && isAgentSendMessageTool(event.toolName)) {
      agentMessageToolIds.add(event.toolId);
    }
  }
  if (!connectorToolIds.size && !agentMessageToolIds.size) return events;

  const records = await readNativeConnectorRecords(nativeSessionId);
  return events.map((event) => {
    if (event.type !== 'tool_started' && event.type !== 'tool_finished') return event;
    if (!connectorToolIds.has(event.toolId) && !agentMessageToolIds.has(event.toolId)) return event;
    const record = records.get(event.toolId);
    if (event.type === 'tool_started' && record?.agentMessage) {
      return { ...event, agentMessageDetails: record.agentMessage };
    }
    if (event.type === 'tool_started' && record?.input) return { ...event, connectorDetails: record.input };
    if (event.type === 'tool_finished' && record?.result) return { ...event, connectorDetails: record.result };
    const sanitized = sanitizeConnectorDetails(event.connectorDetails);
    if (sanitized) return { ...event, connectorDetails: sanitized };
    const { connectorDetails: _unsafeDetails, ...safeEvent } = event;
    return safeEvent as ConversationEvent;
  });
}

/**
 * The model actually used is only recorded in Codex's native rollout file
 * (each turn_context row's `model` field), not in the normalized event stream —
 * so this is the one place we read Codex's own session log.
 */
export async function readCodexModel(nativeSessionId: string): Promise<string | null> {
  if (!nativeSessionId) return null;
  try {
    const file = await findRolloutFile(nativeSessionId);
    if (!file) return null;
    const content = await readTail(file, MAX_READ_BYTES);
    let model: string | null = null;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let row: { type?: string; payload?: { model?: string } };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const m = row?.type === 'turn_context' ? row.payload?.model : undefined;
      if (typeof m === 'string' && m) model = m;
    }
    return model;
  } catch {
    return null;
  }
}
