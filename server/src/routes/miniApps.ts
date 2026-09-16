import crypto from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  CloudflareMiniAppDeployer,
  miniAppScriptName,
  miniAppUrl,
  type MiniAppDeployment,
} from '../miniApps/cloudflare.js';
import type { LocalAppStatusView, MiniAppRow, MiniAppRuntime } from '../miniApps/types.js';
import { forgetMiniAppWrapper, markMiniAppWrapperCurrent } from '../miniApps/wrapperUpgrade.js';
import { removeMiniAppFromNavigation } from './navigation.js';

const MAX_SOURCE_BYTES = 1024 * 1024;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const PublishSchema = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(2).max(48).regex(SLUG).optional(),
  source: z.string().optional(),
  appId: z.string().uuid().optional(),
  projectId: z.string().optional(),
  conversationId: z.string().optional(),
  runtime: z.enum(['cloudflare', 'local']).optional(),
});

export function normalizeMiniAppSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

export function validateMiniAppSource(source: string): string | null {
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) return 'Source is too large (max 1MB)';
  if (!/export\s+(?:async\s+)?function\s+handle\s*\(/.test(source)) {
    return 'Source must export a function named handle(request, context)';
  }
  if (/\bimport\s*(?:\(|[\s{*])/.test(source)) {
    return 'Mini Apps v1 source must be self-contained and cannot import modules';
  }
  return null;
}

function cloudflareDeployment(row: MiniAppRow, source = row.source_text): MiniAppDeployment {
  return { id: row.id, slug: row.slug, scriptName: row.script_name, routeId: row.route_id, source };
}

export function createMiniAppsRouter(ctx: AppContext, options: { fetchImpl?: typeof fetch } = {}): Router {
  const { db, config } = ctx;
  const router = express.Router();
  const cloudflare = config?.miniApps ? new CloudflareMiniAppDeployer(config.miniApps, options.fetchImpl) : null;
  const publicOrigin = config?.appPublicOrigin ?? null;
  const getApp = db.prepare('SELECT * FROM mini_apps WHERE id = ?');

  function appRow(id: string): MiniAppRow | undefined {
    return getApp.get(id) as MiniAppRow | undefined;
  }

  // Mini Apps are team-wide: anyone may browse and run them, but publishing,
  // replacing, and deleting are administrative. Agent tool calls arrive as the
  // human they act for, so this gates publish_app the same way.
  function denyUnlessAdmin(req: Request, res: Response): boolean {
    const role = req.user?.role;
    if (role === 'owner' || role === 'consultant') return false;
    res.status(403).json({ ok: false, error: 'Only owners and consultants can manage Mini Apps' });
    return true;
  }

  function projectNameOf(projectId: string | null): string | null {
    if (!projectId) return null;
    return (db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined)?.name ?? null;
  }

  function appView(
    app: MiniAppRow,
    projectName: string | null,
    runtimeStatus: LocalAppStatusView | null = null,
  ): Record<string, unknown> {
    return {
      id: app.id,
      slug: app.slug,
      title: app.title,
      url: publicOrigin ? miniAppUrl(publicOrigin, app.slug) : `/tools/${app.slug}/`,
      runtime: app.runtime,
      runtimeStatus,
      status: app.status,
      lastError: app.last_error,
      projectId: app.project_id,
      projectName,
      conversationId: app.conversation_id,
      sourceSizeBytes: app.source_size_bytes,
      createdAt: app.created_at,
      updatedAt: app.updated_at,
      deployedAt: app.deployed_at,
    };
  }

  function requireRuntime(runtime: MiniAppRuntime): void {
    if (!publicOrigin) throw new Error('Mini App publishing requires VP_APPS_PUBLIC_ORIGIN');
    if (runtime === 'cloudflare' && !cloudflare) {
      throw new Error('Cloudflare app hosting is not configured (missing Workers credentials)');
    }
    if (runtime === 'local' && !ctx.appRunner) throw new Error('Local app hosting is not configured');
  }

  async function deployRuntime(runtime: MiniAppRuntime, app: MiniAppRow): Promise<string | null> {
    requireRuntime(runtime);
    if (runtime === 'cloudflare') {
      const deployment = await cloudflare!.deploy(cloudflareDeployment(app));
      markMiniAppWrapperCurrent(db, app.id);
      return deployment.routeId;
    }
    await ctx.appRunner!.deploy(app.id);
    forgetMiniAppWrapper(db, app.id);
    return null;
  }

  async function removeRuntime(runtime: MiniAppRuntime, app: MiniAppRow): Promise<void> {
    requireRuntime(runtime);
    if (runtime === 'cloudflare') await cloudflare!.remove(cloudflareDeployment(app));
    else await ctx.appRunner!.remove(app.id);
  }

  async function rollbackApp(previous: MiniAppRow, attemptedRuntime: MiniAppRuntime): Promise<void> {
    db.prepare(
      `UPDATE mini_apps SET title = ?, source_text = ?, source_size_bytes = ?, runtime = ?, route_id = ?,
       status = ?, last_error = ?, deployed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      previous.title,
      previous.source_text,
      previous.source_size_bytes,
      previous.runtime,
      previous.route_id,
      previous.status,
      previous.last_error,
      previous.deployed_at,
      previous.updated_at,
      previous.id,
    );
    if (attemptedRuntime !== previous.runtime) {
      const attempted = appRow(previous.id);
      if (attempted) await removeRuntime(attemptedRuntime, { ...attempted, runtime: attemptedRuntime });
    }
    if (previous.status === 'deployed') await deployRuntime(previous.runtime, previous);
  }

  router.get('/', (_req, res) => {
    void (async () => {
      const rows = db
        .prepare(
          `SELECT a.*, p.name AS project_name FROM mini_apps a
           LEFT JOIN projects p ON p.id = a.project_id
           ORDER BY a.updated_at DESC`,
        )
        .all() as (MiniAppRow & { project_name: string | null })[];
      const localIds = rows.filter((row) => row.runtime === 'local').map((row) => row.id);
      let runtimeStatuses: Record<string, LocalAppStatusView> = {};
      if (localIds.length && ctx.appRunner) {
        try {
          runtimeStatuses = await ctx.appRunner.statuses(localIds);
        } catch {
          runtimeStatuses = Object.fromEntries(
            localIds.map((id) => [id, { status: 'unavailable', error: 'Local app runner is unavailable', pid: null }]),
          );
        }
      }
      res.json({
        ok: true,
        configured: Boolean(publicOrigin),
        hosting: { cloudflare: Boolean(cloudflare), local: Boolean(publicOrigin && ctx.appRunner) },
        apps: rows.map((row) => appView(row, row.project_name, row.runtime === 'local' ? runtimeStatuses[row.id] ?? null : null)),
      });
    })().catch((error: Error) => res.status(500).json({ ok: false, error: error.message }));
  });

  router.post('/', (req, res) => {
    if (denyUnlessAdmin(req, res)) return;
    const parsed = PublishSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid mini app' });
      return;
    }
    const { title, source, appId, projectId, conversationId } = parsed.data;
    if (source !== undefined) {
      const sourceError = validateMiniAppSource(source);
      if (sourceError) {
        res.status(400).json({ ok: false, error: sourceError });
        return;
      }
    }

    void (async () => {
      if (appId) {
        const existing = appRow(appId);
        if (!existing) {
          res.status(404).json({ ok: false, error: 'Mini app not found' });
          return;
        }
        if (parsed.data.slug && parsed.data.slug !== existing.slug) {
          res.status(400).json({ ok: false, error: 'A mini app slug cannot change after publishing' });
          return;
        }
        const runtime = parsed.data.runtime ?? existing.runtime;
        try {
          requireRuntime(runtime);
          if (runtime !== existing.runtime) requireRuntime(existing.runtime);
        } catch (error) {
          res.status(503).json({ ok: false, error: 'apps_not_configured', message: (error as Error).message });
          return;
        }
        const nextSource = source ?? existing.source_text;
        db.prepare(
          `UPDATE mini_apps SET title = ?, source_text = ?, source_size_bytes = ?, runtime = ?,
           status = 'deploying', last_error = NULL, updated_at = datetime('now') WHERE id = ?`,
        ).run(title, nextSource, Buffer.byteLength(nextSource, 'utf8'), runtime, existing.id);

        try {
          const staged = appRow(existing.id)!;
          const routeId = await deployRuntime(runtime, staged);
          if (runtime !== existing.runtime) await removeRuntime(existing.runtime, existing);
          db.prepare(
            `UPDATE mini_apps SET route_id = ?, status = 'deployed', last_error = NULL,
             deployed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
          ).run(routeId, existing.id);
          const fresh = appRow(existing.id)!;
          res.json({ ok: true, app: appView(fresh, projectNameOf(fresh.project_id)) });
        } catch (error) {
          const message = error instanceof Error ? error.message : `${runtime} deployment failed`;
          try {
            await rollbackApp(existing, runtime);
          } catch (rollbackError) {
            db.prepare("UPDATE mini_apps SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ?").run(
              `${message}; rollback failed: ${(rollbackError as Error).message}`,
              existing.id,
            );
          }
          res.status(502).json({ ok: false, error: message });
        }
        return;
      }

      if (source === undefined) {
        res.status(400).json({ ok: false, error: 'source is required to create a mini app' });
        return;
      }
      const runtime = parsed.data.runtime ?? 'cloudflare';
      try {
        requireRuntime(runtime);
      } catch (error) {
        res.status(503).json({ ok: false, error: 'apps_not_configured', message: (error as Error).message });
        return;
      }
      const slug = parsed.data.slug ?? normalizeMiniAppSlug(title);
      if (slug.length < 2 || !SLUG.test(slug)) {
        res.status(400).json({ ok: false, error: 'Choose a slug with 2–48 lowercase letters, numbers, or hyphens' });
        return;
      }
      if (db.prepare('SELECT 1 FROM mini_apps WHERE slug = ?').get(slug)) {
        res.status(409).json({ ok: false, error: `A mini app already uses the slug "${slug}"` });
        return;
      }

      let resolvedProjectId = projectId ?? null;
      if (!resolvedProjectId && conversationId) {
        resolvedProjectId =
          (db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(conversationId) as
            | { project_id: string | null }
            | undefined)?.project_id ?? null;
      }
      const id = crypto.randomUUID();
      const tenant = publicOrigin ? new URL(publicOrigin).hostname.split('.')[0] || 'veneer' : 'veneer';
      const scriptName = miniAppScriptName(tenant, id);
      db.prepare(
        `INSERT INTO mini_apps
          (id, slug, title, source_text, source_size_bytes, script_name, project_id, conversation_id, runtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        slug,
        title,
        source,
        Buffer.byteLength(source, 'utf8'),
        scriptName,
        resolvedProjectId,
        conversationId ?? null,
        runtime,
      );

      try {
        const created = appRow(id)!;
        const routeId = await deployRuntime(runtime, created);
        db.prepare(
          `UPDATE mini_apps SET route_id = ?, status = 'deployed', last_error = NULL,
           deployed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        ).run(routeId, id);
        const fresh = appRow(id)!;
        res.json({ ok: true, app: appView(fresh, projectNameOf(fresh.project_id)) });
      } catch (error) {
        const message = error instanceof Error ? error.message : `${runtime} deployment failed`;
        db.prepare("UPDATE mini_apps SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ?").run(
          message,
          id,
        );
        res.status(502).json({ ok: false, error: message, appId: id });
      }
    })().catch((error: Error) => res.status(500).json({ ok: false, error: error.message }));
  });

  router.delete('/:id', (req, res) => {
    if (denyUnlessAdmin(req, res)) return;
    const app = appRow(req.params.id);
    if (!app) {
      res.status(404).json({ ok: false, error: 'Mini app not found' });
      return;
    }
    try {
      requireRuntime(app.runtime);
    } catch (error) {
      res.status(503).json({ ok: false, error: (error as Error).message });
      return;
    }
    void removeRuntime(app.runtime, app)
      .then(() => {
        db.prepare('DELETE FROM mini_apps WHERE id = ?').run(app.id);
        forgetMiniAppWrapper(db, app.id);
        removeMiniAppFromNavigation(db, app.id);
        res.json({ ok: true });
      })
      .catch((error: Error) => res.status(502).json({ ok: false, error: error.message }));
  });

  return router;
}
