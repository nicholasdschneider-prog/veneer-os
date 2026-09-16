import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TodoCategoryRow, TodoLinkRow, TodoRow } from '../db/db.js';

export interface TodoLinkInput {
  kind: 'link' | 'file';
  href: string;
  label?: string | null;
}

export interface TodoLinkView {
  id: string;
  kind: 'link' | 'file';
  href: string;
  label: string | null;
}

export interface TodoCategoryView {
  id: string;
  name: string;
  sortOrder: number;
}

export interface TodoProjectView {
  id: string;
  name: string;
}

export interface TodoView {
  id: string;
  title: string;
  notes: string;
  categoryId: string | null;
  categoryName: string | null;
  projectId: string | null;
  projectName: string | null;
  state: 'pending' | 'active' | 'done';
  conversationId: string | null;
  sortOrder: number;
  links: TodoLinkView[];
  createdAt: string;
  updatedAt: string;
}

export interface TodoListResult {
  categories: TodoCategoryView[];
  projects: TodoProjectView[];
  todos: TodoView[];
}

export interface TodoCreateInput {
  title: string;
  notes?: string;
  categoryId?: string | null;
  projectId?: string | null;
  links?: TodoLinkInput[];
}

export interface TodoPatchInput {
  title?: string;
  notes?: string;
  categoryId?: string | null;
  projectId?: string | null;
  sortOrder?: number;
  state?: TodoRow['state'];
  conversationId?: string | null;
  links?: TodoLinkInput[];
}

export interface TodoAgentPatchInput {
  title?: string;
  notes?: string;
  categoryId?: string | null;
  projectId?: string | null;
  action?: 'complete' | 'reopen';
  linksAdd?: TodoLinkInput[];
  linkIdsRemove?: string[];
}

export interface TodoListFilters {
  state?: TodoRow['state'];
  query?: string;
  categoryId?: string | null;
  projectId?: string | null;
}

export class TodoServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TodoServiceError';
  }
}

