import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express, { type Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import type { CompactConversationResult } from '../src/runtime/conversationManager.js';
import { createApiRouter } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let server: Server;
let base: string;
let db: Database.Database;
const compactConversation = vi.fn<(id: string) => Promise<CompactConversationResult>>();

async function compact(
  id: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/conversations/${id}/compact`, {
    method: 'POST',
    headers,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (2, 'other@example.com', 'Other', 'member')").run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, visibility, title, provider, native_session_id, archived)
     VALUES ('ready', 1, 1, 'private', 'Ready', 'claude', 'session-ready', 0),
            ('archived', 1, 1, 'private', 'Archived', 'codex', 'thread-old', 1),
            ('private-other', 1, 2, 'private', 'Private', 'claude', 'session-private', 0)`,
  ).run();

  const ctx = {
    db,
    resolveIdentity: async (req: Request) => {
      if (req.headers['x-no-auth']) return null;
      return {
        email: 'owner@example.com',
        ...(typeof req.headers['x-agent-chat'] === 'string'
          ? { agentConversationId: req.headers['x-agent-chat'] }
          : {}),
      };
    },
    manager: {
      statusOf: async () => 'idle',
      compactConversation,
    },
  } as unknown as AppContext;
  const app = express();
  app.use('/api', createApiRouter(ctx));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  compactConversation.mockReset();
  compactConversation.mockResolvedValue({ ok: true, contextTokens: null });
});

afterAll(() => {
  server.close();
  db.close();
});

describe('manual compaction route', () => {
  it('requires authentication and management access', async () => {
    expect((await compact('ready', { 'x-no-auth': '1' })).status).toBe(403);
    expect((await compact('private-other')).status).toBe(404);
    expect(compactConversation).not.toHaveBeenCalled();
  });

  it('compacts a manageable active chat and returns the refreshed usage value', async () => {
    compactConversation.mockResolvedValue({ ok: true, contextTokens: 1234 });
    await expect(compact('ready')).resolves.toEqual({
      status: 200,
      body: { ok: true, contextTokens: 1234 },
    });
    expect(compactConversation).toHaveBeenCalledWith('ready');
  });

  it('rejects agent-token and archived-chat calls before reaching the runner', async () => {
    expect((await compact('ready', { 'x-agent-chat': 'ready' })).status).toBe(403);
    expect((await compact('archived')).status).toBe(409);
    expect(compactConversation).not.toHaveBeenCalled();
  });

  it('maps busy, unsupported, and provider failures to explicit safe responses', async () => {
    compactConversation.mockResolvedValueOnce({
      ok: false,
      error: 'working',
      message: 'Wait for the current reply to finish.',
    });
    expect(await compact('ready')).toMatchObject({
      status: 409,
      body: { ok: false, code: 'working', error: 'Wait for the current reply to finish.' },
    });

    compactConversation.mockResolvedValueOnce({
      ok: false,
      error: 'unsupported',
      message: 'Context compaction is not available for grok.',
    });
    expect(await compact('ready')).toMatchObject({
      status: 501,
      body: { ok: false, code: 'unsupported' },
    });

    compactConversation.mockResolvedValueOnce({
      ok: false,
      error: 'failed',
      message: 'The provider disconnected while compacting. Try again.',
    });
    expect(await compact('ready')).toMatchObject({
      status: 502,
      body: { ok: false, code: 'failed' },
    });
  });
});
