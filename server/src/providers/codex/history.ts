import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConversationEvent } from '../../runtime/events.js';
import type { CreatedFileRef } from '../types.js';
import { findRolloutFile, readCodexTranscript, readShadowFiles, shadowFilesPath, shadowTranscriptPath } from './transcript.js';

interface HistoryDirectories {
  transcriptsDir: string;
  legacyTranscriptsDir?: string;
}

interface HistoryEntry {
  sessionId: string;
  transcriptBytes?: number;
  legacyTranscriptBytes?: number;
  filesBytes?: number;
}

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const NATIVE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_ANCESTORS = 128;
const MAX_METADATA_BYTES = 256 * 1024;
const parentPath = (dir: string, id: string) => path.join(dir, `${id}.parent.json`);

async function fileSize(file: string): Promise<number> {
  try { return (await fs.stat(file)).size; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/** Persist before publishing the new native id, so a crash cannot orphan the
 * visible history. Byte limits keep inherited content fixed if a parent grows. */
export async function recordCodexFork(dirs: HistoryDirectories, childId: string, parentId: string): Promise<void> {
  if (!SAFE_ID.test(childId) || !SAFE_ID.test(parentId) || childId === parentId) {
    throw new Error('Invalid Codex history fork');
  }
  const [transcriptBytes, legacyTranscriptBytes, filesBytes] = await Promise.all([
    fileSize(shadowTranscriptPath(dirs.transcriptsDir, parentId)),
    dirs.legacyTranscriptsDir ? fileSize(shadowTranscriptPath(dirs.legacyTranscriptsDir, parentId)) : 0,
    fileSize(shadowFilesPath(dirs.transcriptsDir, parentId)),
  ]);
  const entry: HistoryEntry = { sessionId: parentId, transcriptBytes, legacyTranscriptBytes, filesBytes };
  await fs.writeFile(parentPath(dirs.transcriptsDir, childId), JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
}

function validEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const row = value as HistoryEntry;
  return typeof row.sessionId === 'string' && SAFE_ID.test(row.sessionId)
    && [row.transcriptBytes, row.legacyTranscriptBytes, row.filesBytes].every(
      (size) => size === undefined || (Number.isSafeInteger(size) && size >= 0),
    );
}

async function parentFor(dirs: HistoryDirectories, sessionId: string): Promise<HistoryEntry | null> {
  try {
    const raw = await fs.readFile(parentPath(dirs.transcriptsDir, sessionId), 'utf8');
    if (raw.length > MAX_METADATA_BYTES) return null;
    const entry: unknown = JSON.parse(raw);
    return validEntry(entry) ? entry : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }

  // Recover older forks that predate the sidecar. Read only session metadata,
  // never native message bodies; presentation still comes from normalized logs.
  if (!NATIVE_ID.test(sessionId)) return null;
  const rollout = await findRolloutFile(sessionId);
  if (!rollout) return null;
  const handle = await fs.open(rollout, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(MAX_METADATA_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.indexOf(10);
    if (newline < 0 || newline >= bytesRead) return null;
    const row = JSON.parse(buffer.toString('utf8', 0, newline));
    const parent = row.payload?.forked_from_id;
    if (row.type !== 'session_meta' || (row.payload?.id ?? row.payload?.session_id) !== sessionId || typeof parent !== 'string' || !NATIVE_ID.test(parent)) return null;
    return { sessionId: parent };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function historyEntries(dirs: HistoryDirectories, sessionId: string): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  const seen = new Set<string>();
  let entry: HistoryEntry | null = { sessionId };
  while (entry && SAFE_ID.test(entry.sessionId) && !seen.has(entry.sessionId) && entries.length <= MAX_ANCESTORS) {
    entries.push(entry);
    seen.add(entry.sessionId);
    entry = await parentFor(dirs, entry.sessionId);
  }
  return entries.reverse();
}

export async function readCodexHistory(dirs: HistoryDirectories, sessionId: string): Promise<ConversationEvent[]> {
  const entries = await historyEntries(dirs, sessionId);
  const parts = await Promise.all(entries.map(async (entry) => {
    const [legacy, current] = await Promise.all([
      dirs.legacyTranscriptsDir ? readCodexTranscript(dirs.legacyTranscriptsDir, entry.sessionId, entry.legacyTranscriptBytes) : [],
      readCodexTranscript(dirs.transcriptsDir, entry.sessionId, entry.transcriptBytes),
    ]);
    return [...legacy, ...current];
  }));
  return parts.flat();
}

export async function readCodexHistoryFiles(dirs: HistoryDirectories, sessionId: string): Promise<CreatedFileRef[]> {
  const entries = await historyEntries(dirs, sessionId);
  const parts = await Promise.all(entries.map((entry) => readShadowFiles(dirs.transcriptsDir, entry.sessionId, entry.filesBytes)));
  const files = new Map<string, CreatedFileRef>();
  for (const ref of parts.flat()) if (files.get(ref.path)?.source !== 'write') files.set(ref.path, ref);
  return [...files.values()];
}
