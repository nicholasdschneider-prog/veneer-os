import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import type { UserRow } from '../src/db/db.js';
import { createTodosRouter } from '../src/routes/todos.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let db: Database.Database;
let server: Server;
let base: string;
let currentUser: UserRow;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare(
    "INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')",
  ).run();
  db.prepare(
    "INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')",
  ).run();
  db.prepare(
    `INSERT INTO projects (id, slug, name, instructions)
     VALUES ('project-1', 'one', 'Project One', ''), ('project-2', 'two', 'Project Two', '')`,
  ).run();

  currentUser = db.prepare('SELECT * FROM users WHERE id = 1').get() as UserRow;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = currentUser;
    next();
  });
  app.use('/api/todos', createTodosRouter({ db } as unknown as AppContext));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, any>,
  };
}

describe('todos project assignment', () => {
  it('persists a valid project and rejects an unknown project', async () => {
    expect(
      (
        await call('POST', '/api/todos', {
          title: 'Invalid',
          projectId: 'missing',
        })
      ).status,
    ).toBe(400);

    const created = await call('POST', '/api/todos', {
      title: 'Ship it',
      projectId: 'project-1',
    });
    expect(created.status).toBe(200);
    expect(created.json.todo).toMatchObject({
      title: 'Ship it',
      state: 'pending',
      projectId: 'project-1',
    });

    const id = created.json.todo.id as string;
    expect((await call('PATCH', `/api/todos/${id}`, { projectId: 'missing' })).status).toBe(400);
    const moved = await call('PATCH', `/api/todos/${id}`, {
      projectId: 'project-2',
    });
    expect(moved.json.todo).toMatchObject({
      projectId: 'project-2',
      state: 'pending',
    });
  });

  it('syncs the fired-off chat project, then prevents project edits after Pending', async () => {
    const created = await call('POST', '/api/todos', {
      title: 'Start chat',
      projectId: 'project-1',
    });
    const id = created.json.todo.id as string;
    db.prepare(
      `INSERT INTO conversations
       (id, assistant_id, user_id, project_id, title, provider, native_session_id)
       VALUES ('todo-chat', 1, 1, 'project-2', 'Start chat', 'claude', 'todo-native')`,
    ).run();

    const activated = await call('PATCH', `/api/todos/${id}`, {
      state: 'active',
      conversationId: 'todo-chat',
      projectId: 'project-2',
    });
    expect(activated.status).toBe(200);
    expect(activated.json.todo).toMatchObject({
      state: 'active',
      conversationId: 'todo-chat',
      projectId: 'project-2',
    });
    expect((await call('PATCH', `/api/todos/${id}`, { projectId: 'project-1' })).status).toBe(409);
  });

  it('clears assignment when its project is deleted', async () => {
    const created = await call('POST', '/api/todos', {
      title: 'Unfile me',
      projectId: 'project-1',
    });
    const id = created.json.todo.id as string;

    db.prepare("DELETE FROM projects WHERE id = 'project-1'").run();

    const listed = await call('GET', '/api/todos');
    const todo = (listed.json.todos as Array<Record<string, unknown>>).find((item) => item.id === id);
    expect(todo?.projectId).toBeNull();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('supports filtered lists and an exact Todo read', async () => {
    const created = await call('POST', '/api/todos', {
      title: 'Unique filter phrase',
      notes: 'Network notes',
    });
    const id = created.json.todo.id as string;
    const listed = await call('GET', '/api/todos?state=pending&query=unique%20filter');
    expect(listed.status).toBe(200);
    expect(listed.json.todos).toEqual([expect.objectContaining({ id, title: 'Unique filter phrase' })]);
    expect(listed.json.categories).toBeInstanceOf(Array);
    expect(listed.json.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'project-2', name: 'Project Two' })]),
    );
    expect((await call('GET', `/api/todos/${id}`)).json.todo).toMatchObject({
      id,
      notes: 'Network notes',
    });
  });

  it('adds and removes links incrementally without changing retained link ids', async () => {
    const created = await call('POST', '/api/todos', {
      title: 'Keep attachments',
      links: [
        { kind: 'link', href: 'https://one.example', label: 'One' },
        { kind: 'file', href: '/uploads/two.pdf', label: 'Two' },
      ],
    });
    const id = created.json.todo.id as string;
    const [removeLink, retainedLink] = created.json.todo.links as Array<Record<string, string>>;
    const updated = await call('PATCH', `/api/todos/${id}/agent`, {
      linksAdd: [{ kind: 'link', href: 'https://three.example', label: 'Three' }],
      linkIdsRemove: [removeLink!.id],
    });
    expect(updated.status).toBe(200);
    expect(updated.json.todo.links).toEqual([
      expect.objectContaining({
        id: retainedLink!.id,
        href: '/uploads/two.pdf',
      }),
      expect.objectContaining({ href: 'https://three.example' }),
    ]);
    expect(
      (
        await call('PATCH', `/api/todos/${id}/agent`, {
          linkIdsRemove: ['missing-link'],
        })
      ).status,
    ).toBe(400);
  });

  it('completes and safely reopens unlinked and chat-linked Todos', async () => {
    const pending = await call('POST', '/api/todos', { title: 'Plain Todo' });
    const pendingId = pending.json.todo.id as string;
    expect(
      (
        await call('PATCH', `/api/todos/${pendingId}/agent`, {
          action: 'complete',
        })
      ).json.todo.state,
    ).toBe('done');
    const reopened = await call('PATCH', `/api/todos/${pendingId}/agent`, {
      action: 'reopen',
      projectId: 'project-2',
    });
    expect(reopened.json.todo).toMatchObject({
      state: 'pending',
      projectId: 'project-2',
    });

    const linked = await call('POST', '/api/todos', { title: 'Linked Todo' });
    const linkedId = linked.json.todo.id as string;
    db.prepare(
      `INSERT INTO conversations
       (id, assistant_id, user_id, title, provider, native_session_id)
       VALUES ('agent-linked-chat', 1, 1, 'Linked', 'claude', 'agent-linked-native')`,
    ).run();
    await call('PATCH', `/api/todos/${linkedId}`, {
      state: 'active',
      conversationId: 'agent-linked-chat',
    });
    await call('PATCH', `/api/todos/${linkedId}/agent`, { action: 'complete' });
    expect(
      (
        await call('PATCH', `/api/todos/${linkedId}/agent`, {
          action: 'reopen',
        })
      ).json.todo.state,
    ).toBe('active');
  });

  it('keeps member writes blocked on native and agent routes', async () => {
    const owner = currentUser;
    const created = await call('POST', '/api/todos', { title: 'Owner Todo' });
    currentUser = db.prepare('SELECT * FROM users WHERE id = 2').get() as UserRow;
    try {
      expect((await call('POST', '/api/todos', { title: 'Member Todo' })).status).toBe(403);
      expect(
        (
          await call('PATCH', `/api/todos/${created.json.todo.id}/agent`, {
            action: 'complete',
          })
        ).status,
      ).toBe(403);
      expect((await call('GET', '/api/todos')).status).toBe(200);
    } finally {
      currentUser = owner;
    }
  });
});
