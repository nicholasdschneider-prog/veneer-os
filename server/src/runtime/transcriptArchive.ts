import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { ConversationRow } from '../db/db.js';
import { proClaudeConfigDir } from '../homes.js';
import type { ProviderAdapter } from '../providers/types.js';

/**
 * Veneer-owned copies of provider-native transcript files.
 *
 * Claude Code deletes `~/.claude/projects/<key>/<session>.jsonl` once it is
 * older than `cleanupPeriodDays` (30 by default). Veneer stores nothing else:
 * `snapshot()` re-reads that file on every open, so the purge silently emptied
 * chats older than a month. Codex and Grok already read Veneer-owned shadow
 * transcripts and are not at risk; Codex's native rollout file is archived
 * anyway because resume wants it and the copy is nearly free.
 *
 * The archive is append-only in spirit: entries are never deleted, and a
 * restore only ever writes bytes back that the provider itself produced.
 * Everything here is best effort — a failure is logged, never thrown, and never
 * blocks a turn or a snapshot.
 */

/** A conversation as the archive addresses it. */
export interface ArchiveTarget {
  cwd: string;
  nativeSessionId: string;
}

export type ArchiveOutcome = 'archived' | 'skipped' | 'unavailable' | 'error';

export interface TranscriptArchive {
  archive(provider: string, conv: ArchiveTarget): Promise<ArchiveOutcome>;
  restore(provider: string, conv: ArchiveTarget): Promise<boolean>;
  sweep(rows: ConversationRow[]): Promise<{ archived: number; skipped: number; errors: number }>;
}

/** Archives are keyed by provider + native session id, matching house style. */
export function transcriptArchivePath(dataDir: string, provider: string, nativeSessionId: string): string {
  return path.join(dataDir, 'transcripts', provider, `${nativeSessionId}.jsonl`);
}

async function statOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

/**
 * Copy through a temp file in the destination directory, then rename: a reader
 * (or a crash) can only ever see the whole old file or the whole new one.
 * mtime is preserved so the "already archived" comparison below stays stable.
 */
