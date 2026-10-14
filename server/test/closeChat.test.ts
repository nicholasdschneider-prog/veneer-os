import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express, { type Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { createApiRouter } from '../src/routes/api.js';
import { indexDocument, searchWork } from '../src/botWorkflows/search.js';
import { callCloseChatTool } from '../src/mcp/closeChatTool.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let server: Server;
let base: string;
let db: Database.Database;
let ctx: AppContext;
let nextMessageId = 100;
const queueMessage = vi.fn(async () => ({ messageId: nextMessageId++, disposition: 'queued' }));

async function close(
  conversationId: string,
  body: Record<string, unknown>,
  agentConversationId: string | null = conversationId,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/conversations/${conversationId}/close`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(agentConversationId ? { 'x-test-conversation': agentConversationId } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function chat(id: string, extra: Record<string, unknown> = {}): void {
  const columns = ['id', 'assistant_id', 'user_id', 'title', 'provider', 'native_session_id', ...Object.keys(extra)];
  db.prepare(
    `INSERT INTO conversations (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
  ).run(id, 1, 1, `Chat ${id}`, 'claude', `native-${id}`, ...Object.values(extra));
}

function archived(id: string): number {
  return (db.prepare('SELECT archived FROM conversations WHERE id=?').get(id) as { archived: number }).archived;
}

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  ctx = {
    db,
    resolveIdentity: async (req: Request) => {
      const conversationId = req.headers['x-test-conversation'];
      return {
        email: 'owner@example.com',
        ...(typeof conversationId === 'string' ? { agentConversationId: conversationId } : {}),
      };
    },
    manager: {
      statusOf: async () => 'idle',
      queueMessage,
      interrupt: vi.fn(async () => {}),
      bus: { emit: vi.fn() },
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

beforeEach(() => {
  queueMessage.mockClear();
});

describe('close_chat', () => {
  it('reports to the requester, archives the chat, finishes its todo, and repeats return the same result', async () => {
    chat('requester');
    chat('issue', { origin_conversation_id: 'requester', pin_order: null });
    db.prepare("INSERT INTO todos (id, title, state, conversation_id) VALUES ('todo-1', 'Issue', 'active', 'issue')").run();

    const first = await close('issue', { report: 'Fixed and verified.' });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ ok: true, alreadyClosed: false, closure: { report_to: 'requester', report: 'Fixed and verified.' } });
    expect(queueMessage).toHaveBeenCalledTimes(1);
    expect(queueMessage.mock.calls[0]).toContain('Fixed and verified.');
    expect(archived('issue')).toBe(1);
    expect((db.prepare("SELECT state FROM todos WHERE id='todo-1'").get() as { state: string }).state).toBe('done');
    // Never deleted.
    expect(db.prepare("SELECT 1 FROM conversations WHERE id='issue'").get()).toBeTruthy();

    const again = await close('issue', { report: 'Different text' });
    expect(again.json).toMatchObject({ ok: true, alreadyClosed: true, closure: { report: 'Fixed and verified.' } });
    expect(queueMessage).toHaveBeenCalledTimes(1);
  });

  it('records the report without sending when report_to is null', async () => {
    chat('solo');
    const result = await close('solo', { report: 'Done.', report_to: null });
    expect(result.json).toMatchObject({ ok: true, closure: { report_to: null, report_thread_id: null } });
    expect(queueMessage).not.toHaveBeenCalled();
    expect(archived('solo')).toBe(1);
  });

  it('closes only the calling chat', async () => {
    chat('caller');
    chat('victim');
    expect((await close('victim', { report: 'x' }, 'caller')).status).toBe(403);
    expect((await close('victim', { report: 'x' }, null)).status).toBe(403);
    expect(archived('victim')).toBe(0);
  });

  it('never closes a registered bot standing chat, a pinned chat or an automation chat', async () => {
    chat('standing');
    db.prepare("INSERT INTO bot_registrations (conversation_id, name, registered_by) VALUES ('standing', 'Boris', 1)").run();
    chat('pinned', { pin_order: -1 });
    chat('automated', { channel: 'automation' });
    for (const id of ['standing', 'pinned', 'automated']) {
      const result = await close(id, { report: 'x', report_to: null });
      expect(result.status).toBe(409);
      expect(result.json.refused).toBe('not_closable');
      expect(archived(id)).toBe(0);
    }
  });

  it('refuses with every live blocker and its ids', async () => {
    chat('busy');
    db.prepare(
      `INSERT INTO conversation_wakeups (id, conversation_id, wake_key, reason, scheduled_for)
       VALUES ('wake-1', 'busy', 'k', 'check', '2099-01-01T00:00:00Z')`,
    ).run();
    const build = db
      .prepare("INSERT INTO build_queue (user_id, conversation_id, title, brief, status) VALUES (1, 'busy', 't', 'b', 'queued')")
      .run().lastInsertRowid;
    db.prepare(
      `INSERT INTO questions (request_id, conversation_id, turn_id, response_mode, questions_json)
       VALUES ('q-1', 'busy', 'turn', 'poll', '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO bot_message_drafts (id, conversation_id, request_key, payload_json, state, authorized_by)
       VALUES ('draft-1', 'busy', 'rk', '{}', 'draft', 1)`,
    ).run();
    db.prepare("INSERT INTO queued_messages (id, conversation_id, prompt) VALUES (900, 'busy', 'hi')").run();

    const result = await close('busy', { report: 'x', report_to: null });
    expect(result.status).toBe(409);
    expect(result.json.refused).toBe('blocked');
    const blockers = result.json.blockers as Array<{ kind: string; ids: string[] }>;
    expect(blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'pending_wakeup', ids: ['wake-1'] }),
        expect.objectContaining({ kind: 'active_build', ids: [String(build)] }),
        expect.objectContaining({ kind: 'pending_question', ids: ['q-1'] }),
        expect.objectContaining({ kind: 'undelivered_message', ids: ['draft-1'] }),
        expect.objectContaining({ kind: 'queued_message', ids: ['900'] }),
      ]),
    );
    expect(String(result.json.error)).toContain('wake-1');
    expect(archived('busy')).toBe(0);
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it('treats approved decisions as open and withdrawn ones as closed', async () => {
    chat('decider');
    db.prepare("INSERT INTO bot_registrations (conversation_id, name, registered_by, active) VALUES ('decider', 'Retired', 1, 0)").run();
    const insert = db.prepare(
      `INSERT INTO bot_decisions (id, conversation_id, source_key, proposal_key, state, proposal_json, assignee_id, answer_json)
       VALUES (?, 'decider', 's', ?, ?, '{}', 1, ?)`,
    );
    insert.run('d-open', 'p1', 'decided', JSON.stringify({ action: 'approve' }));
    insert.run('d-withdrawn', 'p2', 'decided', JSON.stringify({ action: 'withdraw' }));
    insert.run('d-done', 'p3', 'verified_completed', null);
    const blocked = await close('decider', { report: 'x', report_to: null });
    expect(blocked.json.blockers).toEqual([expect.objectContaining({ kind: 'open_decision', ids: ['d-open'] })]);

    db.prepare("UPDATE bot_decisions SET state='verified_completed' WHERE id='d-open'").run();
    expect((await close('decider', { report: 'x', report_to: null })).status).toBe(200);
  });

  it('refuses an approved message delegation that was never sent or revoked', async () => {
    chat('executor');
    chat('owner-bot');
    db.prepare("INSERT INTO bot_registrations (conversation_id, name, registered_by) VALUES ('owner-bot', 'Owner bot', 1)").run();
    db.prepare(
      `INSERT INTO bot_decisions (id, conversation_id, source_key, proposal_key, state, proposal_json, assignee_id)
       VALUES ('d-msg', 'owner-bot', 's', 'p', 'verified_completed', '{}', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO bot_decision_events (id, decision_id, version, kind, actor_id, payload_json, request_key)
       VALUES ('ev-1', 'd-msg', 1, 'answered', 1, '{}', 'k')`,
    ).run();
    db.prepare(
      `INSERT INTO bot_message_delegations (id, decision_id, decision_version, owner_conversation_id, executor_conversation_id,
         executor_user_id, delegator_user_id, approver_user_id, approval_event_id, proposal_hash, payload_hash, scope_json, request_key)
       VALUES ('del-1', 'd-msg', 1, 'owner-bot', 'executor', 1, 1, 1, 'ev-1', 'h', 'h', '{}', 'rk')`,
    ).run();
    const result = await close('executor', { report: 'x', report_to: null });
    expect(result.json.blockers).toEqual([expect.objectContaining({ kind: 'undelivered_message', ids: ['del-1'] })]);
  });

  it('requires a deployment statement after a finished build and proof that waiting chats were told', async () => {
    chat('boss');
    chat('waiting-bot');
    chat('builder', { origin_conversation_id: 'boss' });
    db.prepare(
      `INSERT INTO build_queue (user_id, conversation_id, title, brief, status, finished_at)
       VALUES (1, 'builder', 't', 'b', 'done', datetime('now', '-1 hour'))`,
    ).run();

    const missing = await close('builder', { report: 'Pushed.', report_to: null });
    expect(missing.json.blockers).toEqual([expect.objectContaining({ kind: 'deployment_status_required' })]);

    // Pending with the requester not told (report recorded only) is refused.
    const untold = await close('builder', {
      report: 'Pushed.',
      report_to: null,
      deployment: { status: 'pending', notified_conversation_ids: ['waiting-bot'] },
    });
    expect(untold.json.blockers).toEqual([
      expect.objectContaining({ kind: 'deployment_not_reported', ids: ['waiting-bot', 'boss'] }),
    ]);

    // A message sent before the build finished does not count; one after it does.
    const receipt = db.prepare(
      `INSERT INTO agent_message_receipts (source_conversation_id, target_conversation_id, message_id, message_text, disposition, created_at)
       VALUES ('builder', 'waiting-bot', ?, 'deploy pending', 'queued', ?)`,
    );
    receipt.run(1, '2000-01-01 00:00:00');
    const stale = await close('builder', {
      report: 'Pushed.',
      deployment: { status: 'pending', notified_conversation_ids: ['waiting-bot'] },
    });
    expect(stale.json.blockers).toEqual([expect.objectContaining({ kind: 'deployment_not_reported', ids: ['waiting-bot'] })]);
    receipt.run(2, new Date().toISOString().replace('T', ' ').slice(0, 19));

    // The report itself tells the requester (default report_to = origin chat).
    const ok = await close('builder', {
      report: 'Pushed, deployment pending an approved window.',
      deployment: { status: 'pending', notified_conversation_ids: ['waiting-bot'] },
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ closure: { report_to: 'boss' } });
    expect(JSON.parse(String((ok.json.closure as Record<string, unknown>).deployment_json))).toEqual({
      status: 'pending',
      notifiedConversationIds: ['waiting-bot'],
    });
  });

  it('keeps archived chats searchable', async () => {
    chat('searchable');
    indexDocument(ctx, 'doc-1', 'searchable', 'assistant', 'Resolved ticket ZQXHYGIENE', '2026-10-14T12:00:00Z', '#/chat/searchable');
    expect((await close('searchable', { report: 'Done', report_to: null })).status).toBe(200);
    expect(archived('searchable')).toBe(1);
    const user = db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
    expect(searchWork(ctx, user, 'ZQXHYGIENE').results.map((r) => r.conversation_id)).toEqual(['searchable']);
  });

  it('tool passes the refusal text and confirms success', async () => {
    const refused = await callCloseChatTool({
      name: 'close_chat',
      args: { report: 'x' },
      sourceConversationId: 'c',
      callApi: async () => {
        throw new Error('This chat still owns live work. pending_wakeup [w1]: Cancel');
      },
    });
    expect(refused).toMatchObject({ isError: true });
    expect(refused?.content[0]?.text).toContain('pending_wakeup [w1]');

    const calls: Array<[string, RequestInit | undefined]> = [];
    const ok = await callCloseChatTool({
      name: 'close_chat',
      args: { report: ' Done ', report_to: null, deployment: { status: 'none' } },
      sourceConversationId: 'c',
      callApi: async (p, init) => {
        calls.push([p, init]);
        return { ok: true, alreadyClosed: false, closure: { report_to: null, closed_at: 'now' } };
      },
    });
    expect(calls[0]?.[0]).toBe('/api/conversations/c/close');
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ report: 'Done', report_to: null, deployment: { status: 'none' } });
    expect(ok?.content[0]?.text).toContain('Chat closed and archived');
    expect(await callCloseChatTool({ name: 'other', args: {}, sourceConversationId: 'c', callApi: async () => ({}) })).toBeNull();
  });
});
