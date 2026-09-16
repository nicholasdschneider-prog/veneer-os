import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import { createScheduledTasksRouter } from '../src/routes/scheduledTasks.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
let db: Database.Database;
let server: Server;
let base: string;
const runScheduledTask = vi.fn(async () => ({ ok: true as const, conversationId: 'run-conv', runId: 'run-1' }));
const listModels = vi.fn(async (provider: string) =>
  provider === 'codex'
    ? [
        { id: 'gpt-test', label: 'GPT Test', efforts: ['low', 'medium', 'high'], isDefault: true },
      ]
    : [],
);
const createTrigger = vi.fn(async () => ({ triggerId: 'ti_slack_dm' }));
const changeTrigger = vi.fn(async () => undefined);
const deleteTrigger = vi.fn(async () => undefined);
const listSlackDms = vi.fn(async () => [{ id: 'D123ABC', label: 'Taylor' }]);

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Sam', 'owner')").run();
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (2, 'b@x.com', 'B', 'member')").run();
  db.prepare("INSERT INTO projects (id, slug, name) VALUES ('project-1', 'project-1', 'Project 1')").run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES ('source', 1, 1, 'Source', 'codex', 'native', 'web')`,
  ).run();
  db.prepare(
    `INSERT INTO user_connectors
     (id, user_id, connector_slug, label, status, sharing, config_json)
     VALUES (10, 1, 'slack', 'Work', 'connected', 'personal', ?)`,
  ).run(JSON.stringify({
    sessionId: 'session-1',
    connectedAccountId: 'ca_slack',
    composioUserId: 'a@x.com#work',
    mcp: { type: 'http', url: 'https://example.invalid/mcp' },
  }));
  const users = db.prepare('SELECT * FROM users WHERE id = ?');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = users.get(Number(req.headers['x-user'] ?? 1)) as UserRow;
    next();
  });
  app.use(
    '/api/scheduled-tasks',
    createScheduledTasksRouter(
      {
        db,
        manager: { runScheduledTask, listModels },
        config: { composioApiKey: 'test-key' },
        secrets: { getApiKeyOverride: () => null },
      } as unknown as AppContext,
      {
        createComposioTrigger: createTrigger,
        setComposioTriggerEnabled: changeTrigger,
        deleteComposioTrigger: deleteTrigger,
        listSlackDirectMessages: listSlackDms,
      },
    ),
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

async function call(method: string, path: string, body?: unknown, user = 1) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user': String(user) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('scheduled tasks routes', () => {
  it('creates a source-chat-bound schedule and scopes it to its owner', async () => {
    const created = await call('POST', '/api/scheduled-tasks', {
      name: 'Morning review',
      prompt: 'Review my inbox',
      schedule: { type: 'weekdays', time: '08:00' },
      timezone: 'UTC',
      sourceConversationId: 'source',
    });
    expect(created.status).toBe(201);
    expect(created.json.scheduledTask.scheduleText).toBe('Weekdays at 8:00 AM');
    const row = db.prepare('SELECT provider FROM scheduled_tasks WHERE id = ?').get(created.json.scheduledTask.id) as {
      provider: string;
    };
    expect(row.provider).toBe('codex');

    expect((await call('GET', '/api/scheduled-tasks', undefined, 1)).json.scheduledTasks).toHaveLength(1);
    expect((await call('GET', '/api/scheduled-tasks', undefined, 2)).json.scheduledTasks).toHaveLength(0);
  });

  it('defaults new schedules to Eastern Time', async () => {
    const created = await call('POST', '/api/scheduled-tasks', {
      name: 'Eastern review',
      prompt: 'Review my inbox',
      schedule: { type: 'daily', time: '09:00' },
      sourceConversationId: 'source',
    });
    expect(created.status).toBe(201);
    expect(created.json.scheduledTask.timezone).toBe('America/New_York');
    expect(created.json.scheduledTask.scheduleText).toBe('Every day at 9:00 AM');
  });

  it('creates an advanced cron schedule and previews its next runs', async () => {
    const created = await call('POST', '/api/scheduled-tasks', {
      name: 'Hourly weekday review',
      prompt: 'Review anything new',
      schedule: { type: 'cron', expression: '0 8-17 * * 1-5' },
      timezone: 'America/New_York',
      sourceConversationId: 'source',
    });
    expect(created.status).toBe(201);
    expect(created.json.scheduledTask).toMatchObject({
      schedule: { type: 'cron', expression: '0 8-17 * * 1-5' },
      scheduleText: 'Cron: 0 8-17 * * 1-5',
      timezone: 'America/New_York',
    });
    expect(created.json.scheduledTask.upcomingRuns).toHaveLength(3);
    expect(created.json.scheduledTask.upcomingRuns[0]).toBe(created.json.scheduledTask.nextRunAt);

    const invalid = await call('POST', '/api/scheduled-tasks', {
      name: 'Invalid cron',
      prompt: 'Should not save',
      schedule: { type: 'cron', expression: '0 0 8-17 * * 1-5' },
      timezone: 'UTC',
    });
    expect(invalid.status).toBe(400);

    expect((await call('DELETE', `/api/scheduled-tasks/${created.json.scheduledTask.id}`)).status).toBe(200);
  });

  it('uses the configured site agent instead of hard-coding Assistant', async () => {
    db.prepare(
      `INSERT INTO settings (key, value_json) VALUES ('model_prefs', ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    ).run(JSON.stringify({ defaultAgent: 'app-creator', defaultProvider: 'claude' }));
    const created = await call('POST', '/api/scheduled-tasks', {
      name: 'App review',
      prompt: 'Review the app',
      schedule: { type: 'daily', time: '09:30' },
      timezone: 'UTC',
    });
    expect(created.status).toBe(201);
    const row = db
      .prepare(
        `SELECT a.slug AS assistant_slug
         FROM scheduled_tasks t JOIN assistants a ON a.id = t.assistant_id
         WHERE t.id = ?`,
      )
      .get(created.json.scheduledTask.id) as { assistant_slug: string };
    expect(row.assistant_slug).toBe('app-creator');
    expect((await call('DELETE', `/api/scheduled-tasks/${created.json.scheduledTask.id}`)).status).toBe(200);
    db.prepare("DELETE FROM settings WHERE key = 'model_prefs'").run();
  });

  it('creates and edits an automation with its own model and supported thinking level', async () => {
    db.prepare(
      `INSERT INTO settings (key, value_json) VALUES ('model_prefs', ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    ).run(JSON.stringify({
      defaultProvider: 'codex',
      providerDefaults: { codex: 'gpt-test' },
      defaultEffort: 'medium',
    }));
    const created = await call('POST', '/api/scheduled-tasks', {
      name: 'Model-specific review',
      prompt: 'Review the app',
      schedule: { type: 'daily', time: '10:00' },
      timezone: 'UTC',
      provider: 'codex',
      model: 'gpt-test',
      effort: 'high',
    });
    expect(created.status).toBe(201);
    expect(created.json.scheduledTask).toMatchObject({
      provider: 'codex',
      model: 'gpt-test',
      effort: 'high',
    });

    const updated = await call('PATCH', `/api/scheduled-tasks/${created.json.scheduledTask.id}`, {
      provider: 'claude',
      model: 'opus',
      effort: 'high',
    });
    expect(updated.status).toBe(200);
    expect(updated.json.scheduledTask).toMatchObject({
      provider: 'claude',
      model: 'opus',
      effort: 'high',
    });

    const unsupported = await call('PATCH', `/api/scheduled-tasks/${created.json.scheduledTask.id}`, {
      provider: 'codex',
      model: 'gpt-test',
      effort: 'ultra',
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.json.error).toContain('not supported');

    const unknownModel = await call('PATCH', `/api/scheduled-tasks/${created.json.scheduledTask.id}`, {
      provider: 'codex',
      model: 'gpt-missing',
      effort: 'low',
    });
    expect(unknownModel.status).toBe(400);
    expect(unknownModel.json.error).toContain('not available');

    expect((await call('DELETE', `/api/scheduled-tasks/${created.json.scheduledTask.id}`)).status).toBe(200);
    db.prepare("DELETE FROM settings WHERE key = 'model_prefs'").run();
  });

  it('creates and edits the scheduled agent type within role boundaries', async () => {
    const created = await call('POST', '/api/scheduled-tasks', {
      name: 'Agent-specific review',
      prompt: 'Review the app as a builder',
      schedule: { type: 'daily', time: '10:30' },
      timezone: 'UTC',
      assistantSlug: 'app-creator',
    });
    expect(created.status).toBe(201);
    expect(created.json.scheduledTask).toMatchObject({
      assistantSlug: 'app-creator',
      assistantName: 'App Creator',
    });

    const updated = await call('PATCH', `/api/scheduled-tasks/${created.json.scheduledTask.id}`, {
      assistantSlug: 'assistant',
    });
    expect(updated.status).toBe(200);
    expect(updated.json.scheduledTask.assistantSlug).toBe('assistant');

    const memberDenied = await call('POST', '/api/scheduled-tasks', {
      name: 'Privileged agent',
      prompt: 'Should not be allowed',
      schedule: { type: 'daily', time: '11:30' },
      timezone: 'UTC',
      assistantSlug: 'platform-dev',
    }, 2);
    expect(memberDenied.status).toBe(400);
    expect(memberDenied.json.error).toContain('not available');

    expect((await call('DELETE', `/api/scheduled-tasks/${created.json.scheduledTask.id}`)).status).toBe(200);
  });

  it('inspects and partially updates an owned task without resetting unspecified fields', async () => {
    const created = await call('POST', '/api/scheduled-tasks', {
      name: 'Editable review',
      prompt: 'Review yesterday and summarize',
      schedule: { type: 'weekdays', time: '08:30' },
      timezone: 'UTC',
      sourceConversationId: 'source',
    });
    const id = created.json.scheduledTask.id as string;

    const promptOnly = await call('PATCH', `/api/scheduled-tasks/${id}`, {
      prompt: 'Review yesterday, summarize, and suggest next actions',
    });
    expect(promptOnly.status).toBe(200);
    expect(promptOnly.json.scheduledTask).toMatchObject({
      id,
      name: 'Editable review',
      prompt: 'Review yesterday, summarize, and suggest next actions',
      schedule: { type: 'weekdays', time: '08:30' },
      timezone: 'UTC',
      enabled: true,
    });

    const timingOnly = await call('PATCH', `/api/scheduled-tasks/${id}`, {
      schedule: { type: 'weekly', time: '14:15', weekday: 5 },
      timezone: 'America/New_York',
    });
    expect(timingOnly.status).toBe(200);
    expect(timingOnly.json.scheduledTask).toMatchObject({
      id,
      name: 'Editable review',
      prompt: 'Review yesterday, summarize, and suggest next actions',
      schedule: { type: 'weekly', time: '14:15', weekday: 5 },
      scheduleText: 'Every Friday at 2:15 PM',
      timezone: 'America/New_York',
      enabled: true,
    });

    const inspected = await call('GET', `/api/scheduled-tasks/${id}`);
    expect(inspected.status).toBe(200);
    expect(inspected.json.scheduledTask).toMatchObject(timingOnly.json.scheduledTask);
  });

  it('rejects invalid or unowned task edits without changing the task', async () => {
    const created = await call('POST', '/api/scheduled-tasks', {
      name: 'Scoped review',
      prompt: 'Keep this prompt',
      schedule: { type: 'daily', time: '11:00' },
      timezone: 'UTC',
    });
    const id = created.json.scheduledTask.id as string;

    expect((await call('PATCH', `/api/scheduled-tasks/${id}`, { timezone: 'Not/AZone' })).status).toBe(400);
    expect((await call('GET', `/api/scheduled-tasks/${id}`, undefined, 2)).status).toBe(404);
    expect((await call('PATCH', `/api/scheduled-tasks/${id}`, { prompt: 'Cross-user edit' }, 2)).status).toBe(404);
    expect((await call('GET', '/api/scheduled-tasks/missing')).status).toBe(404);
    expect((await call('PATCH', '/api/scheduled-tasks/missing', { prompt: 'Missing' })).status).toBe(404);

    const unchanged = await call('GET', `/api/scheduled-tasks/${id}`);
    expect(unchanged.json.scheduledTask).toMatchObject({
      prompt: 'Keep this prompt',
      schedule: { type: 'daily', time: '11:00' },
      timezone: 'UTC',
    });
  });

  it('pauses, resumes, runs now, and deletes an owned task', async () => {
    const list = await call('GET', '/api/scheduled-tasks');
    const id = list.json.scheduledTasks[0].id as string;
    const paused = await call('PATCH', `/api/scheduled-tasks/${id}`, { enabled: false });
    expect(paused.json.scheduledTask.enabled).toBe(false);
    const resumed = await call('PATCH', `/api/scheduled-tasks/${id}`, { enabled: true });
    expect(resumed.json.scheduledTask.enabled).toBe(true);
    const run = await call('POST', `/api/scheduled-tasks/${id}/run-now`);
    expect(run.status).toBe(202);
    expect(run.json.conversationId).toBe('run-conv');
    expect(runScheduledTask).toHaveBeenCalledWith(id);
    expect((await call('DELETE', `/api/scheduled-tasks/${id}`)).status).toBe(200);
  });

  it('returns workspace status, project placement, pinning, and complete run history', async () => {
    const created = await call('POST', '/api/scheduled-tasks', {
      name: 'Project automation',
      prompt: 'Do the project review',
      schedule: { type: 'daily', time: '10:00' },
      timezone: 'UTC',
      projectId: 'project-1',
    });
    expect(created.status).toBe(201);
    expect(created.json.scheduledTask).toMatchObject({
      projectId: 'project-1',
      projectName: 'Project 1',
      pinned: false,
    });
    const id = created.json.scheduledTask.id as string;

    db.prepare(
      `INSERT INTO conversations
       (id, assistant_id, user_id, project_id, title, provider, native_session_id, channel)
       VALUES ('automation-run', 1, 1, 'project-1', 'Project automation run', 'claude', 'run-native', 'automation')`,
    ).run();
    db.prepare(
      `INSERT INTO scheduled_task_runs
       (id, scheduled_task_id, conversation_id, scheduled_for, trigger, status, error, finished_at)
       VALUES ('history-run', ?, 'automation-run', datetime('now'), 'scheduled', 'failed', 'Needs review', datetime('now'))`,
    ).run(id);

    const list = await call('GET', '/api/scheduled-tasks');
    expect(list.json.summary.needsAttention).toBe(1);
    const history = await call('GET', `/api/scheduled-tasks/${id}/runs`);
    expect(history.json.runs).toEqual([
      expect.objectContaining({ id: 'history-run', important: false, status: 'failed' }),
    ]);

    const important = await call('PATCH', `/api/scheduled-tasks/${id}/runs/history-run`, { important: true });
    expect(important.json.run.important).toBe(true);
    const pinned = await call('PATCH', `/api/scheduled-tasks/${id}`, { pinned: true, projectId: null });
    expect(pinned.json.scheduledTask).toMatchObject({ pinned: true, projectId: null, projectName: null });

    expect((await call('PATCH', `/api/scheduled-tasks/${id}`, { projectId: 'missing' })).status).toBe(400);
    expect((await call('PATCH', `/api/scheduled-tasks/${id}/runs/history-run`, { important: false }, 2)).status).toBe(404);

    expect((await call('DELETE', `/api/scheduled-tasks/${id}`)).status).toBe(200);
    expect(
      db.prepare("SELECT archived FROM conversations WHERE id = 'automation-run'").get(),
    ).toEqual({ archived: 1 });
  });

  it('deletes only an owned terminal run and archives its linked chat', async () => {
    const created = await call('POST', '/api/scheduled-tasks', {
      name: 'Run cleanup',
      prompt: 'Create history to clean up',
      schedule: { type: 'daily', time: '12:00' },
      timezone: 'UTC',
    });
    const taskId = created.json.scheduledTask.id as string;
    db.prepare(
      `INSERT INTO conversations
       (id, assistant_id, user_id, title, provider, native_session_id, channel, pin_order)
       VALUES ('cleanup-run-chat', 1, 1, 'Cleanup run', 'claude', 'cleanup-native', 'automation', 1),
              ('active-run-chat', 1, 1, 'Active run', 'claude', 'active-native', 'automation', 2)`,
    ).run();
    db.prepare(
      `INSERT INTO scheduled_task_runs
       (id, scheduled_task_id, conversation_id, scheduled_for, trigger, status, finished_at)
       VALUES ('cleanup-run', ?, 'cleanup-run-chat', '2026-01-01T00:00:00.000Z', 'scheduled', 'completed', datetime('now')),
              ('active-run', ?, 'active-run-chat', '2026-01-02T00:00:00.000Z', 'scheduled', 'running', NULL)`,
    ).run(taskId, taskId);

    expect((await call('DELETE', `/api/scheduled-tasks/${taskId}/runs/cleanup-run`, undefined, 2)).status).toBe(404);
    expect((await call('DELETE', `/api/scheduled-tasks/${taskId}/runs/missing`)).status).toBe(404);

    const active = await call('DELETE', `/api/scheduled-tasks/${taskId}/runs/active-run`);
    expect(active.status).toBe(409);
    expect(active.json.error).toContain('active run');
    expect(db.prepare("SELECT id FROM scheduled_task_runs WHERE id = 'active-run'").get()).toEqual({ id: 'active-run' });

    const deleted = await call('DELETE', `/api/scheduled-tasks/${taskId}/runs/cleanup-run`);
    expect(deleted.status).toBe(200);
    expect(deleted.json.archivedConversationId).toBe('cleanup-run-chat');
    expect(db.prepare("SELECT id FROM scheduled_task_runs WHERE id = 'cleanup-run'").get()).toBeUndefined();
    expect(db.prepare("SELECT archived, pin_order FROM conversations WHERE id = 'cleanup-run-chat'").get()).toEqual({
      archived: 1,
      pin_order: null,
    });

    db.prepare("UPDATE scheduled_task_runs SET status = 'completed', finished_at = datetime('now') WHERE id = 'active-run'").run();
    expect((await call('DELETE', `/api/scheduled-tasks/${taskId}`)).status).toBe(200);
  });

  it('rejects invalid timezones, past one-time schedules, and cross-user source chats', async () => {
    const baseBody = { name: 'X', prompt: 'Y', schedule: { type: 'daily', time: '08:00' } };
    expect((await call('POST', '/api/scheduled-tasks', { ...baseBody, timezone: 'Not/AZone' })).status).toBe(400);
    expect((await call('POST', '/api/scheduled-tasks', { ...baseBody, timezone: 'UTC', projectId: 'missing' })).status).toBe(400);
    expect(
      (
        await call('POST', '/api/scheduled-tasks', {
          ...baseBody,
          schedule: { type: 'once', runAt: '2020-01-01T00:00:00Z' },
          timezone: 'UTC',
        })
      ).status,
    ).toBe(400);
    expect((await call('POST', '/api/scheduled-tasks', { ...baseBody, timezone: 'UTC', sourceConversationId: 'source' }, 2)).status).toBe(404);
  });

  it('does not expose or create triggers for a removed connector', async () => {
    const recipes = await call('GET', '/api/scheduled-tasks/trigger-recipes');
    expect(recipes.json.recipes).toEqual([]);

    const options = await call('GET', '/api/scheduled-tasks/trigger-options/slack-dms?connectorId=10');
    expect(options.status).toBe(404);

    const created = await call('POST', '/api/scheduled-tasks', {
      name: 'Slack DM response recommendation',
      prompt: 'Analyze this and give me a recommended response.',
      triggerKind: 'event',
      recipe: 'slack.dm.received',
      connectorId: 10,
      triggerConfig: { channelId: 'D123ABC' },
      filters: [{ field: 'message.text', operator: 'word_count_gt', value: 4 }],
    });
    expect(created.status).toBe(400);
    expect(created.json.error).toContain('Invalid event trigger source');
    expect(createTrigger).not.toHaveBeenCalled();
  });
});
