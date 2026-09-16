import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { TodoCategoryRow } from '../db/db.js';
import { TodoAgentPatchSchema, TodoCreateSchema, TodoLinkSchema, TodoProjectIdSchema } from '../todos/schemas.js';
import { createTodoService, TodoServiceError } from '../todos/service.js';

/**
 * Todos API — a lightweight scratch-pad.
 * A todo has title + notes + links/file-attachments, belongs to an optional
 * user-defined category (a column), and has state 'pending', 'active', or 'done'.
 * 'active' means a chat was fired off from it, storing conversation_id; 'done'
 * means finished/archived (set manually, or auto when its chat is archived).
 *
 * Reads open to every known user; writes deny members.
 */

const PatchSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    notes: z.string().max(20_000).optional(),
    categoryId: z.string().nullable().optional(),
    projectId: TodoProjectIdSchema.nullable().optional(),
    sortOrder: z.number().finite().optional(),
    state: z.enum(['pending', 'active', 'done']).optional(),
    conversationId: z.string().nullable().optional(),
    links: z.array(TodoLinkSchema).max(50).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'no fields to update');

const CreateCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
});

const PatchCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    sortOrder: z.number().finite().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'no fields to update');

export function createTodosRouter(ctx: AppContext): Router {
  const { db } = ctx;
  const router = express.Router();
  const todos = createTodoService(db);

  function denyMembers(req: Request, res: Response): boolean {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return true;
    }
    return false;
  }

  const getCategory = db.prepare('SELECT * FROM todo_categories WHERE id = ?');

  function categoryRow(id: string): TodoCategoryRow | undefined {
    return getCategory.get(id) as TodoCategoryRow | undefined;
  }

  function categoryView(c: TodoCategoryRow): Record<string, unknown> {
    return { id: c.id, name: c.name, sortOrder: c.sort_order };
  }

  function fail(res: Response, error: unknown): void {
    if (error instanceof TodoServiceError) {
      res.status(error.status).json({ ok: false, error: error.message });
      return;
    }
    throw error;
  }

  // ── list ───────────────────────────────────────────────────────────────────
  router.get('/', (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    if (state !== undefined && !['pending', 'active', 'done'].includes(state)) {
      res.status(400).json({ ok: false, error: 'Invalid state' });
      return;
    }
    const categoryId =
      req.query.categoryId === undefined
        ? undefined
        : req.query.categoryId === 'inbox'
          ? null
          : String(req.query.categoryId);
    const projectId =
      req.query.projectId === undefined
        ? undefined
        : req.query.projectId === 'none'
          ? null
          : String(req.query.projectId);
    const result = todos.list({
      state: state as 'pending' | 'active' | 'done' | undefined,
      query: typeof req.query.query === 'string' ? req.query.query.slice(0, 500) : undefined,
      categoryId,
      projectId,
    });
    res.json({ ok: true, ...result });
  });

  // ── create todo ─────────────────────────────────────────────────────────────
  router.post('/', (req, res) => {
    if (denyMembers(req, res)) return;
    const body = TodoCreateSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid todo' });
      return;
    }
    try {
      res.json({ ok: true, todo: todos.create(body.data) });
    } catch (error) {
      fail(res, error);
    }
  });

  // ── categories (registered BEFORE /:id so they don't get captured) ──────────
  router.post('/categories', (req, res) => {
    if (denyMembers(req, res)) return;
    const body = CreateCategorySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid category' });
      return;
    }
    const max = db.prepare('SELECT MAX(sort_order) AS m FROM todo_categories').get() as { m: number | null };
    const sortOrder = (max?.m ?? 0) + 1;
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO todo_categories (id, name, sort_order) VALUES (?, ?, ?)').run(
      id,
      body.data.name,
      sortOrder,
    );
    res.json({ ok: true, category: categoryView(categoryRow(id)!) });
  });

  router.patch('/categories/:id', (req, res) => {
    if (denyMembers(req, res)) return;
    const body = PatchCategorySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid category patch' });
      return;
    }
    const cat = categoryRow(req.params.id);
    if (!cat) {
      res.status(404).json({ ok: false, error: 'Category not found' });
      return;
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (body.data.name !== undefined) {
      sets.push('name = ?');
      vals.push(body.data.name);
    }
    if (body.data.sortOrder !== undefined) {
      sets.push('sort_order = ?');
      vals.push(body.data.sortOrder);
    }
    db.prepare(`UPDATE todo_categories SET ${sets.join(', ')} WHERE id = ?`).run(...vals, cat.id);
    res.json({ ok: true, category: categoryView(categoryRow(cat.id)!) });
  });

  router.delete('/categories/:id', (req, res) => {
    if (denyMembers(req, res)) return;
    const cat = categoryRow(req.params.id);
    if (!cat) {
      res.status(404).json({ ok: false, error: 'Category not found' });
      return;
    }
    // Uncategorize its todos then delete. FKs run ON at runtime so ON DELETE SET
    // NULL would fire on its own, but do it explicitly in a transaction so the
    // behaviour is robust regardless of the connection's FK pragma.
    const run = db.transaction(() => {
      db.prepare("UPDATE todos SET category_id = NULL, updated_at = datetime('now') WHERE category_id = ?").run(cat.id);
      db.prepare('DELETE FROM todo_categories WHERE id = ?').run(cat.id);
    });
    run();
    res.json({ ok: true });
  });

  // Exact read for agents and detail clients. Keep after /categories routes.
  router.get('/:id', (req, res) => {
    try {
      res.json({ ok: true, todo: todos.get(req.params.id) });
    } catch (error) {
      fail(res, error);
    }
  });

  // Safe agent update: no conversation, raw state, sort, or replace-all link fields.
  router.patch('/:id/agent', (req, res) => {
    if (denyMembers(req, res)) return;
    const body = TodoAgentPatchSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid agent todo update' });
      return;
    }
    try {
      res.json({
        ok: true,
        todo: todos.patchFromAgent(req.params.id, body.data),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  // ── patch todo ──────────────────────────────────────────────────────────────
  router.patch('/:id', (req, res) => {
    if (denyMembers(req, res)) return;
    const body = PatchSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid patch' });
      return;
    }
    try {
      res.json({ ok: true, todo: todos.patch(req.params.id, body.data) });
    } catch (error) {
      fail(res, error);
    }
  });

  // -- delete todo (links cascade) --
  router.delete('/:id', (req, res) => {
    if (denyMembers(req, res)) return;
    try {
      todos.remove(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