async function copyAtomic(from: string, to: string, mtime: Date, atime: Date): Promise<void> {
  const dir = path.dirname(to);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(to)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.copyFile(from, tmp);
    await fs.utimes(tmp, atime, mtime);
    await fs.rename(tmp, to);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export function createTranscriptArchive({
  dataDir,
  adapters,
  resolveCwd,
  log = console,
}: {
  dataDir: string;
  adapters: Record<string, ProviderAdapter>;
  /** Which working directory a conversation runs in (sweep only). */
  resolveCwd?: (conv: ConversationRow) => string;
  log?: Pick<Console, 'log' | 'warn'>;
}): TranscriptArchive {
  async function nativePathFor(provider: string, conv: ArchiveTarget): Promise<string | null> {
    const adapter = adapters[provider];
    if (!adapter?.nativeTranscriptPath) return null;
    if (!conv.nativeSessionId || !conv.cwd) return null;
    return adapter.nativeTranscriptPath(conv);
  }

  async function archive(provider: string, conv: ArchiveTarget): Promise<ArchiveOutcome> {
    try {
      const nativePath = await nativePathFor(provider, conv);
      if (!nativePath) return 'unavailable';
      const nativeStat = await statOrNull(nativePath);
      if (!nativeStat || !nativeStat.isFile()) return 'unavailable';
      const archivePath = transcriptArchivePath(dataDir, provider, conv.nativeSessionId);
      const archiveStat = await statOrNull(archivePath);
      // Transcripts only grow, so equal size plus an mtime at least as new means
      // the archive already holds these bytes. The millisecond of slack absorbs
      // utimes rounding: filesystems keep sub-millisecond mtimes that a
      // Date-based utimes call cannot reproduce exactly.
      if (archiveStat && archiveStat.size === nativeStat.size && archiveStat.mtimeMs + 1 >= nativeStat.mtimeMs) {
        return 'skipped';
      }
      await copyAtomic(nativePath, archivePath, nativeStat.mtime, nativeStat.atime);
      return 'archived';
    } catch (err) {
      log.warn(`[transcript-archive] archive failed for ${provider}/${conv.nativeSessionId}: ${(err as Error).message}`);
      return 'error';
    }
  }

  async function restore(provider: string, conv: ArchiveTarget): Promise<boolean> {
    try {
      const nativePath = await nativePathFor(provider, conv);
      if (!nativePath) return false;
      const nativeStat = await statOrNull(nativePath);
      const archivePath = transcriptArchivePath(dataDir, provider, conv.nativeSessionId);
      const archiveStat = await statOrNull(archivePath);
      if (!archiveStat) return false;
      // Restore when the provider purged the file, and also when it truncated or
      // rotated it — the longer transcript is the truthful one.
      if (nativeStat && nativeStat.size >= archiveStat.size) return false;
      await copyAtomic(archivePath, nativePath, archiveStat.mtime, archiveStat.atime);
      log.log(
        `[transcript-archive] restored ${provider}/${conv.nativeSessionId} (${archiveStat.size} bytes) → ${nativePath}`,
      );
      return true;
    } catch (err) {
      log.warn(`[transcript-archive] restore failed for ${provider}/${conv.nativeSessionId}: ${(err as Error).message}`);
      return false;
    }
  }

  async function sweep(rows: ConversationRow[]): Promise<{ archived: number; skipped: number; errors: number }> {
    let archived = 0;
    let skipped = 0;
    let errors = 0;
    for (const row of rows) {
      if (!row.native_session_id) continue;
      const cwd = resolveCwd?.(row);
      if (!cwd) continue;
      const outcome = await archive(row.provider, { cwd, nativeSessionId: row.native_session_id });
      if (outcome === 'archived') archived += 1;
      else if (outcome === 'skipped') skipped += 1;
      else if (outcome === 'error') errors += 1;
      // Yield between conversations: the sweep runs at boot beside turn resume
      // and must never hold the event loop.
      await new Promise((resolve) => setImmediate(resolve));
    }
    log.log(`[transcript-archive] sweep done: archived ${archived}, skipped ${skipped}, errors ${errors}`);
    return { archived, skipped, errors };
  }

  return { archive, restore, sweep };
}

/** Conversations worth sweeping: anything with a provider session on disk. */
export function conversationsForSweep(db: {
  prepare: (sql: string) => { all: () => unknown[] };
}): ConversationRow[] {
  return db
    .prepare("SELECT * FROM conversations WHERE native_session_id IS NOT NULL AND native_session_id != ''")
    .all() as ConversationRow[];
}

/** Ten years: long enough that the purge never fires in practice. */
export const CLAUDE_RETENTION_DAYS = 3650;

/**
 * Belt and braces to the archive above: tell Claude Code itself not to delete
 * session files. Read-parse-merge-write so every other key in settings.json
 * survives, and only write when the current value is missing or shorter than
 * what we need.
 */
export async function ensureClaudeTranscriptRetention(
  configDir: string = process.env.CLAUDE_CONFIG_DIR?.trim() || proClaudeConfigDir(),
  log: Pick<Console, 'log' | 'warn'> = console,
): Promise<'written' | 'present' | 'error'> {
  const settingsPath = path.join(configDir, 'settings.json');
  try {
    let settings: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(settingsPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        // Someone's hand-edit is not something we should overwrite.
        log.warn(`[transcript-archive] ${settingsPath} is not a JSON object; leaving it alone`);
        return 'error';
      }
      settings = parsed as Record<string, unknown>;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code && code !== 'ENOENT') throw err;
      if (!code) {
        log.warn(`[transcript-archive] ${settingsPath} is not valid JSON; leaving it alone`);
        return 'error';
      }
    }
    const current = settings.cleanupPeriodDays;
    if (typeof current === 'number' && current >= CLAUDE_RETENTION_DAYS) return 'present';
    settings.cleanupPeriodDays = CLAUDE_RETENTION_DAYS;
    await fs.mkdir(configDir, { recursive: true });
    const tmp = path.join(configDir, `.settings.json.${process.pid}.tmp`);
    await fs.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, settingsPath);
    log.log(`[transcript-archive] set cleanupPeriodDays=${CLAUDE_RETENTION_DAYS} in ${settingsPath}`);
    return 'written';
  } catch (err) {
    log.warn(`[transcript-archive] could not set Claude retention: ${(err as Error).message}`);
    return 'error';
  }
}
