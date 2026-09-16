import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import { createComposioWebhookRouter } from '../src/routes/composioWebhook.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const SECRET = 'test-webhook-secret';

let db: Database.Database;
let server: Server;
let base: string;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'a@x.com', 'A', 'owner')").run();
  db.prepare(
    `INSERT INTO user_connectors
     (id, user_id, connector_slug, status, sharing, config_json)
     VALUES (10, 1, 'slack', 'connected', 'personal', ?)`,
  ).run(JSON.stringify({
    sessionId: 'session-1',
    connectedAccountId: 'ca_slack',
    mcp: { type: 'http', url: 'https://example.invalid/mcp' },
  }));
  db.prepare(
    `INSERT INTO scheduled_tasks
     (id, user_id, assistant_id, name, prompt, schedule_json, timezone, provider,
      enabled, trigger_kind, connector_id, trigger_recipe, trigger_config_json,
      filter_json, external_trigger_id)
     VALUES ('task-1', 1, 1, 'Slack test', 'Analyze this', '{}', 'UTC', 'claude',
      1, 'event', 10, 'slack.dm.received', '{"channelId":"D123ABC"}', '[]', 'ti_123')`,
  ).run();

  const app = express();
  app.use(
    '/webhooks/composio',
    createComposioWebhookRouter({
      db,
      config: { composioApiKey: 'test-key', composioWebhookSecret: SECRET },
      secrets: { getApiKeyOverride: () => null },
    } as unknown as AppContext),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
  db.close();
});

async function deliver(body: string, valid = true) {
  const webhookId = 'msg_delivery_1';
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest('base64');
  return fetch(`${base}/webhooks/composio`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': webhookId,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${valid ? signature : 'invalid'}`,
      'x-composio-webhook-version': 'V3',
    },
    body,
  });
}

describe('Composio webhook ingress', () => {
  it('verifies, allowlists, and durably deduplicates trigger deliveries', async () => {
    const body = JSON.stringify({
      id: 'evt_123',
      type: 'composio.trigger.message',
      timestamp: new Date().toISOString(),
      metadata: {
        log_id: 'log_123',
        trigger_slug: 'SLACK_CHANNEL_MESSAGE_RECEIVED',
        trigger_id: 'ti_123',
        connected_account_id: 'ca_slack',
        auth_config_id: 'ac_123',
        user_id: 'a@x.com',
      },
      data: {
        message: 'This message has more than four words',
        sender: { id: 'U123', name: 'Taylor', secret: 'drop-me' },
        token: 'drop-me',
      },
    });
    expect((await deliver(body)).status).toBe(202);
    expect((await deliver(body)).status).toBe(202);

    const rows = db.prepare('SELECT * FROM automation_events').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'evt_123',
      scheduled_task_id: 'task-1',
      external_trigger_id: 'ti_123',
      status: 'pending',
    });
    expect(String(rows[0]!.payload_json)).toContain('This message has more than four words');
    expect(String(rows[0]!.payload_json)).not.toContain('drop-me');
  });

  it('rejects invalid signatures without writing an event', async () => {
    const body = JSON.stringify({
      id: 'evt_bad',
      type: 'composio.trigger.message',
      timestamp: new Date().toISOString(),
      metadata: {},
      data: {},
    });
    expect((await deliver(body, false)).status).toBe(401);
    expect(db.prepare('SELECT COUNT(*) AS count FROM automation_events').get()).toEqual({ count: 0 });
  });
});
