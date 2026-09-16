import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { createSkillStore, SkillError, type Role } from '../skills/store.js';

/**
 * Skills Manager API (spec §4). Reads are open to every known user; every
 * mutating route inline-checks `role === 'member'` (the /model-prefs pattern,
 * NOT a whole-router gate — members may read). The store owns all fs logic and
 * throws typed `{ code }` errors mapped to HTTP below.
 */

const SkillName = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const ScopeKey = z.string().regex(/^(global|source|project:[A-Za-z0-9_-]{1,64})$/);

const CreateSkillSchema = z.object({
  name: SkillName,
  description: z.string().trim().min(1).max(1024),
  body: z.string().max(200_000).default(''),
});

const SaveSkillSchema = z
  .object({
    description: z.string().trim().min(1).max(1024).optional(),
    body: z.string().max(200_000).optional(),
    raw: z.string().max(220_000).optional(),
    expectedMtime: z.number().nonnegative().optional(),
  })
  .refine((v) => (v.raw !== undefined) !== (v.body !== undefined || v.description !== undefined), 'provide either raw, or description/body');

const PatchSkillSchema = z
  .object({
    newName: SkillName.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => v.newName !== undefined || v.enabled !== undefined);

const MoveCopySchema = z.object({ toScope: ScopeKey });

export function createSkillsRouter(ctx: AppContext): Router {
  const router = express.Router();
  // Lazy: ctx.config is read on first request, not at mount time (some tests
  // construct partial contexts without config), mirroring files.ts.
  let cached: ReturnType<typeof createSkillStore> | null = null;
  const store = () => (cached ??= createSkillStore({ config: ctx.config, db: ctx.db }));

  function denyMembers(req: Request, res: Response): boolean {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return true;
    }
    return false;
  }

  function fail(res: Response, err: unknown): void {
    if (err instanceof SkillError) {
      const status =
        err.code === 'exists' || err.code === 'conflict'
          ? 409
          : err.code === 'not-found'
            ? 404
            : err.code === 'read-only' || err.code === 'forbidden'
              ? 403
              : 400;
      res.status(status).json({ ok: false, error: err.message, ...err.extra });
      return;
    }
    console.error('[skills] unexpected error:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong' });
  }

  /** Validate the :scope / :name path params (400 on failure) before fs access. */
  function params(req: Request, res: Response): { scope: string; name: string } | null {
    const scope = ScopeKey.safeParse(req.params.scope);
    if (!scope.success) {
      res.status(400).json({ ok: false, error: 'Invalid scope' });
      return null;
    }
    if (req.params.name !== undefined) {
      const name = SkillName.safeParse(req.params.name);
      if (!name.success) {
        res.status(400).json({ ok: false, error: 'Invalid skill name' });
        return null;
      }
      return { scope: scope.data, name: name.data };
    }
    return { scope: scope.data, name: '' };
  }

  router.get('/', (req, res) => {
    try {
      const { scopes, builtins } = store().list(req.user!.role as Role);
      res.json({ ok: true, scopes, builtins });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:scope/:name', (req, res) => {
    const p = params(req, res);
    if (!p) return;
    try {
      res.json({ ok: true, skill: store().read(p.scope, p.name) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:scope', (req, res) => {
    if (denyMembers(req, res)) return;
    const p = params(req, res);
    if (!p) return;
    const body = CreateSkillSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid skill' });
      return;
    }
    try {
      const { skill, crossScopeDuplicates } = store().create(p.scope, body.data.name, body.data.description, body.data.body);
      res.json({ ok: true, skill, crossScopeDuplicates });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/:scope/:name', (req, res) => {
    if (denyMembers(req, res)) return;
    const p = params(req, res);
    if (!p) return;
    const body = SaveSkillSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid save' });
      return;
    }
    try {
      res.json({ ok: true, skill: store().save(p.scope, p.name, body.data) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch('/:scope/:name', (req, res) => {
    if (denyMembers(req, res)) return;
    const p = params(req, res);
    if (!p) return;
    const body = PatchSkillSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid patch' });
      return;
    }
    try {
      let skill = store().read(p.scope, p.name);
      let name = p.name;
      if (body.data.newName !== undefined) {
        skill = store().rename(p.scope, name, body.data.newName);
        name = body.data.newName;
      }
      if (body.data.enabled !== undefined) {
        skill = store().setEnabled(p.scope, name, body.data.enabled);
      }
      res.json({ ok: true, skill });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:scope/:name/sync', (req, res) => {
    if (denyMembers(req, res)) return;
    const p = params(req, res);
    if (!p) return;
    try {
      res.json({ ok: true, skill: store().sync(p.scope, p.name) });
    } catch (err) {
      fail(res, err);
    }
  });

  // "Make global" moves the one canonical dir; "add to a project" copies the folder.
  for (const op of ['move', 'copy'] as const) {
    router.post(`/:scope/:name/${op}`, (req, res) => {
      if (denyMembers(req, res)) return;
      const p = params(req, res);
      if (!p) return;
      const body = MoveCopySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ ok: false, error: 'Invalid target scope' });
        return;
      }
      if (body.data.toScope === p.scope) {
        res.status(400).json({ ok: false, error: 'Source and target scope are the same' });
        return;
      }
      try {
        res.json({ ok: true, skill: store()[op](p.scope, p.name, body.data.toScope) });
      } catch (err) {
        fail(res, err);
      }
    });
  }

  router.delete('/:scope/:name', (req, res) => {
    if (denyMembers(req, res)) return;
    const p = params(req, res);
    if (!p) return;
    try {
      store().remove(p.scope, p.name);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
