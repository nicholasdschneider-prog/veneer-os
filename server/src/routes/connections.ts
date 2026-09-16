import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { ConnectionRow, UserRow } from '../db/db.js';
import {
  connectionView,
  mergeConfigSecrets,
  parseConnectionConfig,
  uniqueSlug,
} from '../toolbox/connections.js';
import { PolicySchema } from '../toolbox/policy.js';
import { probeConnection } from '../toolbox/probe.js';
import type { McpConfig } from '../toolbox/connections.js';

/**
 * Toolbox connections API (spec §9/§11). Thin routes, zod on every boundary.
 * Authorization (spec §5 isolation): members never; consultant always; owner
 * only where managed_by='owner'.
 */

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  config: z.unknown(),
  policy: PolicySchema.optional(),
  enabled: z.boolean().optional(),
  managedBy: z.enum(['consultant', 'owner']).optional(),
});

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  config: z.unknown().optional(),
  policy: PolicySchema.optional(),
  enabled: z.boolean().optional(),
  managedBy: z.enum(['consultant', 'owner']).optional(),
});

/** consultant edits anything; owner only managed_by='owner' rows. */
function canWrite(user: UserRow, row: Pick<ConnectionRow, 'managed_by'>): boolean {
  if (user.role === 'consultant') return true;
  if (user.role === 'owner') return row.managed_by === 'owner';
  return false;
}

export function createConnectionsRouter(ctx: AppContext): Router {
  const { db } = ctx;
  const router = express.Router();

  // Members never see the toolbox.
  router.use((req, res, next) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Toolbox access is limited to administrators.' });
      return;
    }
    next();
  });

  function rowFor(req: Request, res: Response): ConnectionRow | null {
    const id = Number(req.params.id);
    const row = Number.isInteger(id)
      ? (db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow | undefined)
      : undefined;
    if (!row) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return null;
    }
    return row;
  }

  router.get('/', (_req, res) => {
    const rows = db.prepare('SELECT * FROM connections ORDER BY name').all() as ConnectionRow[];
    res.json({ ok: true, connections: rows.map(connectionView) });
  });

  router.post('/', (req, res) => {
    const body = CreateSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid connection' });
      return;
    }
    // Owners may only create owner-managed connections; consultant may choose.
    const managedBy = req.user!.role === 'owner' ? 'owner' : body.data.managedBy ?? 'consultant';
    let configJson: string;
    try {
      const parsed = parseConnectionConfig(body.data.config);
      configJson = JSON.stringify(parsed);
    } catch (err) {
      res.status(400).json({ ok: false, error: `Invalid config: ${(err as Error).message}` });
      return;
    }
    const slug = uniqueSlug(db, body.data.name);
    const info = db
      .prepare(
        `INSERT INTO connections (name, slug, config_json, policy_json, enabled, managed_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.data.name,
        slug,
        configJson,
        JSON.stringify(body.data.policy ?? { default: 'approve', rules: [] }),
        body.data.enabled === false ? 0 : 1,
        managedBy,
      );
    const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(Number(info.lastInsertRowid)) as ConnectionRow;
    res.json({ ok: true, connection: connectionView(row) });
  });

  router.patch('/:id', (req, res) => {
    const row = rowFor(req, res);
    if (!row) return;
    if (!canWrite(req.user!, row)) {
      res.status(403).json({ ok: false, error: 'You cannot edit this connection.' });
      return;
    }
    const body = PatchSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid patch' });
      return;
    }
    const sets: string[] = [];
    const args: unknown[] = [];
    if (body.data.name !== undefined) {
      sets.push('name = ?');
      args.push(body.data.name);
    }
    if (body.data.config !== undefined) {
      try {
        const incoming = parseConnectionConfig(body.data.config);
        const existing = parseConnectionConfig(row.config_json);
        const merged = mergeConfigSecrets(incoming, existing);
        sets.push('config_json = ?');
        args.push(JSON.stringify(merged));
      } catch (err) {
        res.status(400).json({ ok: false, error: `Invalid config: ${(err as Error).message}` });
        return;
      }
    }
    if (body.data.policy !== undefined) {
      sets.push('policy_json = ?');
      args.push(JSON.stringify(body.data.policy));
    }
    if (body.data.enabled !== undefined) {
      sets.push('enabled = ?');
      args.push(body.data.enabled ? 1 : 0);
    }
    // Only consultant may change management ownership.
    if (body.data.managedBy !== undefined && req.user!.role === 'consultant') {
      sets.push('managed_by = ?');
      args.push(body.data.managedBy);
    }
    if (sets.length) {
      args.push(row.id);
      db.prepare(`UPDATE connections SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    }
    const fresh = db.prepare('SELECT * FROM connections WHERE id = ?').get(row.id) as ConnectionRow;
    res.json({ ok: true, connection: connectionView(fresh) });
  });

  router.delete('/:id', (req, res) => {
    const row = rowFor(req, res);
    if (!row) return;
    if (!canWrite(req.user!, row)) {
      res.status(403).json({ ok: false, error: 'You cannot delete this connection.' });
      return;
    }
    db.prepare('DELETE FROM connections WHERE id = ?').run(row.id);
    res.json({ ok: true });
  });

  // One-click probe: connect the MCP server, list tools, report ok/error.
  router.post('/:id/test', (req, res) => {
    const row = rowFor(req, res);
    if (!row) return;
    if (!canWrite(req.user!, row)) {
      res.status(403).json({ ok: false, error: 'You cannot test this connection.' });
      return;
    }
    let config: McpConfig;
    try {
      config = parseConnectionConfig(row.config_json);
    } catch (err) {
      res.status(400).json({ ok: false, error: `Invalid config: ${(err as Error).message}` });
      return;
    }
    void probeConnection(config)
      .then((result) => {
        // Present tool names as the assistant sees them, so policy patterns are copyable.
        const tools = result.tools.map((t) => `mcp__${row.slug}__${t}`);
        res.json({ ok: true, result: { ok: result.ok, detail: result.detail, tools } });
      })
      .catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  return router;
}