/** Shared Todo business rules for the UI API, built-in agent tools, and hub receiver. */
export function createTodoService(db: Database.Database) {
  const getTodo = db.prepare('SELECT * FROM todos WHERE id = ?');
  const getCategory = db.prepare('SELECT * FROM todo_categories WHERE id = ?');
  const getProject = db.prepare('SELECT 1 FROM projects WHERE id = ?');
  const getLinksFor = db.prepare('SELECT * FROM todo_links WHERE todo_id = ? ORDER BY rowid');

  function todoRow(id: string): TodoRow | undefined {
    return getTodo.get(id) as TodoRow | undefined;
  }

  function categoryRow(id: string): TodoCategoryRow | undefined {
    return getCategory.get(id) as TodoCategoryRow | undefined;
  }

  function categoryView(row: TodoCategoryRow): TodoCategoryView {
    return { id: row.id, name: row.name, sortOrder: row.sort_order };
  }

  function linkView(row: TodoLinkRow): TodoLinkView {
    return { id: row.id, kind: row.kind, href: row.href, label: row.label };
  }

  function projectRows(): TodoProjectView[] {
    return db.prepare('SELECT id, name FROM projects ORDER BY sort_order, name').all() as TodoProjectView[];
  }

  function todoView(
    row: TodoRow,
    links: TodoLinkRow[],
    categories = new Map<string, string>(),
    projects = new Map<string, string>(),
  ): TodoView {
    return {
      id: row.id,
      title: row.title,
      notes: row.notes,
      categoryId: row.category_id,
      categoryName: row.category_id ? (categories.get(row.category_id) ?? null) : null,
      projectId: row.project_id,
      projectName: row.project_id ? (projects.get(row.project_id) ?? null) : null,
      state: row.state,
      conversationId: row.conversation_id,
      sortOrder: row.sort_order,
      links: links.map(linkView),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function get(id: string): TodoView {
    const row = todoRow(id);
    if (!row) throw new TodoServiceError(404, 'Todo not found');
    const categories = new Map(
      (
        db.prepare('SELECT id, name FROM todo_categories').all() as Array<{
          id: string;
          name: string;
        }>
      ).map((item) => [item.id, item.name]),
    );
    const projects = new Map(projectRows().map((item) => [item.id, item.name]));
    return todoView(row, getLinksFor.all(row.id) as TodoLinkRow[], categories, projects);
  }

  function list(filters: TodoListFilters = {}): TodoListResult {
    const categoryRows = db
      .prepare('SELECT * FROM todo_categories ORDER BY sort_order, name')
      .all() as TodoCategoryRow[];
    const projects = projectRows();
    const categoriesById = new Map(categoryRows.map((row) => [row.id, row.name]));
    const projectsById = new Map(projects.map((row) => [row.id, row.name]));
    const rows = db.prepare('SELECT * FROM todos ORDER BY sort_order').all() as TodoRow[];
    const links = db.prepare('SELECT * FROM todo_links ORDER BY rowid').all() as TodoLinkRow[];
    const byTodo = new Map<string, TodoLinkRow[]>();
    for (const link of links) {
      const current = byTodo.get(link.todo_id);
      if (current) current.push(link);
      else byTodo.set(link.todo_id, [link]);
    }
    const query = filters.query?.trim().toLowerCase() ?? '';
    const todos = rows
      .filter((row) => filters.state === undefined || row.state === filters.state)
      .filter((row) => filters.categoryId === undefined || row.category_id === filters.categoryId)
      .filter((row) => filters.projectId === undefined || row.project_id === filters.projectId)
      .filter((row) => !query || `${row.title}\n${row.notes}`.toLowerCase().includes(query))
      .map((row) => todoView(row, byTodo.get(row.id) ?? [], categoriesById, projectsById));
    return { categories: categoryRows.map(categoryView), projects, todos };
  }

  function assertCategory(id: string | null): void {
    if (id !== null && !categoryRow(id)) throw new TodoServiceError(400, 'Unknown category');
  }

  function assertProject(id: string | null): void {
    if (id !== null && !getProject.get(id)) throw new TodoServiceError(400, 'Unknown project');
  }

  function assertConversation(id: string | null): void {
    if (id !== null && !db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)) {
      throw new TodoServiceError(400, 'Unknown conversation');
    }
  }

  function insertLinks(todoId: string, links: TodoLinkInput[]): void {
    const insert = db.prepare('INSERT INTO todo_links (id, todo_id, kind, href, label) VALUES (?, ?, ?, ?, ?)');
    for (const link of links) insert.run(crypto.randomUUID(), todoId, link.kind, link.href, link.label ?? null);
  }

  function create(input: TodoCreateInput): TodoView {
    const categoryId = input.categoryId ?? null;
    const projectId = input.projectId ?? null;
    const links = input.links ?? [];
    assertCategory(categoryId);
    assertProject(projectId);
    if (links.length > 50) throw new TodoServiceError(400, 'Too many links');
    const max = db
      .prepare('SELECT MAX(sort_order) AS m FROM todos WHERE category_id IS ? AND state = ?')
      .get(categoryId, 'pending') as { m: number | null };
    const id = crypto.randomUUID();
    db.transaction(() => {
      db.prepare(
        'INSERT INTO todos (id, title, notes, category_id, project_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, input.title, input.notes ?? '', categoryId, projectId, (max?.m ?? 0) + 1);
      insertLinks(id, links);
    })();
    return get(id);
  }

  function applyPatch(
    row: TodoRow,
    input: TodoPatchInput,
    allowProjectChange: boolean,
    linkMutation?: { add: TodoLinkInput[]; remove: string[] },
  ): TodoView {
    if (input.categoryId !== undefined) assertCategory(input.categoryId);
    if (input.projectId !== undefined) {
      if (!allowProjectChange) throw new TodoServiceError(409, 'Only pending todos can change project');
      assertProject(input.projectId);
    }
    if (input.conversationId !== undefined) assertConversation(input.conversationId);
    if (input.links && input.links.length > 50) throw new TodoServiceError(400, 'Too many links');

    db.transaction(() => {
      const sets: string[] = [];
      const values: unknown[] = [];
      const fields: Array<[keyof TodoPatchInput, string]> = [
        ['title', 'title'],
        ['notes', 'notes'],
        ['categoryId', 'category_id'],
        ['projectId', 'project_id'],
        ['sortOrder', 'sort_order'],
        ['state', 'state'],
        ['conversationId', 'conversation_id'],
      ];
      for (const [key, column] of fields) {
        if (input[key] !== undefined) {
          sets.push(`${column} = ?`);
          values.push(input[key]);
        }
      }
      sets.push("updated_at = datetime('now')");
      db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...values, row.id);
      if (input.links !== undefined) {
        db.prepare('DELETE FROM todo_links WHERE todo_id = ?').run(row.id);
        insertLinks(row.id, input.links);
      } else if (linkMutation) {
        const remove = db.prepare('DELETE FROM todo_links WHERE todo_id = ? AND id = ?');
        for (const linkId of linkMutation.remove) remove.run(row.id, linkId);
        insertLinks(row.id, linkMutation.add);
      }
    })();
    return get(row.id);
  }

  function patch(id: string, input: TodoPatchInput): TodoView {
    const row = todoRow(id);
    if (!row) throw new TodoServiceError(404, 'Todo not found');
    return applyPatch(row, input, row.state === 'pending');
  }

  function patchFromAgent(id: string, input: TodoAgentPatchInput): TodoView {
    const row = todoRow(id);
    if (!row) throw new TodoServiceError(404, 'Todo not found');
    const nextState =
      input.action === 'complete'
        ? 'done'
        : input.action === 'reopen'
          ? row.conversation_id
            ? 'active'
            : 'pending'
          : row.state;
    const existingLinks = getLinksFor.all(row.id) as TodoLinkRow[];
    const removeIds = new Set(input.linkIdsRemove ?? []);
    for (const idToRemove of removeIds) {
      if (!existingLinks.some((link) => link.id === idToRemove)) {
        throw new TodoServiceError(400, `Unknown link id: ${idToRemove}`);
      }
    }
    const finalLinkCount = existingLinks.length - removeIds.size + (input.linksAdd?.length ?? 0);
    if (finalLinkCount > 50) throw new TodoServiceError(400, 'Too many links');
    const patchInput: TodoPatchInput = {};
    if (input.title !== undefined) patchInput.title = input.title;
    if (input.notes !== undefined) patchInput.notes = input.notes;
    if (input.categoryId !== undefined) patchInput.categoryId = input.categoryId;
    if (input.projectId !== undefined) patchInput.projectId = input.projectId;
    if (input.action !== undefined) patchInput.state = nextState;
    const linkMutation =
      (input.linksAdd?.length ?? 0) > 0 || removeIds.size > 0
        ? { add: input.linksAdd ?? [], remove: [...removeIds] }
        : undefined;
    return applyPatch(row, patchInput, nextState === 'pending', linkMutation);
  }

  function remove(id: string): void {
    if (!todoRow(id)) throw new TodoServiceError(404, 'Todo not found');
    db.prepare('DELETE FROM todos WHERE id = ?').run(id);
  }

  return { list, get, create, patch, patchFromAgent, remove };
}
