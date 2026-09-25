import { isEmployee } from '../bots/employeeAccess.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { canViewConversation, businessScopeSql, businessAgentSql, sameBusiness } from '../conversations/access.js';
import type { ConversationRow, GeneratedFileRow, UserRow } from '../db/db.js';

/**
 * Generated-files registry (migration 0014) — runs in the WEB process. The
 * runner's per-conversation transcript scan (providers/claude/sessionFiles.ts)
 * only knows about live chats; this module mirrors those detections into a
 * durable table so deliverables survive the chat that made them and can be
 * listed/downloaded/deleted from the Files page.
 *
 * Two feeds keep it fresh: an eager sync on every `turn_done` (wired in
 * index.ts) and a lazy catch-up (syncStaleConversations) the list route runs to
 * backfill historical chats and anything missed while web was down. Listing
 * prunes rows whose file has since been deleted, so the table self-corrects.
 */

/** The Files-page contract (camelCase). mtime is ms epoch; conversationTitle/projectName are null once the chat/project is gone. */
export interface GeneratedFileView {
  id: string;
  name: string;
  path: string;
  size: number;
  mtime: number;
  source: 'write' | 'bash';
  conversationId: string | null;
  conversationTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  firstSeenAt: string;
}

/** Parse sqlite's zone-less datetime('now') (UTC) into an epoch ms number. */
function sqliteUtcMs(value: string): number {
  return new Date(`${value.replace(' ', 'T')}Z`).getTime();
}

/**
 * Scan one conversation's transcript for deliverables and upsert them into the
 * registry. Silent no-op if the conversation is gone. The high-water mark is
 * read at the START of the sync and written at the end, so any activity during
 * the scan leaves files_synced_at behind last_active_at and re-marks the chat
 * stale (self-healing).
 */
export async function syncConversationFiles(ctx: AppContext, conversationId: string): Promise<void> {
  const { db, config, manager } = ctx;
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
    | ConversationRow
    | undefined;
  if (!row) return;

  const createdAtMs = sqliteUtcMs(row.created_at);
  // Read the high-water candidate up front: a turn that lands mid-scan bumps
  // last_active_at past this value, so we stay stale and re-sync next time.
  const syncedTo = row.last_active_at;

  const refs = await manager.listSessionFiles(conversationId);
  const sourceDir = fs.existsSync(config.sourceDir) ? fs.realpathSync(config.sourceDir) : path.resolve(config.sourceDir);
  const uploadsDir = path.join(config.dataDir, 'uploads');
  const canonicalUploads = fs.existsSync(uploadsDir) ? fs.realpathSync(uploadsDir) : path.resolve(uploadsDir);
  const upsert = db.prepare(
    `INSERT INTO generated_files (id, path, name, source, size, mtime_ms, user_id, conversation_id, project_id)
     VALUES (@id, @path, @name, @source, @size, @mtime_ms, @user_id, @conversation_id, @project_id)
     ON CONFLICT(path) DO UPDATE SET
       name = excluded.name,
       source = excluded.source,
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       user_id = excluded.user_id,
       conversation_id = excluded.conversation_id,
       project_id = excluded.project_id,
       last_seen_at = datetime('now')
     WHERE excluded.mtime_ms > generated_files.mtime_ms
        OR generated_files.conversation_id = excluded.conversation_id
        OR generated_files.conversation_id IS NULL`,
  );

  for (const ref of refs) {
    let st: fs.Stats;
    let canonicalPath: string;
    try {
      // Follow symlinks before applying exclusions so a transcript cannot
      // disguise a source/dependency/upload path behind an allowed-looking
      // alias. Broken links and vanished files are simply not deliverables.
      canonicalPath = fs.realpathSync(ref.path);
      st = fs.statSync(canonicalPath);
    } catch {
      continue; // named by the transcript but not on disk — skip
    }
    if (!st.isFile()) continue;
    // Bash detection is heuristic (a command can mention a pre-existing file), so
    // a bash hit must have been modified after the chat began to count.
    if (ref.source === 'bash' && st.mtimeMs < createdAtMs) continue;
    // Platform-dev agents run in the source checkout — their Write calls are
    // source edits, not deliverables. And never index tool/dependency droppings.
    if (canonicalPath === sourceDir || canonicalPath.startsWith(sourceDir + path.sep)) continue;
    if (canonicalPath.includes('/.claude/') || canonicalPath.includes('/node_modules/')) continue;
    // Chat attachments land in <dataDir>/uploads — those are the user's INPUT
    // files (a bash command mentioning one would pass the mtime check), not
    // something the agent generated.
    if (canonicalPath === canonicalUploads || canonicalPath.startsWith(canonicalUploads + path.sep)) continue;
    upsert.run({
      id: crypto.randomUUID(),
      path: canonicalPath,
      name: path.basename(canonicalPath),
      source: ref.source,
      size: st.size,
      mtime_ms: Math.round(st.mtimeMs),
      user_id: row.user_id,
      conversation_id: row.id,
      project_id: row.project_id,
    });
  }

  db.prepare('UPDATE conversations SET files_synced_at = ? WHERE id = ?').run(syncedTo, row.id);
}

const STALE = 'files_synced_at IS NULL OR last_active_at > files_synced_at';

/**
 * How many visible conversations still need a scan — drives the client's
 * "Indexing older chats…" hint and its polling.
 */
