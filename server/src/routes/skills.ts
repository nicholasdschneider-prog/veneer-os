import fs from 'node:fs';
import path from 'node:path';
import { canTrainBusinessBot } from '../conversations/access.js';
import type { ConversationRow } from '../db/db.js';
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { createSkillStore, SkillError, type Role } from '../skills/store.js';

/**
 * Skills Manager API (spec §4). Reads are open to every known user; project training permits authorized business
 * teammates to create and update local skills. Other mutations check `role === 'member'` (the /model-prefs pattern,
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

  function trainingContext(req: Request, scope: string): ConversationRow | undefined {
    if (!scope.startsWith('project:')) return undefined;
    const rows = ctx.db.prepare('SELECT * FROM conversations WHERE project_id=? AND archived=0').all(scope.slice(8)) as ConversationRow[];
    return rows.find(c => (!req.agentConversationId || req.agentConversationId === c.id) && canTrainBusinessBot(req.user!, c, ctx.db));
  }

  function authorizeTraining(req: Request, scope: string, name?: string): ConversationRow | undefined {
    if (req.user!.role !== 'member') return undefined;
    const conversation = trainingContext(req, scope);
    if (!conversation) throw new SkillError('forbidden', 'Project training access required');
    const project = ctx.db.prepare('SELECT slug,root_dir FROM projects WHERE id=?').get(conversation.project_id) as { slug: string; root_dir: string | null };
    const projectPath = project.root_dir ?? path.join(ctx.config.dataDir, 'workspaces', 'projects', project.slug);
    const root = fs.existsSync(projectPath) ? fs.realpathSync(projectPath) : path.resolve(projectPath);
    for (const directory of ['.agents', '.agents/skills', '.claude', '.claude/skills']) {
      const candidate = path.join(root, directory);
      if (!fs.existsSync(candidate)) continue;
      const relative = path.relative(root, fs.realpathSync(candidate));
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new SkillError('forbidden', 'Training skill paths must stay inside the project');
    }
    if (name) {
      const skill = store().read(scope, name);
      const relative = path.relative(root, fs.realpathSync(skill.canonicalDir));
      // A linked skill can change other projects or global instructions. Only
      // standalone local project skills are writable through training access.
      if (relative.startsWith('..') || path.isAbsolute(relative) || skill.entryKind !== 'original'
        || skill.source || skill.dependents.some(d => d.scope !== scope)) {
        throw new SkillError('forbidden', 'Shared skill originals require administrator access');
      }
    }
    return conversation;
  }

  function auditTraining(req: Request, conversation: ConversationRow | undefined, scope: string, name: string, action: string): void {
    if (!conversation) return;
    ctx.db.prepare('INSERT INTO business_audit(team_id,actor_id,actor_chat,action,payload_json) VALUES(?,?,?,?,?)').run(
      conversation.business_team_id, req.user!.id, req.agentConversationId ?? null, action, JSON.stringify({ scope, name }),
    );
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
    const p = params(req, res);
    if (!p) return;
    const body = CreateSkillSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid skill' });
      return;
    }
    try {
      const training = authorizeTraining(req, p.scope);
      const { skill, crossScopeDuplicates } = store().create(p.scope, body.data.name, body.data.description, body.data.body);
      auditTraining(req, training, p.scope, body.data.name, 'skill.created');
      res.json({ ok: true, skill, crossScopeDuplicates });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/:scope/:name', (req, res) => {
    const p = params(req, res);
    if (!p) return;
    const body = SaveSkillSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid save' });
      return;
    }
    try {
      const training = authorizeTraining(req, p.scope, p.name);
      const skill = store().save(p.scope, p.name, body.data);
      auditTraining(req, training, p.scope, p.name, 'skill.updated');
      res.json({ ok: true, skill });
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
