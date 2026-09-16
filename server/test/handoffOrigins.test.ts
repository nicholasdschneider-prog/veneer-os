import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express, { type Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import { createApiRouter } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let db: Database.Database;
let server: Server;
let base: string;
const postedMessages: unknown[][] = [];

async function createConversation(
  agentConversationId: string | null,
  firstMessage: string,
  originConversationId?: string,
  id?: string,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${base}/api/conversations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(agentConversationId ? { 'x-test-conversation': agentConversationId } : {}),
    },
    body: JSON.stringify({
      firstMessage,
      ...(originConversationId ? { originConversationId } : {}),
      ...(id ? { id } : {}),
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

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
  const assistant = db.prepare("SELECT id FROM assistants WHERE slug = 'assistant'").get() as { id: number };
  const insertOrigin = db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES (?, ?, 1, ?, 'codex', ?, 'web')`,
  );
  insertOrigin.run('origin-chat', assistant.id, 'Origin', 'origin-native');
  insertOrigin.run('other-chat', assistant.id, 'Other', 'other-native');
  db.prepare("UPDATE conversations SET visibility = 'private' WHERE id = 'origin-chat'").run();
  db.prepare(
    `INSERT INTO conversations
       (id, assistant_id, user_id, visibility, title, provider, native_session_id, channel)
     VALUES ('team-destination', ?, 1, 'team', 'Team destination', 'codex', 'team-native', 'web')`,
  ).run(assistant.id);

  const ctx = {
    db,
    resolveIdentity: async (req: Request) => {
      const conversationId = req.headers['x-test-conversation'];
      return {
        email: req.headers['x-test-user'] === 'member' ? 'member@example.com' : 'owner@example.com',
        ...(typeof conversationId === 'string' ? { agentConversationId: conversationId } : {}),
      };
    },
    manager: {
      postMessage: async (...args: unknown[]) => {
        postedMessages.push(args);
      },
      steerMessage: async () => ({
        messageId: 42,
        disposition: 'steered',
        queue: { revision: 1, messages: [], failedTurn: null },
      }),
      statusOf: async () => 'idle',
      snapshot: async (conversationId: string) => conversationId === 'team-destination'
        ? [{
            type: 'turn_started',
            turnId: 'agent-turn',
            role: 'user',
            text: 'Private handoff',
            at: '2026-08-24T12:00:00.000Z',
            via: 'web',
            origin: {
              kind: 'agent',
              from: 'Assistant',
              to: 'Assistant',
              sourceConversationId: 'origin-chat',
              sourceConversationTitle: 'Origin',
            },
          }]
        : [],
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

afterAll(() => {
  server.close();
  db.close();
});

describe('handoff conversation origins', () => {
  it('uses a valid client id for optimistic sidebar reconciliation', async () => {
    const id = 'f2f95b9a-e219-4c4c-bb23-8e1b81f12d98';
    const response = await createConversation(null, 'Optimistic chat', undefined, id);

    expect(response.status).toBe(200);
    expect(response.body.conversation.id).toBe(id);
  });

  it('stores an explicit origin that matches the authenticated agent chat', async () => {
    const response = await createConversation('origin-chat', 'Valid handoff', 'origin-chat');

    expect(response.status).toBe(200);
    expect(response.body.conversation.originConversationId).toBe('origin-chat');
    expect(
      db.prepare('SELECT origin_conversation_id FROM conversations WHERE id = ?').get(response.body.conversation.id),
    ).toEqual({ origin_conversation_id: 'origin-chat' });
    const assistant = db.prepare("SELECT name FROM assistants WHERE slug = 'assistant'").get() as { name: string };
    expect(postedMessages.find((args) => args[1] === 'Valid handoff')).toEqual([
      response.body.conversation.id,
      'Valid handoff',
      1,
      {
        kind: 'agent',
        from: assistant.name,
        to: assistant.name,
        sourceConversationId: 'origin-chat',
        sourceConversationTitle: 'Origin',
      },
    ]);
  });

  it('keeps an agent-created chat top-level when no handoff origin is explicit', async () => {
    const response = await createConversation('origin-chat', 'Separate agent work');

    expect(response.status).toBe(200);
    expect(response.body.conversation.originConversationId).toBeNull();
  });

  it('authorizes source-chat metadata for each REST transcript viewer', async () => {
    const ownerResponse = await fetch(`${base}/api/conversations/team-destination/transcript`);
    const ownerBody = await ownerResponse.json() as Record<string, any>;
    expect(ownerBody.events[0].origin).toEqual({
      kind: 'agent',
      from: 'Assistant',
      to: 'Assistant',
      local: true,
      sourceChat: { id: 'origin-chat', title: 'Origin' },
    });

    const memberResponse = await fetch(`${base}/api/conversations/team-destination/transcript`, {
      headers: { 'x-test-user': 'member' },
    });
    const memberBody = await memberResponse.json() as Record<string, any>;
    expect(memberResponse.status).toBe(200);
    expect(memberBody.events[0].origin).toEqual({
      kind: 'agent',
      from: 'Assistant',
      to: 'Assistant',
      local: true,
    });
    expect(JSON.stringify(memberBody)).not.toContain('origin-chat');
    expect(JSON.stringify(memberBody)).not.toContain('"Origin"');
  });

  it('records a durable sender-side receipt after a local agent message is accepted', async () => {
    const response = await fetch(`${base}/api/conversations/team-destination/steer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-conversation': 'origin-chat',
      },
      body: JSON.stringify({ text: 'Exact outbound message.' }),
    });

    expect(response.status).toBe(200);
    expect(db.prepare(
      `SELECT source_conversation_id, target_conversation_id, message_id, message_text, disposition
         FROM agent_message_receipts`,
    ).get()).toEqual({
      source_conversation_id: 'origin-chat',
      target_conversation_id: 'team-destination',
      message_id: 42,
      message_text: 'Exact outbound message.',
      disposition: 'steered',
    });
  });

  it('rejects a handoff origin that does not match the authenticated agent chat', async () => {
    const response = await createConversation('other-chat', 'Mismatched handoff', 'origin-chat');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Handoff origin does not match the current agent chat');
  });

  it('rejects a matching stale origin that no longer exists', async () => {
    const response = await createConversation('deleted-chat', 'Stale handoff', 'deleted-chat');

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('Handoff origin is no longer available');
  });

  it('starts a fresh empty chat with the latest fixed settings snapshot', async () => {
    const assistant = db.prepare("SELECT id, instructions FROM assistants WHERE slug = 'assistant'").get() as {
      id: number;
      instructions: string;
    };
    try {
      db.prepare("UPDATE assistants SET instructions = 'Initial snapshot guidance.' WHERE id = ?").run(assistant.id);
      const created = await createConversation(null, 'Chat with old context');
      expect(created.status).toBe(200);
      const oldId = created.body.conversation.id as string;
      const oldSnapshot = db
        .prepare('SELECT instruction_snapshot_json FROM conversations WHERE id = ?')
        .get(oldId) as { instruction_snapshot_json: string };
      expect(oldSnapshot.instruction_snapshot_json).toContain('Initial snapshot guidance.');

      db.prepare("UPDATE assistants SET instructions = 'Latest snapshot guidance.' WHERE id = ?").run(assistant.id);
      const response = await fetch(`${base}/api/conversations/${oldId}/fresh-context`, { method: 'POST' });
      const body = (await response.json()) as Record<string, any>;
      expect(response.status).toBe(201);
      expect(body.conversation.id).not.toBe(oldId);
      const newSnapshot = db
        .prepare('SELECT instruction_snapshot_json FROM conversations WHERE id = ?')
        .get(body.conversation.id) as { instruction_snapshot_json: string };
      expect(newSnapshot.instruction_snapshot_json).toContain('Latest snapshot guidance.');
      expect(newSnapshot.instruction_snapshot_json).not.toContain('Initial snapshot guidance.');
      expect(oldSnapshot.instruction_snapshot_json).not.toContain('Latest snapshot guidance.');
    } finally {
      db.prepare('UPDATE assistants SET instructions = ? WHERE id = ?').run(assistant.instructions, assistant.id);
    }
  });
});
