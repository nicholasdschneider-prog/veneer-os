import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConversationEvent } from '../../runtime/events.js';
import type { CreatedFileRef } from '../types.js';

/**
 * Grok keeps its own native session history inside `$GROK_HOME`, but that store
 * is undocumented and version-unstable, and ACP's own `session/load` replay is
 * only available while an agent process is alive. So — exactly like the Codex
 * App Server adapter — this adapter writes its OWN normalized transcript: one
 * JSONL file per ACP session id holding the ConversationEvents already mapped
 * from the Grok stream, and reads that back for rehydration.
 *
 * `transcriptsDir` is injected rather than derived, so tests and a future
 * relocation of the data dir do not have to reach into `homes.ts`.
 */

export function shadowTranscriptPath(transcriptsDir: string, nativeSessionId: string): string {
  return path.join(transcriptsDir, `${nativeSessionId}.jsonl`);
}

/** Append a completed turn's events. Called once per turn, at turn end. */
export function appendShadowTranscript(
  transcriptsDir: string,
  nativeSessionId: string,
  events: ConversationEvent[],
): void {
  if (!events.length) return;
  const lines = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
  fsSync.appendFileSync(shadowTranscriptPath(transcriptsDir, nativeSessionId), lines);
}

export async function readGrokTranscript(
  transcriptsDir: string,
  nativeSessionId: string,
): Promise<ConversationEvent[]> {
  if (!nativeSessionId) return [];
  let content: string;
  try {
    content = await fs.readFile(shadowTranscriptPath(transcriptsDir, nativeSessionId), 'utf8');
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
  return events;
}

/**
 * Sidecar for created-file refs, one JSONL per session next to the shadow
 * transcript. Needed because the shadow transcript persists only bounded
 * previews of tool inputs/outputs — full paths must be captured live, at turn
 * time, while the adapter still holds the complete ACP tool_call payloads.
 */
export function shadowFilesPath(transcriptsDir: string, nativeSessionId: string): string {
  return path.join(transcriptsDir, `${nativeSessionId}.files.jsonl`);
}

/** Append a completed turn's created-file refs. Called once per turn, at turn end. */
export function appendShadowFiles(
  transcriptsDir: string,
  nativeSessionId: string,
  refs: CreatedFileRef[],
): void {
  if (!refs.length) return;
  const lines = `${refs.map((r) => JSON.stringify(r)).join('\n')}\n`;
  fsSync.appendFileSync(shadowFilesPath(transcriptsDir, nativeSessionId), lines);
}

/** All refs recorded for a session, deduped by path ('write' beats 'bash'). */
export async function readShadowFiles(
  transcriptsDir: string,
  nativeSessionId: string,
): Promise<CreatedFileRef[]> {
  if (!nativeSessionId) return [];
  let content: string;
  try {
    content = await fs.readFile(shadowFilesPath(transcriptsDir, nativeSessionId), 'utf8');
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

const MAX_LEGACY_OUTBOX_FILES = 256;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

/**
 * File Box predates Pro's generated-files registry. It copied explicitly
 * presented deliverables into ~/.local/share/veneer/outbox/<native-session>
 * and promised a pill that only the retired client knew how to render.
 *
 * Read that one exact, flat session directory as a compatibility feed so old
 * Grok chats self-heal on their next file sync. Symlinks and nested entries are
 * refused here; the registry applies its normal realpath/source/upload guards
 * before anything reaches the UI or a download route.
 */
export async function readLegacyOutboxFiles(
  nativeSessionId: string,
  homes: readonly string[],
): Promise<CreatedFileRef[]> {
  if (!SAFE_SESSION_ID.test(nativeSessionId)) return [];
  const files = new Set<string>();
  for (const home of new Set(homes.map((entry) => path.resolve(entry)))) {
    const sessionDir = path.join(home, '.local', 'share', 'veneer', 'outbox', nativeSessionId);
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(sessionDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.size >= MAX_LEGACY_OUTBOX_FILES) break;
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const candidate = path.join(sessionDir, entry.name);
      try {
        // Dirent.isFile rejects symlinks. lstat closes the rename race between
        // readdir and registration without following a replacement symlink.
        if (!fsSync.lstatSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      files.add(candidate);
    }
  }
  return [...files].map((filePath) => ({ path: filePath, source: 'write' }));
}

/**
 * The model that answered. Grok's ACP stream never echoes the active model, so
 * — unlike Codex, where it is recoverable from the native rollout — the only
 * truthful source is what the adapter itself selected via `session/set_model`.
 * Recorded per turn, last write wins.
 */
export function shadowModelPath(transcriptsDir: string, nativeSessionId: string): string {
  return path.join(transcriptsDir, `${nativeSessionId}.model`);
}

export function writeShadowModel(transcriptsDir: string, nativeSessionId: string, model: string): void {
  if (!nativeSessionId || !model) return;
  fsSync.writeFileSync(shadowModelPath(transcriptsDir, nativeSessionId), `${model}\n`);
}

export async function readShadowModel(
  transcriptsDir: string,
  nativeSessionId: string,
): Promise<string | null> {
  if (!nativeSessionId) return null;
  try {
    const raw = await fs.readFile(shadowModelPath(transcriptsDir, nativeSessionId), 'utf8');
    return raw.trim() || null;
  } catch {
    return null;
  }
}
