import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express, { type Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import type { ConversationWakeupRow } from '../src/db/db.js';
import { createApiRouter } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const WAKEUP_ID = '11111111-1111-4111-8111-111111111111';

let server: Server;
let base: string;
let db: Database.Database;
const wakeup: ConversationWakeupRow = {
  id: WAKEUP_ID,
  conversation_id: 'member-chat',
  actor_user_id: 1,
  wake_key: 'monitor',
  reason: 'Check the build',
  scheduled_for: '2026-07-29T20:00:00.000Z',
  status: 'pending',
  created_at: '2026-07-29 19:59:00',
  delivered_at: null,
  cancelled_at: null,
};
const scheduleWakeup = vi.fn(async () => ({ ok: true as const, wakeup, replacedWakeupId: null }));
const listWakeups = vi.fn(async () => [wakeup]);
const cancelWakeup = vi.fn(async () => ({
  ok: true as const,
  wakeup: { ...wakeup, status: 'cancelled' as const, cancelled_at: '2026-07-29 19:59:30' },
}));
const rescheduleWakeup = vi.fn(async () => ({ ok: true as const, wakeup }));
const fireWakeup = vi.fn(async () => ({
  ok: true as const,
  wakeup: { ...wakeup, status: 'delivered' as const, delivered_at: '2026-07-29 19:59:40' },
}));

async function call(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  pathName: string,
  agentConversationId?: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}/api${pathName}`, {
    method,
    headers: {
      ...(agentConversationId ? { 'x-test-conversation': agentConversationId } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'member@example.com', 'Member', 'member')").run();
  db.prepare(
    `INSERT INTO conversations
     (id, assistant_id, user_id, title, provider, native_session_id)
     VALUES ('member-chat', 1, 1, 'Wake route', 'codex', 'codex-wake'),
            ('other-chat', 1, 1, 'Other', 'claude', 'claude-other')`,
  ).run();
  db.prepare(
    `INSERT INTO conversation_wakeups
       (id, conversation_id, actor_user_id, wake_key, reason, scheduled_for, status)
     VALUES (?, 'member-chat', 1, 'monitor', 'Check the build', '2026-07-29T20:00:00.000Z', 'pending')`,
  ).run(WAKEUP_ID);

  const ctx = {
    db,
    resolveIdentity: async (req: Request) => {
      const conversationId = req.headers['x-test-conversation'];
      return {
        email: 'member@example.com',
        ...(typeof conversationId === 'string' ? { agentConversationId: conversationId } : {}),
      };
    },
    manager: {
      statusOf: async () => 'idle',
      scheduleWakeup,
      listWakeups,
      cancelWakeup,
      rescheduleWakeup,
      fireWakeup,
    },
  } as unknown as AppContext;
  const app = express();
  app.use('/api', createApiRouter(ctx));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

describe('agent wake-up routes', () => {
  it('marks only the matching conversation in the chat list', async () => {
    const response = await call('GET', '/conversations');
    const conversations = response.json.conversations as Array<{ id: string; hasPendingWakeup: boolean }>;

    expect(conversations.find((conversation) => conversation.id === 'member-chat')?.hasPendingWakeup).toBe(true);
    expect(conversations.find((conversation) => conversation.id === 'other-chat')?.hasPendingWakeup).toBe(false);
  });

  it('schedules by delay for the exact current agent conversation', async () => {
    const before = Date.now();
    const response = await call('POST', '/conversations/member-chat/wakeups', 'member-chat', {
      delaySeconds: 10,
      reason: 'Check the build',
      key: 'monitor',
    });
    expect(response).toMatchObject({
      status: 201,
      json: { ok: true, wakeup: { id: WAKEUP_ID } },
    });
    expect(scheduleWakeup).toHaveBeenCalledWith(
      'member-chat',
      1,
      'monitor',
      'Check the build',
      expect.any(String),
    );
    const scheduledFor = Date.parse(scheduleWakeup.mock.calls.at(-1)?.[4] ?? '');
    expect(scheduledFor).toBeGreaterThanOrEqual(before + 9_000);
    expect(scheduledFor).toBeLessThanOrEqual(Date.now() + 11_000);
  });

  it('rejects ambiguous timing and another chat identity', async () => {
    expect(
      await call('POST', '/conversations/member-chat/wakeups', 'member-chat', {
        delaySeconds: 10,
        runAt: '2026-07-29T20:00:00Z',
        reason: 'Ambiguous',
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await call('POST', '/conversations/member-chat/wakeups', 'other-chat', {
        delaySeconds: 10,
        reason: 'Wrong chat',
      }),
    ).toMatchObject({ status: 403 });
  });

  it('lists and cancels by exact wake id', async () => {
    expect(await call('GET', '/conversations/member-chat/wakeups', 'member-chat')).toMatchObject({
      status: 200,
      json: { ok: true, wakeups: [{ id: WAKEUP_ID, status: 'pending' }] },
    });
    expect(
      await call('DELETE', `/conversations/member-chat/wakeups/${WAKEUP_ID}`, 'member-chat'),
    ).toMatchObject({
      status: 200,
      json: { ok: true, wakeup: { id: WAKEUP_ID, status: 'cancelled' } },
    });
    expect(cancelWakeup).toHaveBeenCalledWith('member-chat', WAKEUP_ID);
  });
  it('lets the signed-in owner list, move, and fire without an agent token', async () => {
    expect(await call('GET', '/conversations/member-chat/wakeups')).toMatchObject({ status: 200 });
    const runAt = new Date(Date.now() + 600_000).toISOString();
    expect(
      await call('PATCH', `/conversations/member-chat/wakeups/${WAKEUP_ID}`, undefined, { runAt }),
    ).toMatchObject({ status: 200, json: { ok: true } });
    expect(rescheduleWakeup).toHaveBeenCalledWith('member-chat', WAKEUP_ID, runAt);
    expect(
      await call('POST', `/conversations/member-chat/wakeups/${WAKEUP_ID}/fire`),
    ).toMatchObject({ status: 200, json: { ok: true, wakeup: { status: 'delivered' } } });
    expect(fireWakeup).toHaveBeenCalledWith('member-chat', WAKEUP_ID);
  });

  it('keeps another agent chat out of the new routes and maps scheduler errors', async () => {
    expect(
      await call('POST', `/conversations/member-chat/wakeups/${WAKEUP_ID}/fire`, 'other-chat'),
    ).toMatchObject({ status: 403 });
    expect(
      await call('PATCH', `/conversations/member-chat/wakeups/${WAKEUP_ID}`, undefined, {
        runAt: new Date(Date.now() + 600_000).toISOString(),
        delaySeconds: 60,
      }),
    ).toMatchObject({ status: 400 });

    rescheduleWakeup.mockResolvedValueOnce({ ok: false, error: 'not_found' } as never);
    expect(
      await call('PATCH', `/conversations/member-chat/wakeups/${WAKEUP_ID}`, undefined, { delaySeconds: 60 }),
    ).toMatchObject({ status: 404 });
    rescheduleWakeup.mockResolvedValueOnce({ ok: false, error: 'not_pending' } as never);
    expect(
      await call('PATCH', `/conversations/member-chat/wakeups/${WAKEUP_ID}`, undefined, { delaySeconds: 60 }),
    ).toMatchObject({ status: 409 });
    rescheduleWakeup.mockResolvedValueOnce({ ok: false, error: 'invalid_time' } as never);
    expect(
      await call('PATCH', `/conversations/member-chat/wakeups/${WAKEUP_ID}`, undefined, { delaySeconds: 60 }),
    ).toMatchObject({ status: 400 });
    fireWakeup.mockResolvedValueOnce({ ok: false, error: 'not_pending' } as never);
    expect(
      await call('POST', `/conversations/member-chat/wakeups/${WAKEUP_ID}/fire`),
    ).toMatchObject({ status: 409 });
  });
});
