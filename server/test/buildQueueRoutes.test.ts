import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import type { BuildQueueRow, UserRow } from '../src/db/db.js';
import { createBuildQueueRouter } from '../src/routes/buildQueue.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
let db: Database.Database;
let server: Server;
let base: string;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')").run();
  db.prepare("INSERT INTO projects (id, slug, name, instructions) VALUES ('project-1', 'alpha', 'Alpha', '')").run();
  const platformDev = db.prepare("SELECT id FROM assistants WHERE slug = 'platform-dev'").get() as { id: number };
  db.prepare(
    `INSERT INTO conversations
      (id, assistant_id, user_id, visibility, project_id, title, provider, native_session_id, channel)
     VALUES ('build-chat', ?, 1, 'private', 'project-1', 'Queue sidebar', 'codex', 'native', 'web')`,
  ).run(platformDev.id);
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES ('unfiled-chat', ?, 1, 'Loose build', 'codex', 'native-2', 'web')`,
  ).run(platformDev.id);
  const assistant = db.prepare("SELECT id FROM assistants WHERE slug = 'assistant'").get() as { id: number };
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, project_id, title, provider, native_session_id, channel)
     VALUES ('member-build', ?, 2, 'project-1', 'Member build', 'claude', 'native-3', 'web')`,
  ).run(assistant.id);
  db.prepare(
    `INSERT INTO conversations
       (id, assistant_id, user_id, title, provider, native_session_id, channel, archived, origin_conversation_id)
     VALUES ('archived-build', ?, 1, 'Archived build', 'codex', 'native-4', 'web', 1, 'queue-parent')`,
  ).run(platformDev.id);
  db.prepare(
    "INSERT INTO todos (id, title, state, conversation_id) VALUES ('archived-build-todo', 'Archived build', 'done', 'archived-build')",
  ).run();
  db.prepare(
    `INSERT INTO build_queue (id, user_id, conversation_id, title, brief, status, created_at, started_at)
     VALUES (7, 1, 'build-chat', 'Expose the queue', 'Build it.', 'running', '2026-07-21 10:00:00', '2026-07-21 10:01:00')`,
  ).run();
  db.prepare(
    `INSERT INTO build_queue (id, user_id, conversation_id, title, brief, status, created_at)
     VALUES (8, 1, 'unfiled-chat', 'Second build', 'Build it next.', 'queued', '2026-07-21 10:02:00')`,
  ).run();
  db.prepare(
    `INSERT INTO build_queue (id, user_id, conversation_id, scope_key, title, brief, status, created_at)
     VALUES (9, 2, 'member-build', 'project:project-1', 'Member project build', 'Build it.', 'queued', '2026-07-21 10:03:00')`,
  ).run();

  const users = db.prepare('SELECT * FROM users WHERE id = ?');
  const listBuildQueue = async () => db.prepare('SELECT * FROM build_queue ORDER BY id').all() as BuildQueueRow[];
  const statusOf = async (conversationId: string) => conversationId === 'build-chat' ? 'needs_you' as const : 'idle' as const;
  const enqueueBuild = async (conversationId: string, title: string, brief: string) => {
    const conversation = db.prepare('SELECT archived FROM conversations WHERE id = ?').get(conversationId) as
      | { archived: number }
      | undefined;
    if (!conversation || conversation.archived) return { ok: false as const, error: 'not_found' as const };
    const job: BuildQueueRow = {
      id: 10,
      user_id: 1,
      conversation_id: conversationId,
      scope_key: 'source',
      title,
      brief,
      status: 'queued',
      error: null,
      created_at: '2026-07-23 10:00:00',
      started_at: null,
      finished_at: null,
    };
    return { ok: true as const, job, position: 3, disposition: 'enqueued' as const };
  };
  const resolveBuild = async (jobId: number, action: 'retry' | 'skip') => {
    const job = db.prepare('SELECT * FROM build_queue WHERE id = ?').get(jobId) as BuildQueueRow | undefined;
    if (!job) return { ok: false as const, error: 'not_found' as const };
    if (action !== 'skip' || (job.status !== 'queued' && job.status !== 'failed')) {
      return { ok: false as const, error: 'invalid_status' as const };
    }
    db.prepare("UPDATE build_queue SET status = 'skipped' WHERE id = ?").run(jobId);
    return {
      ok: true as const,
      job: db.prepare('SELECT * FROM build_queue WHERE id = ?').get(jobId) as BuildQueueRow,
    };
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = users.get(Number(req.headers['x-user'] ?? 1)) as UserRow;
    next();
  });
  app.use(
    '/api/build-queue',
    createBuildQueueRouter({
      db,
      manager: { enqueueBuild, listBuildQueue, resolveBuild, statusOf },
    } as unknown as AppContext),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

describe('build queue routes', () => {
  it('allows shared business bot training queues and audits the member, denying viewers and outsiders', async () => {
    db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('training','Training',1)").run();
    db.prepare("INSERT INTO business_team_members(team_id,user_id,role) VALUES('training',2,'member')").run();
    db.prepare(`INSERT INTO conversations(id,assistant_id,user_id,project_id,business_team_id,visibility,provider,native_session_id,channel)
      SELECT 'training-chat',id,1,'project-1','training','team','codex','training-native','web' FROM assistants WHERE slug='assistant'`).run();
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by,active) VALUES('training-chat','Training',1,1)").run();
    db.prepare("INSERT INTO business_bot_members(conversation_id,team_id,role) VALUES('training-chat','training','bot')").run();
    const enqueue = () => fetch(`${base}/api/build-queue`, {method:'POST',headers:{'Content-Type':'application/json','x-user':'2'},body:JSON.stringify({sourceConversationId:'training-chat',title:'Save training',brief:'Preserve correction'})});
    expect((await enqueue()).status).toBe(201);
    expect(db.prepare("SELECT actor_id,action FROM business_audit WHERE team_id='training'").get()).toEqual({actor_id:2,action:'build.enqueued'});
    db.prepare("UPDATE business_team_members SET role='viewer' WHERE team_id='training'").run();
    expect((await enqueue()).status).toBe(404);
    db.prepare("DELETE FROM business_team_members WHERE team_id='training'").run();
    expect((await enqueue()).status).toBe(404);
  });

  it('enriches the existing queue with chat and project context', async () => {
    const response = await fetch(`${base}/api/build-queue`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      jobs: [
        {
          id: 7,
          conversationId: 'build-chat',
          conversationTitle: 'Queue sidebar',
          assistantName: 'Platform Dev',
          provider: 'codex',
          projectId: 'project-1',
          projectName: 'Alpha',
          scopeKey: 'source',
          position: 1,
          title: 'Expose the queue',
          status: 'running',
          conversationStatus: 'needs_you',
          createdAt: '2026-07-21 10:00:00',
          startedAt: '2026-07-21 10:01:00',
        },
        {
          id: 8,
          conversationId: 'unfiled-chat',
          conversationTitle: 'Loose build',
          projectId: null,
          projectName: null,
          scopeKey: 'source',
          position: 2,
          title: 'Second build',
          status: 'queued',
          conversationStatus: 'idle',
        },
        {
          id: 9,
          conversationId: 'member-build',
          assistantName: 'Assistant',
          projectId: 'project-1',
          scopeKey: 'project:project-1',
          position: 1,
          status: 'queued',
        },
      ],
    });
  });

  it('shows Team queued work and hides another user’s Private queued work', async () => {
    const response = await fetch(`${base}/api/build-queue`, { headers: { 'x-user': '2' } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      jobs: [
        { id: 8, conversationId: 'unfiled-chat', position: 2 },
        { id: 9, conversationId: 'member-build', position: 1 },
      ],
    });
  });

  it('reactivates an archived source chat before enqueueing it', async () => {
    const response = await fetch(`${base}/api/build-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceConversationId: 'archived-build',
        title: 'Resume archived work',
        brief: 'Continue the requested implementation.',
      }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      job: { conversation_id: 'archived-build', title: 'Resume archived work' },
    });
    expect(
      db.prepare("SELECT archived, origin_conversation_id FROM conversations WHERE id = 'archived-build'").get(),
    ).toEqual({ archived: 0, origin_conversation_id: 'queue-parent' });
    expect(db.prepare("SELECT state FROM todos WHERE id = 'archived-build-todo'").get()).toEqual({ state: 'active' });
  });

  it('prevents a member from resolving another user\'s Private-chat build', async () => {
    const response = await fetch(`${base}/api/build-queue/7/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user': '2' },
      body: JSON.stringify({ action: 'skip' }),
    });
    expect(response.status).toBe(404);
  });

  it('lets a member resolve another user\'s Team-chat build', async () => {
    const response = await fetch(`${base}/api/build-queue/8/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user': '2' },
      body: JSON.stringify({ action: 'skip' }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, job: { id: 8, status: 'skipped' } });
  });
});