export function staleConversationCount(ctx: AppContext, user: UserRow, sourceId?: string): number {
  return (
    ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM conversations
         WHERE (visibility = 'team' OR user_id = ?) AND (${STALE}) AND ${businessScopeSql(user, 'conversations')} AND ${businessAgentSql(ctx.db, sourceId, 'conversations')}`,
      )
      .get(user.id) as { n: number }
  ).n;
}

// One background sweep per database at a time, keyed by the db handle so test
// contexts don't share state.
const activeSweeps = new WeakMap<object, Promise<void>>();

/**
 * Sweep every stale conversation (never synced, or touched since their last
 * sync) in the background, newest activity first. The list route fires this and
 * responds immediately from the registry — scanning a transcript can take
 * seconds, and blocking the response on that (worst case a whole-history
 * backfill) is what made the Files page slow to open. Re-entrant calls join the
 * in-flight sweep, which also lets tests await completion. A conversation whose
 * scan fails is skipped (left stale) so one bad transcript can't wedge the
 * sweep; an unreachable runner aborts it — the next list request retries.
 */
export function ensureFileSyncBackfill(ctx: AppContext): Promise<void> {
  const key = ctx.db as unknown as object;
  const active = activeSweeps.get(key);
  if (active) return active;
  const sweep = (async () => {
    const stale = ctx.db
      .prepare(`SELECT id FROM conversations WHERE ${STALE} ORDER BY last_active_at DESC`)
      .all() as { id: string }[];
    for (const { id } of stale) {
      try {
        await syncConversationFiles(ctx, id);
      } catch (err) {
        const message = (err as Error).message;
        console.warn(`[generated-files] sweep: sync failed for ${id}: ${message}`);
        if (message.includes('runner')) return; // runner unreachable — stop, don't spin
      }
    }
  })().finally(() => activeSweeps.delete(key));
  activeSweeps.set(key, sweep);
  return sweep;
}

interface GeneratedFileJoinRow extends GeneratedFileRow {
  conversation_title: string | null;
  conversation_visibility: ConversationRow['visibility'] | null;
  conversation_user_id: number | null;
  business_team_id: string | null;
  project_name: string | null;
}

const SELECT_JOIN =
  `SELECT g.*, c.title AS conversation_title, c.visibility AS conversation_visibility,
          c.user_id AS conversation_user_id, c.business_team_id, p.name AS project_name
     FROM generated_files g
     LEFT JOIN conversations c ON c.id = g.conversation_id
     LEFT JOIN projects p ON p.id = g.project_id`;

function toView(row: GeneratedFileJoinRow, size: number, mtimeMs: number): GeneratedFileView {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    size,
    mtime: mtimeMs,
    source: row.source,
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title,
    projectId: row.project_id,
    projectName: row.project_name,
    firstSeenAt: row.first_seen_at,
  };
}

/**
 * List registry files as views, pruning-as-we-go: a row whose file has vanished
 * from disk is DELETEd and omitted; a surviving row reports FRESH size/mtime.
 * Chat files follow chat visibility. Unlinked files keep the earlier behavior:
 * members see their own rows, while administrators can see all unlinked rows.
 */
export function listGeneratedFiles(ctx: AppContext, user: UserRow, sourceId?: string): GeneratedFileView[] {
  const { db } = ctx;
  const visibilityWhere = user.role === 'member'
    ? ` WHERE (c.visibility = 'team' OR c.user_id = ? OR (c.id IS NULL AND g.user_id = ?)) AND ${businessScopeSql(user)}`
    : ` WHERE (c.visibility = 'team' OR c.user_id = ? OR c.id IS NULL) AND ${businessScopeSql(user)}`;
  const visibilityParams = user.role === 'member' ? [user.id, user.id] : [user.id];
  const rows = db
    .prepare(`${SELECT_JOIN}${visibilityWhere} AND ${businessAgentSql(db, sourceId)} ORDER BY g.mtime_ms DESC`)
    .all(...visibilityParams) as GeneratedFileJoinRow[];
  const del = db.prepare('DELETE FROM generated_files WHERE id = ?');
  const views: GeneratedFileView[] = [];
  for (const row of rows) {
    let st: fs.Stats;
    try {
      st = fs.statSync(row.path);
    } catch {
      del.run(row.id); // gone from disk — drop the row
      continue;
    }
    views.push(toView(row, st.size, Math.round(st.mtimeMs)));
  }
  views.sort((a, b) => b.mtime - a.mtime);
  return views;
}

/**
 * Fetch one registry row with the same visibility rule as the list route.
 * Returns null for hidden rows. Does NOT touch disk.
 */
export function getGeneratedFile(ctx: AppContext, user: UserRow, id: string, sourceId?: string): GeneratedFileJoinRow | null {
  const { db } = ctx;
  const row = db.prepare(`${SELECT_JOIN} WHERE g.id = ?`).get(id) as GeneratedFileJoinRow | undefined;
  if (!row) return null;
  if (isEmployee(db, user.id) && !row.conversation_visibility) return null;
  if (!sameBusiness(db, sourceId, { user_id: row.conversation_user_id ?? row.user_id ?? -1, visibility: row.conversation_visibility ?? 'private', business_team_id: row.business_team_id })) return null;
  if (row.conversation_visibility) {
    if (
      row.conversation_user_id === null ||
      !canViewConversation(user, {
        id: row.conversation_id ?? undefined,
        user_id: row.conversation_user_id,
        visibility: row.conversation_visibility,
        business_team_id: row.business_team_id,
      }, db)
    ) {
      return null;
    }
  }
  if (!row.conversation_visibility && user.role === 'member' && row.user_id !== user.id) return null;
  return row;
}
