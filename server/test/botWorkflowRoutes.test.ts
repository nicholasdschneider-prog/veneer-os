import express from 'express';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import type { Server } from 'node:http';
import { migrate } from '../src/db/migrate.js';
import {
  createBotEventsWebhook,
  createBotWorkflowsRouter,
} from '../src/botWorkflows/routes.js';
import { saveRoutine } from '../src/botWorkflows/routines.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';

describe('workflow HTTP boundaries', () => {
  let db: Database.Database,
    server: Server,
    url: string,
    ctx: AppContext,
    key: string;
  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(
      db,
      fileURLToPath(new URL('../src/db/migrations', import.meta.url)),
    );
    db.prepare(
      "INSERT INTO users(id,email,display_name,role) VALUES(1,'a@example.test','A','owner'),(2,'b@example.test','B','member')",
    ).run();
    db.prepare(
      "INSERT INTO business_teams(id,name,owner_id) VALUES('team','Team',1)",
    ).run();
    db.prepare(
      "INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES('a',1,1,'A','claude','native','team','team')",
    ).run();
    db.prepare(
      "INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('a','A',1)",
    ).run();
    db.prepare(
      "INSERT INTO bot_event_sources(id,team_id,created_by,name) VALUES('source','team',1,'OrderOps')",
    ).run();
    key = crypto.randomBytes(32).toString('base64url');
    ctx = {
      db,
      secrets: {
        getApiKeyOverride: (id: string) =>
          id === 'bot-event-source-source' ? key : null,
      },
    } as unknown as AppContext;
    saveRoutine(
      db,
      db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow,
      'a',
      {
        name: 'Intake',
        instructions: 'Triage',
        kind: 'ticket.created',
        source: 'source',
        enabled: true,
      },
    );
    const app = express();
    app.use('/webhooks', createBotEventsWebhook(ctx));
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = db
        .prepare('SELECT * FROM users WHERE id=?')
        .get(Number(req.headers['x-test-user'] ?? 1)) as UserRow;
      if (req.headers['x-test-agent'])
        req.agentConversationId = String(req.headers['x-test-agent']);
      next();
    });
    app.use('/workflows', createBotWorkflowsRouter(ctx));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  it('serves the same noncached guide to authorized human and bot callers without business data', async () => {
    const human = await fetch(`${url}/workflows/guide`, { headers: { 'x-test-user': '2' } });
    expect(human.status).toBe(200);
    expect(human.headers.get('cache-control')).toBe('no-store');
    const body = await human.json();
    expect(body.features.some((feature: { id: string }) => feature.id === 'routines')).toBe(true);
    expect(body.features.every((feature: { isNew: unknown }) => typeof feature.isNew === 'boolean')).toBe(true);
    const bot = await fetch(`${url}/workflows/guide`, { headers: { 'x-test-agent': 'a' } });
    expect(await bot.json()).toEqual(body);
    expect(JSON.stringify(body)).not.toContain('a@example.test');
  });
  function signed(body: string, stamp = String(Math.floor(Date.now() / 1000))) {
    return {
      'Content-Type': 'application/json',
      'x-veneer-timestamp': stamp,
      'x-veneer-signature': crypto
        .createHmac('sha256', key)
        .update(stamp + '.' + body)
        .digest('hex'),
    };
  }
  it('requires valid fresh signatures and rejects altered bodies; retries deduplicate', async () => {
    const body = JSON.stringify({
      id: 'one',
      type: 'ticket.created',
      ticket_id: 'T1',
      occurred_at: new Date().toISOString(),
    });
    expect(
      (
        await fetch(url + '/webhooks/source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(url + '/webhooks/source', {
          method: 'POST',
          headers: signed(body, '1000000000'),
          body,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(url + '/webhooks/source', {
          method: 'POST',
          headers: signed(body),
          body: body.replace('T1', 'T2'),
        })
      ).status,
    ).toBe(401);
    const first = await fetch(url + '/webhooks/source', {
      method: 'POST',
      headers: signed(body),
      body,
    });
    expect(await first.json()).toEqual({ ok: true, queued: 1 });
    const repeat = await fetch(url + '/webhooks/source', {
      method: 'POST',
      headers: signed(body),
      body,
    });
    expect(await repeat.json()).toEqual({ ok: true, queued: 0 });
  });
  it('does not expose another business configuration or allow an agent to subscribe a device', async () => {
    expect(
      (
        await fetch(url + '/workflows/bots/a', {
          headers: { 'x-test-user': '2' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(url + '/workflows/push', {
          headers: { 'x-test-agent': 'a' },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(url + '/workflows/current/routines')).status).toBe(400);
    const r = await fetch(url + '/workflows/current/routines', {
      headers: { 'x-test-agent': 'a' },
    });
    expect(r.status).toBe(200);
    expect((await r.json()).routines).toHaveLength(1);
  });
});
