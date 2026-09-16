import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { resolveProjectFileLink } from '../files/projectFileLinks.js';
import { loginHome } from '../homes.js';
import { serveMarkdownImage } from './markdownImage.js';

/**
 * File Manager API (owner/consultant only). Browses/edits files under a small
 * set of named roots. Paths are relative, forward-slash, validated by
 * safeResolve on every endpoint. Reads/writes follow symlinks by design (this
 * is a single-user box and a 'system' root exists anyway); delete is the
 * exception — it lstats and unlinks, never following a link.
 */

const MAX_READ_BYTES = 2 * 1024 * 1024;

const WriteSchema = z.object({
  root: z.string().min(1),
  path: z.string(),
  content: z.string().max(5_000_000),
  expectedMtime: z.number().optional(),
});
const MkdirSchema = z.object({ root: z.string().min(1), path: z.string() });
const RenameSchema = z.object({ root: z.string().min(1), from: z.string(), to: z.string() });
const DeleteSchema = z.object({
  root: z.string().min(1),
  path: z.string(),
  recursive: z.boolean().optional(),
});

interface FileEntry {
  name: string;
  kind: 'dir' | 'file' | 'other';
  size: number | null;
  mtime: number | null;
}

const PROJECT_ROOT_PREFIX = 'project:';

