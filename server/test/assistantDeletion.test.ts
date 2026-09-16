import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import { createApiRouter } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
let db: Database.Database;
let server: Server;
let base: string;
let identityEmail = 'owner@example.com';
const conversationStatuses = new Map<string, 'working' | 'needs_you' | 'idle' | 'failed'>();

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('owner@example.com', 'Owner', 'owner')").run();
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('member@example.com', 'Member', 'member')").run();
  identityEmail = 'owner@example.com';
  conversationStatuses.clear();
  const ctx = {
    db,
    resolveIdentity: async () => ({ email: identityEmail }),
    manager: {
      postMessage: async () => undefined,
      statusOf: async (conversationId: string) => conversationStatuses.get(conversationId) ?? 'idle',
    },
    secrets: { getApiKeyOverride: () => null },
    config: { openRouterApiKey: null },
  } as unknown as AppContext;
  const app = express();
  app.use('/api', createApiRouter(ctx));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
  db.close();
});

async function json(pathname: string, init?: RequestInit): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${base}${pathname}`, init);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe('deletable built-in agents', () => {
  it('returns the actual agent name for an existing conversation', async () => {
    const dataAnalyst = db.prepare("SELECT id FROM assistants WHERE slug = 'data-analyst'").get() as { id: number };
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
       VALUES ('data-analyst-chat', ?, 1, 'Analysis', 'claude', 'data-analyst-session', 'web')`,
    ).run(dataAnalyst.id);

    const response = await json('/api/conversations/data-analyst-chat');
    expect(response.status).toBe(200);
    expect(response.body.conversation.assistantSlug).toBe('data-analyst');
    expect(response.body.conversation.assistantName).toBe('Data Analyst');
  });

  it('retires an unused Assistant and persists a safe replacement default', async () => {
    const deleted = await json('/api/assistants/assistant', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(deleted.body.prefs.defaultAgent).toBe('app-creator');
    expect(
      (db.prepare("SELECT deleted_at FROM assistants WHERE slug = 'assistant'").get() as { deleted_at: string | null })
        .deleted_at,
    ).not.toBeNull();

    const created = await json('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: 'Start safely' }),
    });
    expect(created.status).toBe(200);
    expect(created.body.conversation.assistantSlug).toBe('app-creator');
    expect(created.body.conversation.visibility).toBe('team');

    identityEmail = 'member@example.com';
    const memberCreated = await json('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: 'Member chat' }),
    });
    expect(memberCreated.status).toBe(200);
    expect(memberCreated.body.conversation.assistantSlug).toBe('app-creator');

    const privateCreated = await json('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: 'Private member chat', visibility: 'private' }),
    });
    expect(privateCreated.status).toBe(200);
    expect(privateCreated.body.conversation.visibility).toBe('private');
    expect(
      db.prepare('SELECT visibility FROM conversations WHERE id = ?').get(privateCreated.body.conversation.id),
    ).toEqual({ visibility: 'private' });
  });

  it('retires an unused Skill Builder and rejects stale explicit launches', async () => {
    const deleted = await json('/api/assistants/skill-smith', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(
      (
        db.prepare("SELECT deleted_at FROM assistants WHERE slug = 'skill-smith'").get() as {
          deleted_at: string | null;
        }
      ).deleted_at,
    ).not.toBeNull();

    const staleLaunch = await json('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: 'Create a skill', assistantSlug: 'skill-smith' }),
    });
    expect(staleLaunch.status).toBe(400);
    expect(staleLaunch.body.error).toBe('Agent is unavailable');
  });

  it('keeps historical chats and safely reassigns live references', async () => {
    const inserted = db
      .prepare("INSERT INTO assistants (slug, name) VALUES ('historian', 'Historical Agent')")
      .run();
    const retiredId = Number(inserted.lastInsertRowid);
    const replacement = db.prepare("SELECT id FROM assistants WHERE slug = 'assistant'").get() as { id: number };
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
       VALUES ('historical-chat', ?, 1, 'Old work', 'claude', 'historical-session', 'web')`,
    ).run(retiredId);
    db.prepare(
      `INSERT INTO projects (id, slug, name, default_assistant_id)
       VALUES ('historical-project', 'historical-project', 'Historical project', ?)`,
    ).run(retiredId);
    db.prepare(
      `INSERT INTO scheduled_tasks
         (id, user_id, assistant_id, name, prompt, schedule_json, timezone, provider)
       VALUES ('historical-task', 1, ?, 'Future work', 'Continue', '{}', 'America/New_York', 'claude')`,
    ).run(retiredId);
    const prefs = await json('/api/model-prefs');
    await json('/api/model-prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...prefs.body.prefs,
        defaultAgent: 'historian',
        agents: {
          ...prefs.body.prefs.agents,
          historian: { provider: 'claude', model: null, effort: null },
        },
      }),
    });

    const deleted = await json('/api/assistants/historian', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(deleted.body.prefs.defaultAgent).toBeNull();
    expect(deleted.body.prefs.agents).not.toHaveProperty('historian');
    expect(deleted.body.replacement).toEqual({ slug: 'assistant', name: 'Assistant' });
    expect(deleted.body.reassigned).toEqual({ projects: 1, automations: 1 });

    const historical = await json('/api/conversations/historical-chat');
    expect(historical.status).toBe(200);
    expect(historical.body.conversation.assistantSlug).toBe('historian');
    expect(historical.body.conversation.assistantName).toBe('Historical Agent');
    expect(
      db.prepare('SELECT assistant_id FROM conversations WHERE id = ?').get('historical-chat'),
    ).toEqual({ assistant_id: retiredId });
    expect(db.prepare('SELECT default_assistant_id FROM projects WHERE id = ?').get('historical-project')).toEqual({
      default_assistant_id: replacement.id,
    });
    expect(db.prepare('SELECT assistant_id FROM scheduled_tasks WHERE id = ?').get('historical-task')).toEqual({
      assistant_id: replacement.id,
    });

    const agents = await json('/api/assistants');
    expect(agents.body.assistants).not.toContainEqual(expect.objectContaining({ slug: 'historian' }));
    const staleLaunch = await json('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: 'New work', assistantSlug: 'historian' }),
    });
    expect(staleLaunch.status).toBe(400);
    expect(staleLaunch.body.error).toBe('Agent is unavailable');
  });

  it('never silently substitutes an explicitly missing ordinary agent', async () => {
    const response = await json('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: 'Hello', assistantSlug: 'missing-agent' }),
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Agent is unavailable');
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversations').get()).toEqual({ n: 0 });
  });

  it('blocks deletion while an agent is working or waiting for the user', async () => {
    const platformDev = db.prepare("SELECT id FROM assistants WHERE slug = 'platform-dev'").get() as { id: number };
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
       VALUES ('active-platform-chat', ?, 1, 'Active work', 'claude', 'active-platform-session', 'web')`,
    ).run(platformDev.id);

    conversationStatuses.set('active-platform-chat', 'working');
    const working = await json('/api/assistants/platform-dev', { method: 'DELETE' });
    expect(working.status).toBe(409);
    expect(working.body.error).toContain('working or waiting for you');

    conversationStatuses.set('active-platform-chat', 'needs_you');
    const waiting = await json('/api/assistants/platform-dev', { method: 'DELETE' });
    expect(waiting.status).toBe(409);
    expect(
      (db.prepare("SELECT deleted_at FROM assistants WHERE slug = 'platform-dev'").get() as { deleted_at: string | null })
        .deleted_at,
    ).toBeNull();
  });

  it('retires an unused Platform Dev and moves defaults to a regular agent', async () => {
    const platformDev = db.prepare("SELECT id FROM assistants WHERE slug = 'platform-dev'").get() as { id: number };
    const assistant = db.prepare("SELECT id FROM assistants WHERE slug = 'assistant'").get() as { id: number };
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
       VALUES ('idle-platform-chat', ?, 1, 'Old platform work', 'claude', 'idle-platform-session', 'web')`,
    ).run(platformDev.id);
    db.prepare(
      `INSERT INTO projects (id, slug, name, default_assistant_id)
       VALUES ('platform-project', 'platform-project', 'Platform project', ?)`,
    ).run(platformDev.id);
    db.prepare(
      `INSERT INTO scheduled_tasks
         (id, user_id, assistant_id, name, prompt, schedule_json, timezone, provider)
       VALUES ('platform-task', 1, ?, 'Platform task', 'Maintain Veneer', '{}', 'America/New_York', 'claude')`,
    ).run(platformDev.id);
    const prefs = await json('/api/model-prefs');
    await json('/api/model-prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...prefs.body.prefs,
        defaultAgent: 'platform-dev',
        agents: {
          ...prefs.body.prefs.agents,
          'platform-dev': { provider: 'claude', model: null, effort: null },
        },
      }),
    });

    const deleted = await json('/api/assistants/platform-dev', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(deleted.body.prefs.defaultAgent).toBeNull();
    expect(deleted.body.prefs.agents).not.toHaveProperty('platform-dev');
    expect(deleted.body.replacement).toEqual({ slug: 'assistant', name: 'Assistant' });
    expect(deleted.body.reassigned).toEqual({ projects: 1, automations: 1 });
    expect(db.prepare("SELECT default_assistant_id FROM projects WHERE id = 'platform-project'").get()).toEqual({
      default_assistant_id: assistant.id,
    });
    expect(db.prepare("SELECT assistant_id FROM scheduled_tasks WHERE id = 'platform-task'").get()).toEqual({
      assistant_id: assistant.id,
    });

    const historical = await json('/api/conversations/idle-platform-chat');
    expect(historical.body.conversation.assistantSlug).toBe('platform-dev');

    identityEmail = 'member@example.com';
    const memberCreated = await json('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstMessage: 'Use a regular agent', projectId: 'platform-project' }),
    });
    expect(memberCreated.status).toBe(200);
    expect(memberCreated.body.conversation.assistantSlug).toBe('assistant');
  });

  it('protects the last agent available to regular chats', async () => {
    db.prepare("DELETE FROM assistants WHERE slug IN ('app-creator', 'data-analyst')").run();
    const lastRegular = await json('/api/assistants/assistant', { method: 'DELETE' });
    expect(lastRegular.status).toBe(409);
    expect(lastRegular.body.error).toContain('last agent available for regular chats');
  });
});
