import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import express from 'express';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { ConversationRow } from '../src/db/db.js';
import type { AppContext } from '../src/context.js';
import { createApiRouter } from '../src/routes/api.js';
import { ensureCoordination } from '../src/coordination/store.js';
import {
  canViewConversation,
  canSendToConversation,
  canManageConversation,
} from '../src/conversations/access.js';
import { markTurnFinished } from '../src/conversations/unread.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import {
  mintAgentToken,
  resolveAgentTokenContext,
} from '../src/runtime/agentTokens.js';
import type { ProviderAdapter, TurnSpec } from '../src/providers/types.js';

const migrations = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/db/migrations',
);
let db: Database.Database;
const row = (id: string) =>
  db
    .prepare('SELECT * FROM conversations WHERE id=?')
    .get(id) as ConversationRow;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, migrations);
  db.prepare(
    "INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.com','Owner','owner'),(2,'other@example.com','Other','member')",
  ).run();
  for (const id of ['clara', 'grant'])
    db.prepare(
      "INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,channel,visibility) VALUES(?,1,1,?,'claude',?,'web','team')",
    ).run(id, id, `session-${id}`);
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 0));
  db.close();
});

describe('coordination identity and history', () => {
  it('reuses one thread in both directions with separate native sessions and no copied grants', () => {
    const first = ensureCoordination(db, row('grant'), row('clara'));
    const retry = ensureCoordination(db, row('grant'), row('clara'));
    const reply = ensureCoordination(db, row('clara'), row('grant'));
    expect(retry).toEqual(first);
    expect(reply.thread.id).toBe(first.thread.id);
    expect(reply.lane.conversation_id).not.toBe(first.lane.conversation_id);
    expect(row(first.lane.conversation_id).native_session_id).not.toBe(
      row('clara').native_session_id,
    );
    expect(
      db.prepare('SELECT count(*) n FROM bot_registrations').get(),
    ).toEqual({ n: 0 });
    const token = mintAgentToken(
      db,
      'owner@example.com',
      'clara',
      first.lane.conversation_id,
    );
    const context = resolveAgentTokenContext(db, token);
    expect(context?.conversationId).toBe('clara');
    expect(context?.executionConversationId).toBe(first.lane.conversation_id);
  });
  it('requires current access to both parents, never permits ordinary sends into internal sessions, and stays quiet', () => {
    const { lane } = ensureCoordination(db, row('grant'), row('clara'));
    const worker = row(lane.conversation_id);
    expect(canViewConversation({ id: 2 }, worker, db)).toBe(true);
    expect(canSendToConversation({ id: 1 }, worker, db)).toBe(false);
    expect(canManageConversation({ id: 1 }, worker, db)).toBe(true);
    markTurnFinished(db, worker, []);
    expect(
      db.prepare('SELECT * FROM conversation_last_seen').all(),
    ).toHaveLength(0);
    db.prepare(
      "UPDATE conversations SET visibility='private' WHERE id='grant'",
    ).run();
    expect(canViewConversation({ id: 2 }, worker, db)).toBe(false);
    expect(canManageConversation({ id: 2 }, worker, db)).toBe(false);
  });
});

it('deletes internal sessions when either participant is deleted, without orphaning their private history',()=>{
  const first=ensureCoordination(db,row('grant'),row('clara'));
  const second=ensureCoordination(db,row('clara'),row('grant'));
  db.prepare('DELETE FROM conversations WHERE id=?').run('grant');
  expect(row(first.lane.conversation_id)).toBeUndefined();
  expect(row(second.lane.conversation_id)).toBeUndefined();
  expect(db.prepare('SELECT * FROM coordination_threads').all()).toHaveLength(0);
});