export function createFilesRouter(ctx: AppContext): Router {
  const router = express.Router();

  // Lazy: ctx.config is read per-request, not at mount time, matching the rest
  // of the routers (some tests construct partial contexts without config).
  let rootsCache: { roots: { id: string; label: string; path: string }[]; byId: Map<string, string> } | null = null;
  function rootTable() {
    if (!rootsCache) {
      const roots = [
        { id: 'home', label: 'Home', path: loginHome() },
        { id: 'source', label: 'Platform source', path: ctx.config.sourceDir },
        { id: 'data', label: 'App data', path: ctx.config.dataDir },
        { id: 'system', label: 'System', path: '/' },
      ];
      rootsCache = { roots, byId: new Map(roots.map((r) => [r.id, path.resolve(r.path)])) };
    }
    return rootsCache;
  }

  /** Named global roots, plus a project-scoped root that honors custom folders. */
  function rootPath(rootId: string): string | null {
    const named = rootTable().byId.get(rootId);
    if (named) return named;
    if (!rootId.startsWith(PROJECT_ROOT_PREFIX)) return null;
    const projectId = rootId.slice(PROJECT_ROOT_PREFIX.length);
    if (!projectId) return null;
    const project = ctx.db.prepare('SELECT slug, root_dir FROM projects WHERE id = ?').get(projectId) as
      | { slug: string; root_dir: string | null }
      | undefined;
    if (!project) return null;
    return path.resolve(project.root_dir ?? path.join(ctx.config.dataDir, 'workspaces', 'projects', project.slug));
  }

  // Members never see the file manager.
  router.use((req, res, next) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    next();
  });

  /**
   * Resolve a relative path inside a named root to an absolute path, or null
   * if the root id is unknown or the path is unsafe (null bytes, absolute, or
   * a normalized form escaping the root). '' means the root itself.
   */
  function safeResolve(rootId: string, relPath: string): string | null {
    const rootAbs = rootPath(rootId);
    if (!rootAbs) return null;
    if (relPath.includes('\0')) return null;
    if (path.isAbsolute(relPath)) return null;
    const abs = path.resolve(rootAbs, relPath);
    if (rootAbs === path.sep) return abs; // '/' contains every resolved path
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
    return abs;
  }

  function queryTarget(req: express.Request): string | null {
    const root = typeof req.query.root === 'string' ? req.query.root : '';
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    return safeResolve(root, rel);
  }

  router.get('/roots', (_req, res) => {
    const { roots, byId } = rootTable();
    res.json({ ok: true, roots: roots.map((r) => ({ id: r.id, label: r.label, path: byId.get(r.id)! })) });
  });

  router.get('/resolve-link', (req, res) => {
    const root = typeof req.query.root === 'string' ? req.query.root : '';
    const target = typeof req.query.target === 'string' ? req.query.target : '';
    if (!root.startsWith(PROJECT_ROOT_PREFIX)) {
      res.status(400).json({ ok: false, error: 'File links can only open inside a project' });
      return;
    }
    const rootAbs = rootPath(root);
    if (!rootAbs) {
      res.status(404).json({ ok: false, error: 'Project folder not found' });
      return;
    }
    const result = resolveProjectFileLink(rootAbs, target);
    if (!result.ok) {
      const status = result.reason === 'outside' ? 403 : result.reason === 'invalid' ? 400 : 404;
      const error = result.reason === 'outside'
        ? 'That link points outside this project'
        : result.reason === 'not-file'
          ? "That link doesn't point to a file or folder"
          : result.reason === 'missing'
            ? 'File not found in this project'
            : 'Invalid local file link';
      res.status(status).json({ ok: false, error });
      return;
    }
    res.json({ ok: true, file: result });
  });

  router.get('/list', (req, res) => {
    const abs = queryTarget(req);
    if (!abs) {
      res.status(400).json({ ok: false, error: 'Invalid root or path' });
      return;
    }
    let names: string[];
    try {
      names = fs.readdirSync(abs);
    } catch {
      res.status(404).json({ ok: false, error: 'not-found' });
      return;
    }
    // Symlinks classify by their target; broken links, sockets/fifos and
    // per-entry stat errors (EACCES/ENOENT) degrade to 'other', never failing
    // the whole listing.
    const entries: FileEntry[] = names.map((name) => {
      try {
        const st = fs.statSync(path.join(abs, name));
        const kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
        return { name, kind, size: st.size, mtime: st.mtimeMs };
      } catch {
        return { name, kind: 'other', size: null, mtime: null };
      }
    });
    entries.sort((a, b) => {
      const ad = a.kind === 'dir' ? 0 : 1;
      const bd = b.kind === 'dir' ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    res.json({ ok: true, entries });
  });

  router.get('/read', (req, res) => {
    const abs = queryTarget(req);
    if (!abs) {
      res.status(400).json({ ok: false, error: 'Invalid root or path' });
      return;
    }
    if (serveMarkdownImage(res, abs, req.query.image)) return;
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      res.status(404).json({ ok: false, error: 'not-found' });
      return;
    }
    if (!st.isFile()) {
      res.status(404).json({ ok: false, error: 'not-found' });
      return;
    }
    if (st.size > MAX_READ_BYTES) {
      res.status(413).json({ ok: false, error: 'too-large', size: st.size });
      return;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
      return;
    }
    if (buf.subarray(0, 8192).includes(0)) {
      res.status(415).json({ ok: false, error: 'binary', size: st.size });
      return;
    }
    res.json({ ok: true, content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs });
  });

  router.put('/write', (req, res) => {
    const body = WriteSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid write' });
      return;
    }
    const abs = safeResolve(body.data.root, body.data.path);
    if (!abs) {
      res.status(400).json({ ok: false, error: 'Invalid root or path' });
      return;
    }
    let existing: fs.Stats | null = null;
    try {
      existing = fs.statSync(abs);
    } catch {
      existing = null;
    }
    if (existing && !existing.isFile()) {
      res.status(400).json({ ok: false, error: 'not-a-file' });
      return;
    }
    if (existing && body.data.expectedMtime !== undefined && existing.mtimeMs !== body.data.expectedMtime) {
      res.status(409).json({ ok: false, error: 'conflict', mtime: existing.mtimeMs });
      return;
    }
    // New files are allowed, but only into a directory that already exists.
    let parentStat: fs.Stats | null = null;
    try {
      parentStat = fs.statSync(path.dirname(abs));
    } catch {
      parentStat = null;
    }
    if (!parentStat?.isDirectory()) {
      res.status(400).json({ ok: false, error: 'no-parent' });
      return;
    }
    try {
      fs.writeFileSync(abs, body.data.content, 'utf8');
      res.json({ ok: true, mtime: fs.statSync(abs).mtimeMs });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.post('/mkdir', (req, res) => {
    const body = MkdirSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid mkdir' });
      return;
    }
    const abs = safeResolve(body.data.root, body.data.path);
    if (!abs) {
      res.status(400).json({ ok: false, error: 'Invalid root or path' });
      return;
    }
    try {
      fs.mkdirSync(abs, { recursive: true });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.post('/rename', (req, res) => {
    const body = RenameSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid rename' });
      return;
    }
    const from = safeResolve(body.data.root, body.data.from);
    const to = safeResolve(body.data.root, body.data.to);
    if (!from || !to || from === rootPath(body.data.root)) {
      res.status(400).json({ ok: false, error: 'Invalid root or path' });
      return;
    }
    // Existence check then rename is a TOCTOU race: a target created in the
    // gap is silently replaced. Accepted on this single-user box (an atomic
    // link-then-unlink alternative would not work for directories).
    try {
      fs.lstatSync(to);
      res.status(409).json({ ok: false, error: 'exists' });
      return;
    } catch {
      /* target free — proceed */
    }
    try {
      fs.renameSync(from, to);
      res.json({ ok: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ ok: false, error: 'not-found' });
        return;
      }
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.post('/delete', (req, res) => {
    const body = DeleteSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid delete' });
      return;
    }
    const abs = safeResolve(body.data.root, body.data.path);
    if (!abs || abs === rootPath(body.data.root)) {
      // Deleting the root itself is always refused.
      res.status(400).json({ ok: false, error: 'Invalid root or path' });
      return;
    }
    // lstat: symlinks are unlinked, never followed.
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      res.status(404).json({ ok: false, error: 'not-found' });
      return;
    }
    try {
      if (st.isDirectory()) {
        if (body.data.recursive) {
          fs.rmSync(abs, { recursive: true });
        } else {
          fs.rmdirSync(abs);
        }
      } else {
        fs.unlinkSync(abs);
      }
      res.json({ ok: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
        res.status(400).json({ ok: false, error: 'not-empty' });
        return;
      }
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  return router;
}
