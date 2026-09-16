import crypto from 'node:crypto';
import fs from 'node:fs';
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { deleteObject, putHtml, putObject, type R2Config } from '../pages/r2.js';
import { EMPTY_BRAND, PageBrandSchema, readPageBrand, writePageBrand } from '../pages/brand.js';
import {
  deleteFont,
  FONT_FORMATS,
  FONT_MAX_BYTES,
  FontUploadSchema,
  fontExtension,
  fontObjectKey,
  getFont,
  insertFont,
  listFonts,
  looksLikeFont,
  newFontId,
  safeFileName,
} from '../pages/fonts.js';
import { createPageThumbnails, type PageThumbnails } from '../pages/thumbnails.js';

/**
 * Pages API — standalone public HTML pages an agent publishes to a Cloudflare R2
 * bucket (see 0019_pages.sql). Each page is one R2 object at key `p/<slug>`,
 * served at `${publicBase}/p/<slug>`. Rows hold only metadata; the HTML lives in
 * R2. Publishing is disabled unless config.pages is set (Cloudflare creds).
 *
 * Published HTML is public to anyone with its random link. The metadata list
 * and delete action are shared across every known user; create/update are
 * agent-driven through publish_page. Creator attribution is informational and
 * does not change those access rules. There is no member gate because the
 * identity gate on /api already authorized the caller, and an agent owned by a
 * member must still be able to publish.
 */

const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MiB

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  html: z.string().optional(),
  pageId: z.string().optional(),
  projectId: z.string().optional(),
  conversationId: z.string().optional(),
});

const PatchSchema = z.object({
  pinned: z.boolean(),
});

