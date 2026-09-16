import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import type { ConversationRow } from '../src/db/db.js';
import { conversationView } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
let db: Database.Database;
let ctx: AppContext;

const conversation = (id: string) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'a@x.com', 'A', 'owner')").run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES ('run-conv', 1, 1, 'Morning email review', 'claude', 'native-1', 'automation')`,
  ).run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES ('web-conv', 1, 1, 'Just a chat', 'claude', 'native-2', 'web')`,
  ).run();
  db.prepare(
    `INSERT INTO scheduled_tasks
       (id, user_id, assistant_id, name, prompt, schedule_json, timezone, provider, next_run_at, last_run_at)
     VALUES ('task-1', 1, 1, 'Morning email review', 'Summarize my inbox',
             ?, 'America/New_York', 'claude', '2026-07-28T11:00:00Z', '2026-07-27T11:00:00Z')`,
  ).run(JSON.stringify({ type: 'daily', time: '07:00' }));
  db.prepare(
    `INSERT INTO scheduled_task_runs (id, scheduled_task_id, conversation_id, scheduled_for, trigger, status)
     VALUES ('run-1', 'task-1', 'run-conv', '2026-07-27T11:00:00Z', 'scheduled', 'completed')`,
  ).run();
  ctx = {
    db,
    manager: {
      statusOf: async () => 'idle',
      activityOf: async (id: string) => (id === 'web-conv' ? 'compacting' : null),
    },
  } as unknown as AppContext;
});

afterAll(() => db.close());

it('links an automation chat back to the task that produced it', async () => {
  const view = await conversationView(ctx, conversation('run-conv'));
  expect(view.automation).toMatchObject({
    taskId: 'task-1',
    name: 'Morning email review',
    triggerKind: 'schedule',
    enabled: true,
    nextRunAt: '2026-07-28T11:00:00Z',
    runStatus: 'completed',
    ranAt: '2026-07-27T11:00:00Z',
  });
  // The cadence is rendered for humans, not handed over as raw JSON.
  expect(String((view.automation as { scheduleText: string }).scheduleText)).toMatch(/7:00/);
});

it('leaves ordinary chats without an automation', async () => {
  const view = await conversationView(ctx, conversation('web-conv'));
  expect(view.automation).toBeNull();
  expect(view.activity).toBe('compacting');
});

it('keeps the run status override that the strip data now shares a query with', async () => {
  db.prepare("UPDATE scheduled_task_runs SET status = 'needs_you' WHERE id = 'run-1'").run();
  const view = await conversationView(ctx, conversation('run-conv'));
  expect(view.status).toBe('needs_you');
  expect((view.automation as { taskId: string }).taskId).toBe('task-1');
  db.prepare("UPDATE scheduled_task_runs SET status = 'completed' WHERE id = 'run-1'").run();
});