describe('coordination scheduler', () => {
  it('never steers a human turn, prioritizes queued human work, retains canonical authority and isolates session output', async () => {
    const turns: Array<{ spec: TurnSpec; finish: () => void }> = [];
    const adapter: ProviderAdapter = {
      id: 'claude',
      mintSessionId: () => crypto.randomUUID(),
      readTranscript: async () => [],
      runTurn(spec) {
        let finish!: () => void;
        const done = new Promise<void>((r) => (finish = r));
        turns.push({ spec, finish });
        return {
          done,
          kill: () => finish(),
          steer: async () => {
            throw Error('Must not steer');
          },
          respondToApproval: () => true,
        };
      },
    };
    const materialize = vi.fn((_workspace, token: string, id: string) => {
      const identity = resolveAgentTokenContext(db, token);
      expect(identity?.conversationId).toBe(id);
      return {
        mcpConfigPath: null,
        settingsPath: null,
        developerInstructions: 'fixed instructions',
        instructionHash: null,
      };
    });
    const manager = createConversationManager({
      db,
      adapters: { claude: adapter },
      resolveWorkspace: () => ({
        workspaceDir: '/tmp',
        assistantSlug: 'assistant',
        elevated: false,
      }),
      materialize,
      log: { warn: () => {}, error: () => {} },
    });
    const { lane } = ensureCoordination(db, row('grant'), row('clara'));
    manager.postMessage(row('clara'), 'Human first');
    const origin = {
      kind: 'agent' as const,
      from: 'Grant',
      to: 'Clara',
      sourceConversationId: 'grant',
    };
    const sent = manager.queueMessage(
      row(lane.conversation_id),
      'Grant lookup',
      1,
      origin,
      'lookup-1',
    );
    expect(sent.disposition).toBe('queued');
    expect(
      manager.queueMessage(
        row(lane.conversation_id),
        'Grant lookup',
        1,
        origin,
        'lookup-1',
      ).disposition,
    ).toBe('duplicate');
    expect(() =>
      manager.queueMessage(
        row(lane.conversation_id),
        'Changed',
        1,
        origin,
        'lookup-1',
      ),
    ).toThrow('different message');
    manager.postMessage(row('clara'), 'Human second');
    expect(turns).toHaveLength(1);
    turns[0]!.finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(turns).toHaveLength(2);
    expect(turns[1]!.spec.nativeSessionId).toBe('session-clara');
    turns[1]!.finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(turns).toHaveLength(3);
    expect(turns[2]!.spec.nativeSessionId).toBe(
      row(lane.conversation_id).native_session_id,
    );
    expect(materialize.mock.calls[2]?.[2]).toBe('clara');
    expect(turns[2]!.spec.developerInstructions).toContain(
      'separate bot coordination thread',
    );
    turns[2]!.finish();
    await new Promise((r) => setTimeout(r, 0));
  });
  it('drops queued coordination if source access is revoked before execution', async () => {
    let finish!: () => void;
    const run = vi.fn(() => ({
      done: new Promise<void>((r) => (finish = r)),
      kill: () => {},
      respondToApproval: () => true,
    }));
    const adapter: ProviderAdapter = {
      id: 'claude',
      mintSessionId: () => crypto.randomUUID(),
      readTranscript: async () => [],
      runTurn: run,
    };
    const manager = createConversationManager({
      db,
      adapters: { claude: adapter },
      resolveWorkspace: () => ({
        workspaceDir: '/tmp',
        assistantSlug: 'assistant',
        elevated: false,
      }),
      log: { warn: () => {}, error: () => {} },
    });
    const { lane } = ensureCoordination(db, row('grant'), row('clara'));
    manager.postMessage(row('clara'), 'Human');
    manager.postMessage(row(lane.conversation_id), 'Background', 2);
    db.prepare(
      "UPDATE conversations SET visibility='private' WHERE id='grant'",
    ).run();
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(run).toHaveBeenCalledTimes(1);
    expect(manager.queueSnapshot(lane.conversation_id).messages).toHaveLength(
      0,
    );
  });
});

it('routes authenticated bot messages and replies to workers while human steering remains unchanged', async () => {
  let identity: {
    email: string;
    agentConversationId?: string;
    agentExecutionConversationId?: string;
  } = { email: 'owner@example.com', agentConversationId: 'grant' };
  let n = 0;
  const postMessage = vi.fn(async () => ({
    messageId: ++n,
    disposition: 'queued',
    queue: { revision: 1, messages: [], failedTurn: null },
  }));
  const steerMessage = vi.fn(async () => ({
    messageId: ++n,
    disposition: 'steered',
  }));
  const ctx = {
    db,
    manager: {
      queueMessage: postMessage,
      steerMessage,
      statusOf: async () => 'idle',
      snapshot: async () => [],
      scheduleWakeup: vi.fn(async (id: string) => ({
        ok: true,
        executionId: id,
      })),
    },
    resolveIdentity: async () => identity,
  } as unknown as AppContext;
  const app = express();
  app.use('/api', createApiRouter(ctx));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (id: string) =>
    fetch(`${base}/api/conversations/${id}/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Lookup' }),
    });
  try {
    const first = (await (await send('clara')).json()) as {
      coordinationThreadId: string;
    };
    expect(first.coordinationThreadId).toBeTruthy();
    expect(steerMessage).not.toHaveBeenCalled();
    const worker = (postMessage.mock.calls as unknown as string[][])[0]![0]!;
    expect(worker).not.toBe('clara');
    identity = {
      email: 'owner@example.com',
      agentConversationId: 'clara',
      agentExecutionConversationId: worker,
    };
    const reply = (await (await send('grant')).json()) as {
      coordinationThreadId: string;
    };
    expect(reply.coordinationThreadId).toBe(first.coordinationThreadId);
    expect((await send('clara')).status).toBe(400);
    const wake = await fetch(`${base}/api/conversations/clara/wakeups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: 'follow-up',
        reason: 'Read the result',
        delaySeconds: 120,
      }),
    });
    expect(wake.status).toBe(201);
    expect((await wake.json()).executionId).toBe(worker);

    db.prepare("UPDATE conversations SET visibility='private',user_id=2 WHERE id='grant'").run();
    expect((await fetch(`${base}/api/conversations/clara/transcript`)).status).toBe(403);
    db.prepare("UPDATE conversations SET visibility='team',user_id=1 WHERE id='grant'").run();
    identity = { email: 'owner@example.com' };
    await send('clara');
    expect(steerMessage).toHaveBeenCalledTimes(1);
    identity = { email: 'other@example.com' };
    db.prepare(
      "UPDATE conversations SET visibility='private' WHERE id='grant'",
    ).run();
    expect(
      (await fetch(`${base}/api/coordination/${first.coordinationThreadId}`))
        .status,
    ).toBe(404);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
});