interface PageRow {
  id: string;
  slug: string;
  title: string;
  project_id: string | null;
  conversation_id: string | null;
  creator_user_id: number | null;
  pin_order: number | null;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

interface PageListRow extends PageRow {
  project_name: string | null;
  creator_display_name: string | null;
}

// The random-slug alphabet: unambiguous lowercase letters + digits.
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SLUG_LEN = 26;

// Uniform 26-char slug over a 36-char alphabet via rejection sampling: reject
// bytes in the biased tail (>= 252) so each accepted byte maps evenly mod 36.
function randomSlug(): string {
  const max = Math.floor(256 / SLUG_ALPHABET.length) * SLUG_ALPHABET.length; // 252
  let out = '';
  while (out.length < SLUG_LEN) {
    const bytes = crypto.randomBytes(SLUG_LEN);
    for (const b of bytes) {
      if (b >= max) continue;
      out += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
      if (out.length === SLUG_LEN) break;
    }
  }
  return out;
}

export function createPagesRouter(
  ctx: AppContext,
  options: { thumbnails?: PageThumbnails } = {},
): Router {
  const { db, config } = ctx;
  const thumbnails = options.thumbnails ?? createPageThumbnails({
    dataDir: config?.dataDir,
    // Captures render arbitrary published HTML, so they run on the browser VM
    // rather than in a browser on this host (see pages/thumbnails.ts).
    browser: {
      baseUrl: config?.veneerBrowserUrl ?? null,
      identityFile: config?.veneerBrowserIdentityFile ?? null,
      lanUrl: config?.veneerBrowserLanUrl ?? null,
      lanCaFile: config?.veneerBrowserLanCa ?? null,
    },
  });
  const router = express.Router();

  // NOTE: HTML bodies can reach ~2 MiB, above the api router's default 1mb json
  // limit. Body parsing happens at the api-router level (before this sub-router
  // runs), so the large-limit routing lives there — POST /pages is directed to
  // the 8mb parser alongside /files/write (see createApiRouter).

  // ── brand defaults ───────────────────────────────────────────────────────
  // Client brand colors/font for published pages and apps (Settings →
  // Appearance), fed to the agent as styling guidance each turn (see
  // pagesGuidance in materialize.ts).
  // Declared before the routes below so '/brand' can never be captured by the
  // DELETE '/:id' wildcard. Everyone reads them (the guidance needs them); only
  // owner/consultant may write (a Settings-screen surface).
  router.get('/brand', (_req, res) => {
    res.json({ ok: true, brand: readPageBrand(db) ?? EMPTY_BRAND });
  });

  router.put('/brand', (req, res) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    const parsed = PageBrandSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid brand' });
      return;
    }
    // Store the full shape (empty strings for unset fields) so reads are stable.
    const brand = { ...EMPTY_BRAND, ...parsed.data };
    writePageBrand(db, brand);
    res.json({ ok: true, brand });
  });

  // ── custom fonts ─────────────────────────────────────────────────────────
  // Licensed font files an owner uploads so pages can use a brand typeface that
  // Google Fonts does not carry. Bytes go to the SAME R2 bucket as pages under
  // `f/<id>/<file>` — outside the `p/` prefix the expiry rule watches, so they
  // never expire, and same-origin with pages, so no CORS setup is needed.
  // Declared before '/:id' for the same reason as '/brand' above.
  const requireFontAdmin = (req: Request, res: Response, next: () => void): void => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    next();
  };

  function r2Config(): R2Config | null {
    return config.pages
      ? { accountId: config.pages.accountId, apiToken: config.pages.apiToken, bucket: config.pages.bucket }
      : null;
  }

  // Everyone reads the library: the styling guidance and the Appearance preview
  // both need it. `configured` lets the UI explain itself instead of erroring.
  router.get('/fonts', (_req, res) => {
    res.json({ ok: true, fonts: listFonts(db), configured: Boolean(config.pages) });
  });

  const parseFontBody = express.raw({ type: '*/*', limit: FONT_MAX_BYTES });

  router.post(
    '/fonts',
    requireFontAdmin,
    (req, res, next) => {
      parseFontBody(req, res, (error) => {
        if ((error as { type?: string } | undefined)?.type === 'entity.too.large') {
          res.status(413).json({ ok: false, error: 'Font file exceeds the 2 MB limit' });
          return;
        }
        if (error) {
          next(error);
          return;
        }
        next();
      });
    },
    (req, res) => {
      const r2 = r2Config();
      if (!r2 || !config.pages) {
        res.status(503).json({ ok: false, error: 'Font hosting needs page publishing to be configured' });
        return;
      }
      const parsed = FontUploadSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: 'Family, weight, style, and file name are required' });
        return;
      }
      const bytes = req.body as unknown;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        res.status(400).json({ ok: false, error: 'Font file is empty' });
        return;
      }
      // Check the extension the caller actually sent: safeFileName() defaults an
      // unknown extension to .woff2, which would otherwise wave a .svg through.
      const ext = fontExtension(parsed.data.fileName);
      if (!ext) {
        res.status(415).json({ ok: false, error: 'Font must be a .woff2, .woff, .ttf, or .otf file' });
        return;
      }
      const fileName = safeFileName(parsed.data.fileName);
      if (!looksLikeFont(bytes, ext)) {
        res.status(400).json({ ok: false, error: `That file is not a valid .${ext} font` });
        return;
      }

      const id = newFontId();
      const objectKey = fontObjectKey(id, fileName);
      const contentType = FONT_FORMATS[ext]!.contentType;
      void (async () => {
        await putObject(r2, objectKey, bytes, contentType);
        const font = insertFont(db, {
          id,
          family: parsed.data.family,
          weight: parsed.data.weight,
          style: parsed.data.style,
          fileName,
          contentType,
          sizeBytes: bytes.length,
          objectKey,
          publicUrl: `${config.pages!.publicBase}/${objectKey}`,
        });
        res.json({ ok: true, font });
      })().catch((err: Error) => res.status(502).json({ ok: false, error: err.message }));
    },
  );

  router.delete('/fonts/:id', requireFontAdmin, (req, res) => {
    const font = getFont(db, String(req.params.id ?? ''));
    if (!font) {
      res.status(404).json({ ok: false, error: 'Font not found' });
      return;
    }
    void (async () => {
      const r2 = r2Config();
      // Drop the row even when R2 is unreachable-by-config; a stray object is
      // harmless and invisible, while a stuck row would keep breaking pages.
      if (r2) await deleteObject(r2, font.objectKey);
      deleteFont(db, font.id);
      res.json({ ok: true });
    })().catch((err: Error) => res.status(502).json({ ok: false, error: err.message }));
  });

  const getPage = db.prepare(
    `SELECT *
     FROM pages
     WHERE id = ?
       AND COALESCE(expires_at, datetime(updated_at, '+7 days')) > datetime('now')`,
  );

  function pageRow(id: string): PageRow | undefined {
    return getPage.get(id) as PageRow | undefined;
  }

  function urlFor(slug: string): string {
    // publicBase is present whenever pages are configured; fall back to a
    // relative path if a listing is somehow requested while unconfigured.
    return `${config.pages?.publicBase ?? ''}/p/${slug}`;
  }

  function keyFor(slug: string): string {
    return `p/${slug}`;
  }

  function expiryOf(p: PageRow): string {
    if (p.expires_at) return p.expires_at;
    const updated = p.updated_at.includes('T') ? p.updated_at : `${p.updated_at.replace(' ', 'T')}Z`;
    return new Date(new Date(updated).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  // camelCase view with resolved URL plus project and creator metadata.
  function pageView(
    p: PageRow,
    projectName: string | null,
    creatorDisplayName: string | null,
  ): Record<string, unknown> {
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      url: urlFor(p.slug),
      projectId: p.project_id,
      projectName,
      conversationId: p.conversation_id,
      creator: {
        id: p.creator_user_id,
        displayName: creatorDisplayName ?? 'Unknown user',
      },
      pinOrder: p.pin_order,
      sizeBytes: p.size_bytes,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      expiresAt: expiryOf(p),
    };
  }

  function projectNameOf(projectId: string | null): string | null {
    if (!projectId) return null;
    const r = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined;
    return r?.name ?? null;
  }

  function creatorNameOf(userId: number | null): string | null {
    if (userId === null) return null;
    const r = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as
      | { display_name: string }
      | undefined;
    return r?.display_name ?? null;
  }

  function pageViewOf(p: PageRow): Record<string, unknown> {
    return pageView(p, projectNameOf(p.project_id), creatorNameOf(p.creator_user_id));
  }

  // ── list ───────────────────────────────────────────────────────────────────
  router.get('/', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null;
    const rows = (
      projectId
        ? db
            .prepare(
              `SELECT p.*, pr.name AS project_name, u.display_name AS creator_display_name
               FROM pages p
               LEFT JOIN projects pr ON pr.id = p.project_id
               LEFT JOIN users u ON u.id = p.creator_user_id
               WHERE p.project_id = ?
                 AND COALESCE(p.expires_at, datetime(p.updated_at, '+7 days')) > datetime('now')
               ORDER BY (p.pin_order IS NULL), p.pin_order, p.updated_at DESC, p.id`,
            )
            .all(projectId)
        : db
            .prepare(
              `SELECT p.*, pr.name AS project_name, u.display_name AS creator_display_name
               FROM pages p
               LEFT JOIN projects pr ON pr.id = p.project_id
               LEFT JOIN users u ON u.id = p.creator_user_id
               WHERE COALESCE(p.expires_at, datetime(p.updated_at, '+7 days')) > datetime('now')
               ORDER BY
                 (p.project_id IS NULL),
                 pr.sort_order,
                 pr.created_at,
                 p.project_id,
                 (p.pin_order IS NULL),
                 p.pin_order,
                 p.updated_at DESC,
                 p.id`,
            )
            .all()
    ) as PageListRow[];
    res.json({ ok: true, pages: rows.map((r) => pageView(r, r.project_name, r.creator_display_name)) });
  });

  // ── create or update ─────────────────────────────────────────────────────
  router.post('/', (req, res) => {
    if (!config.pages) {
      res.status(503).json({
        ok: false,
        error: 'pages_not_configured',
        message: 'Pages publishing is not configured (missing Cloudflare credentials)',
      });
      return;
    }
    const r2: R2Config = { accountId: config.pages.accountId, apiToken: config.pages.apiToken, bucket: config.pages.bucket };
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid page' });
      return;
    }
    const { title, html, pageId, projectId, conversationId } = parsed.data;

    if (html !== undefined && Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      res.status(413).json({ ok: false, error: 'HTML too large (max 2MB)' });
      return;
    }

    void (async () => {
      // ── update in place ───────────────────────────────────────────────────
      if (pageId) {
        const existing = pageRow(pageId);
        if (!existing) {
          res.status(404).json({ ok: false, error: 'Page not found' });
          return;
        }
        if (html !== undefined) {
          const finishPublish = ctx.pageExpiry?.beginPublish(existing.id) ?? (() => undefined);
          try {
            await putHtml(r2, keyFor(existing.slug), html);
            db.prepare(
              `UPDATE pages
               SET title = ?,
                   size_bytes = ?,
                   updated_at = datetime('now'),
                   expires_at = datetime('now', '+7 days')
               WHERE id = ?`,
            ).run(title, Buffer.byteLength(html, 'utf8'), existing.id);
          } finally {
            finishPublish();
          }
          thumbnails.capture(existing.id, urlFor(existing.slug), { force: true });
        } else {
          // A metadata-only rename does not rewrite the public R2 object, so it
          // must not extend the public object's retention window.
          db.prepare('UPDATE pages SET title = ? WHERE id = ?').run(title, existing.id);
        }
        const fresh = pageRow(existing.id)!;
        res.json({ ok: true, page: pageViewOf(fresh) });
        return;
      }

      // ── create ────────────────────────────────────────────────────────────
      if (html === undefined) {
        res.status(400).json({ ok: false, error: 'html is required to create a page' });
        return;
      }
      // Derive project from the conversation when not given explicitly.
      let resolvedProjectId = projectId ?? null;
      if (!resolvedProjectId && conversationId) {
        const conv = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(conversationId) as
          | { project_id: string | null }
          | undefined;
        resolvedProjectId = conv?.project_id ?? null;
      }
      const id = crypto.randomUUID();
      const slug = randomSlug();
      await putHtml(r2, keyFor(slug), html);
      db.prepare(
        `INSERT INTO pages
          (id, slug, title, project_id, conversation_id, creator_user_id, size_bytes, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 days'))`,
      ).run(
        id,
        slug,
        title,
        resolvedProjectId,
        conversationId ?? null,
        req.user!.id,
        Buffer.byteLength(html, 'utf8'),
      );
      const fresh = pageRow(id)!;
      thumbnails.capture(id, urlFor(slug), { force: true });
      res.json({ ok: true, page: pageViewOf(fresh) });
    })().catch((err: Error) => res.status(502).json({ ok: false, error: err.message }));
  });

  // ── thumbnail ─────────────────────────────────────────────────────────────
  // Best-effort PNG preview captured at publish time; the chat artifact card
  // falls back to its placeholder on 404. A miss lazily queues a capture so
  // pages published before this feature gain a thumbnail on demand.
  router.get('/:id/thumbnail', (req, res) => {
    const page = pageRow(req.params.id);
    if (!page) {
      res.status(404).json({ ok: false, error: 'Page not found' });
      return;
    }
    const file = thumbnails.fileFor(page.id);
    if (!file || !fs.existsSync(file)) {
      if (config.pages) thumbnails.capture(page.id, urlFor(page.slug));
      res.status(404).json({ ok: false, error: 'No thumbnail' });
      return;
    }
    // Mutable per publish (like the client logo), so never cache-forever.
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('png').sendFile(file);
  });

  // ── pin or unpin ──────────────────────────────────────────────────────────
  router.patch('/:id', (req, res) => {
    const page = pageRow(req.params.id);
    if (!page) {
      res.status(404).json({ ok: false, error: 'Page not found' });
      return;
    }
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid patch' });
      return;
    }
    if (parsed.data.pinned) {
      db.prepare(
        `UPDATE pages
         SET pin_order = COALESCE((SELECT MIN(pin_order) FROM pages), 1) - 1
         WHERE id = ?`,
      ).run(page.id);
    } else {
      db.prepare('UPDATE pages SET pin_order = NULL WHERE id = ?').run(page.id);
    }
    res.json({ ok: true, page: pageViewOf(pageRow(page.id)!) });
  });

  // ── delete ─────────────────────────────────────────────────────────────────
  router.delete('/:id', (req, res) => {
    const page = pageRow(req.params.id);
    if (!page) {
      res.status(404).json({ ok: false, error: 'Page not found' });
      return;
    }
    void (async () => {
      if (config.pages) {
        const r2: R2Config = { accountId: config.pages.accountId, apiToken: config.pages.apiToken, bucket: config.pages.bucket };
        await deleteObject(r2, keyFor(page.slug));
      }
      db.prepare('DELETE FROM pages WHERE id = ?').run(page.id);
      res.json({ ok: true });
    })().catch((err: Error) => res.status(502).json({ ok: false, error: err.message }));
  });

  return router;
}
