import fs from 'node:fs';
import express, { type Request, type Response, type Router } from 'express';
import type { AppContext } from '../context.js';
import {
  ensureFileSyncBackfill,
  getGeneratedFile,
  listGeneratedFiles,
  staleConversationCount,
  type GeneratedFileView,
} from '../files/generatedFiles.js';
import { inlineContentSecurityPolicy, inlineContentType } from './inlineContentType.js';
import { serveMarkdownImage } from './markdownImage.js';

/**
 * Files page API (migration 0014). The registry (files/generatedFiles.ts) is
 * kept fresh eagerly on every turn_done; GET / also runs the lazy catch-up sync
 * so historical chats and anything missed while web was down get backfilled.
 * Chat files follow the source chat's Team/Private visibility. A hidden id is a
 * 404, not a 403.
 */

const PREVIEW_BYTES = 512 * 1024;

export function createGeneratedFilesRouter(ctx: AppContext): Router {
  const router = express.Router();

  // Resolve the row + a fresh on-disk stat, or send a 404. Shared by the by-id
  // routes: unknown/foreign-to-member/missing-on-disk all collapse to "not
  // found" so we never leak the existence of another user's file.
  function fileFor(req: Request, res: Response): { view: GeneratedFileView; path: string } | null {
    const row = getGeneratedFile(ctx, req.user!, String(req.params.id));
    if (!row) {
      res.status(404).json({ ok: false, error: 'File not found' });
      return null;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(row.path);
    } catch {
      res.status(404).json({ ok: false, error: 'File not found' });
      return null;
    }
    return {
      path: row.path,
      view: {
        id: row.id,
        name: row.name,
        path: row.path,
        size: st.size,
        mtime: Math.round(st.mtimeMs),
        source: row.source,
        conversationId: row.conversation_id,
        conversationTitle: row.conversation_title,
        projectId: row.project_id,
        projectName: row.project_name,
        firstSeenAt: row.first_seen_at,
      },
    };
  }

  // GET / — answer straight from the registry (fast) and kick off the
  // background sweep that scans any stale conversations. pendingSync > 0 tells
  // the client to poll while the sweep works (scoped to the caller for members;
  // the global count for owner/consultant). Never blocks on a transcript scan.
  router.get('/', (req, res) => {
    void ensureFileSyncBackfill(ctx);
    try {
      const files = listGeneratedFiles(ctx, req.user!);
      const pendingSync = staleConversationCount(ctx, req.user!);
      res.json({ ok: true, files, pendingSync });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // GET /:id/download[/:fileName] — attachment by default; ?inline=1 drops the
  // Content-Disposition entirely so the browser renders it (image previews).
  // The optional filename segment gives browsers a useful URL fallback if an
  // intermediary strips Content-Disposition. The registry name remains
  // authoritative for the response header.
  router.get(['/:id/download', '/:id/download/:fileName'], (req, res) => {
    const found = fileFor(req, res);
    if (!found) return;
    if (req.query.inline === '1') {
      const contentType = inlineContentType(found.path);
      if (contentType) res.setHeader('Content-Type', contentType);
      const csp = inlineContentSecurityPolicy(contentType);
      if (csp) res.setHeader('Content-Security-Policy', csp);
    } else {
      res.attachment(found.view.name);
    }
    res.sendFile(found.path);
  });

  // GET /:id/preview — capped text preview (NUL sniff → binary:true), mirroring
  // the per-chat file preview.
  router.get('/:id/preview', (req, res) => {
    const found = fileFor(req, res);
    if (!found) return;
    if (serveMarkdownImage(res, found.path, req.query.image)) return;
    const { view } = found;
    let buf: Buffer;
    try {
      // The file can vanish between fileFor's stat and this open (delete race).
      const fd = fs.openSync(found.path, 'r');
      try {
        buf = Buffer.alloc(Math.min(view.size, PREVIEW_BYTES));
        fs.readSync(fd, buf, 0, buf.length, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      res.status(404).json({ ok: false, error: 'File not found' });
      return;
    }
    if (buf.subarray(0, 8192).includes(0)) {
      res.json({ ok: true, file: view, binary: true });
      return;
    }
    res.json({ ok: true, file: view, content: buf.toString('utf8'), truncated: view.size > buf.length });
  });

  // DELETE /:id — remove the file from disk (never following a symlink) and its
  // registry row. A directory is refused (400); an already-gone file still
  // succeeds and drops the row.
  router.delete('/:id', (req, res) => {
    const row = getGeneratedFile(ctx, req.user!, String(req.params.id));
    const cannotDeleteAnotherUsersPrivateFile =
      row?.conversation_visibility === 'private' && row.conversation_user_id !== req.user!.id;
    if (!row || cannotDeleteAnotherUsersPrivateFile || (row.user_id !== req.user!.id && req.user!.role === 'member')) {
      res.status(404).json({ ok: false, error: 'File not found' });
      return;
    }
    try {
      const st = fs.lstatSync(row.path);
      if (st.isDirectory()) {
        res.status(400).json({ ok: false, error: 'Refusing to delete a directory' });
        return;
      }
      fs.unlinkSync(row.path); // file or symlink — never follows the link
    } catch (err) {
      // ENOENT: already gone — fall through and drop the row. Anything else is real.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        res.status(500).json({ ok: false, error: (err as Error).message });
        return;
      }
    }
    ctx.db.prepare('DELETE FROM generated_files WHERE id = ?').run(row.id);
    res.json({ ok: true });
  });

  return router;
}
