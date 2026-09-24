import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { ApprovalRow, ConversationRow } from '../src/db/db.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import type { ApprovalDecision, ProviderAdapter, TurnSpec } from '../src/providers/types.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('owner@example.com', 'Sam', 'owner')").run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES ('conv-1', 1, 1, 'Test', 'claude', 'sid-1', 'web')`,
  ).run();
  return db;
}

/** Scriptable adapter: the test drives events; respond calls are recorded. */
function fakeAdapter() {
  const state = {
    onEvent: null as ((e: ConversationEvent) => void) | null,
    finishTurn: null as (() => void) | null,
    respondCalls: [] as { requestId: string; decision: ApprovalDecision }[],
    respondResult: true,
    transcript: [] as ConversationEvent[],
  };
  const adapter: ProviderAdapter = {
    id: 'claude',
    mintSessionId: () => 'sid',
    runTurn(_spec: TurnSpec, onEvent) {
      state.onEvent = onEvent;
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });
      state.finishTurn = () => {
        onEvent({ type: 'turn_done', turnId: _spec.turnId });
        resolveDone();
      };
      return {
        done,
        kill: () => resolveDone(),
        respondToApproval: (requestId, decision) => {
          state.respondCalls.push({ requestId, decision });
          return state.respondResult;
        },
      };
    },
    readTranscript: async () => state.transcript,
  };
  return { adapter, state };
}

function requestApproval(
  state: ReturnType<typeof fakeAdapter>['state'],
  requestId = 'req-1',
): Extract<ConversationEvent, { type: 'approval_requested' }> {
  const event: Extract<ConversationEvent, { type: 'approval_requested' }> = {
    type: 'approval_requested',
    requestId,
    toolName: 'Write',
    displayName: 'Writing a file',
    input: { file_path: '/outside/x.txt' },
    inputPreview: '{"file_path":"/outside/x.txt"}',
    policyReason: 'test',
  };
  state.onEvent!(event);
  return event;
}

const flush = () => new Promise((r) => setImmediate(r));

describe('conversation manager approvals', () => {
  let db: Database.Database;
  let conv: ConversationRow;
  let fake: ReturnType<typeof fakeAdapter>;
  let events: { conversationId: string; event: ConversationEvent }[];
  let manager: ReturnType<typeof createConversationManager>;

  function makeManager(approvalTimeoutMs = 60_000): void {
    manager = createConversationManager({
      db,
      adapters: { claude: fake.adapter },
      resolveWorkspace: () => ({ workspaceDir: '/tmp', assistantSlug: 'assistant', elevated: false }),
      approvalTimeoutMs,
      log: { warn: () => undefined, error: () => undefined },
    });
    events = [];
    manager.bus.on('event', (conversationId: string, event: ConversationEvent) =>
      events.push({ conversationId, event }),
    );
  }

  beforeEach(() => {
    db = openTestDb();
    conv = db.prepare("SELECT * FROM conversations WHERE id = 'conv-1'").get() as ConversationRow;
    // Most tests exercise ordinary Ask/Allow behavior. Full Access has its own
    // focused precedence case below.
    db.prepare('UPDATE assistants SET full_access = 0 WHERE id = ?').run(conv.assistant_id);
    fake = fakeAdapter();
  });

  it.each(['ask', 'auto'] as const)('routes MCP approvals through fresh %s mode without Full Access', (mode) => {
    db.prepare("UPDATE conversations SET approval_mode = ? WHERE id = ?").run(mode, conv.id);
    makeManager(); manager.postMessage(conv, 'fixture only');
    fake.state.onEvent!({ type: 'approval_requested', requestId: 'mcp-1', toolName: 'mcp_tool_call',
      displayName: 'Allow one MCP tool call', input: { serverName: 'fixture' }, inputPreview: 'read_fixture', policyReason: 'One call only' });
    const row = db.prepare('SELECT * FROM approvals').get() as ApprovalRow;
    expect(row.tool_name).toBe('mcp_tool_call');
    expect(row.status).toBe(mode === 'ask' ? 'pending' : 'approved');
    if (mode === 'ask') {
      expect(fake.state.respondCalls).toEqual([]);
      expect(manager.resolveApproval(row.id, 'denied', 1)).toEqual({ ok: true, status: 'denied' });
      db.prepare("UPDATE conversations SET approval_mode = 'auto' WHERE id = ?").run(conv.id);
      expect(manager.resolveApproval(row.id, 'approved', 1)).toEqual({ ok: false, error: 'not_pending' });
      expect(fake.state.respondCalls[0]?.decision.behavior).toBe('deny');
    } else expect(fake.state.respondCalls).toEqual([{ requestId: 'mcp-1', decision: { behavior: 'allow' } }]);
    expect(db.prepare('SELECT full_access FROM assistants WHERE id = ?').get(conv.assistant_id)).toEqual({ full_access: 0 });
  });

  it('records the approval, augments the event with approvalId, and derives needs_you', () => {
    makeManager();
    manager.postMessage(conv, 'do something risky');
    requestApproval(fake.state);

    const row = db.prepare('SELECT * FROM approvals').get() as ApprovalRow;
    expect(row.status).toBe('pending');
    expect(row.tool_name).toBe('Write');
    expect(row.conversation_id).toBe('conv-1');
    expect(JSON.parse(row.request_json)).toEqual({ file_path: '/outside/x.txt' });

    const requested = events.find((e) => e.event.type === 'approval_requested')?.event;
    expect(requested?.type === 'approval_requested' && requested.approvalId).toBe(row.id);
    expect(manager.statusOf('conv-1')).toBe('needs_you');
  });

  it('auto-approves with an audit row and no live or rehydrated client event', async () => {
    db.prepare("UPDATE assistants SET approval_mode = 'auto' WHERE id = ?").run(conv.assistant_id);
    makeManager();
    let statusEvents = 0;
    manager.bus.on('status', () => {
      statusEvents += 1;
    });
    manager.postMessage(conv, 'do something autonomously');
    const statusEventsBeforeApproval = statusEvents;
    const persistedRequest = requestApproval(fake.state);
    fake.state.transcript = [persistedRequest];

    const row = db.prepare('SELECT * FROM approvals').get() as ApprovalRow;
    expect(row.status).toBe('approved');
    expect(row.resolved_by).toBeNull();
    expect(row.resolved_at).toBeTruthy();
    expect(fake.state.respondCalls).toEqual([{ requestId: 'req-1', decision: { behavior: 'allow' } }]);
    expect(events.some((e) => e.event.type === 'approval_requested')).toBe(false);
    expect(statusEvents).toBe(statusEventsBeforeApproval);
    expect(manager.statusOf('conv-1')).toBe('working');
    expect((await manager.snapshot(conv)).some((event) => event.type === 'approval_requested')).toBe(false);
  });

  it('rehydrates genuine pending approvals with a working approval id', async () => {
    makeManager();
    manager.postMessage(conv, 'ask me first');
    const persistedRequest = requestApproval(fake.state);
    fake.state.transcript = [persistedRequest];
    const row = db.prepare('SELECT * FROM approvals').get() as ApprovalRow;

    const requested = (await manager.snapshot(conv)).find((event) => event.type === 'approval_requested');
    expect(requested?.type === 'approval_requested' && requested.approvalId).toBe(row.id);
  });

  it('rehydrates a manually resolved approval with its final status', async () => {
    makeManager();
    manager.postMessage(conv, 'ask then continue');
    const persistedRequest = requestApproval(fake.state);
    fake.state.transcript = [persistedRequest];
    const row = db.prepare('SELECT * FROM approvals').get() as ApprovalRow;
    expect(manager.resolveApproval(row.id, 'approved', 1)).toEqual({ ok: true, status: 'approved' });

    const snapshot = await manager.snapshot(conv);
    expect(snapshot).toContainEqual(expect.objectContaining({ type: 'approval_requested', approvalId: row.id }));
    expect(snapshot).toContainEqual({
      type: 'approval_resolved',
      requestId: persistedRequest.requestId,
      outcome: 'approved',
      byUserId: 1,
    });
  });

  it('reads the effective mode fresh and lets a chat override an autonomous agent', () => {
    db.prepare("UPDATE assistants SET approval_mode = 'auto' WHERE id = ?").run(conv.assistant_id);
    db.prepare("UPDATE conversations SET approval_mode = 'ask' WHERE id = ?").run(conv.id);
    makeManager();
    manager.postMessage(conv, 'keep asking');
    requestApproval(fake.state);

    const row = db.prepare('SELECT * FROM approvals').get() as ApprovalRow;
    expect(row.status).toBe('pending');
    expect(fake.state.respondCalls).toEqual([]);
    expect(events.some((e) => e.event.type === 'approval_requested')).toBe(true);

    db.prepare("UPDATE conversations SET approval_mode = 'auto' WHERE id = ?").run(conv.id);
    requestApproval(fake.state, 'req-2');
    const fresh = db.prepare("SELECT * FROM approvals WHERE request_id = 'req-2'").get() as ApprovalRow;
    expect(fresh.status).toBe('approved');
    expect((db.prepare("SELECT status FROM approvals WHERE request_id = 'req-1'").get() as ApprovalRow).status).toBe(
      'pending',
    );
    expect(fake.state.respondCalls).toEqual([{ requestId: 'req-2', decision: { behavior: 'allow' } }]);
  });

  it('lets Full Access override stored agent and chat Ask modes', () => {
    db.prepare("UPDATE assistants SET approval_mode = 'ask', full_access = 1 WHERE id = ?").run(conv.assistant_id);
    db.prepare("UPDATE conversations SET approval_mode = 'ask' WHERE id = ?").run(conv.id);
    makeManager();
    manager.postMessage(conv, 'run with full access');
    requestApproval(fake.state);

    const row = db.prepare('SELECT * FROM approvals').get() as ApprovalRow;
    expect(row.status).toBe('approved');
    expect(fake.state.respondCalls).toEqual([{ requestId: 'req-1', decision: { behavior: 'allow' } }]);
    expect(events.some((e) => e.event.type === 'approval_requested')).toBe(false);
  });

  it('falls back to a pending approval when the CLI cannot accept the automatic response', () => {
    db.prepare("UPDATE assistants SET approval_mode = 'auto' WHERE id = ?").run(conv.assistant_id);
    fake.state.respondResult = false;
    makeManager();
    manager.postMessage(conv, 'try autonomous');
    requestApproval(fake.state);

    const row = db.prepare('SELECT * FROM approvals').get() as ApprovalRow;
    expect(row.status).toBe('pending');
    expect(row.resolved_at).toBeNull();
    const requested = events.find((e) => e.event.type === 'approval_requested')?.event;
    expect(requested?.type === 'approval_requested' && requested.approvalId).toBe(row.id);
    expect(manager.statusOf('conv-1')).toBe('needs_you');
  });

  it('approve: responds allow to the live turn, updates the row, emits approval_resolved', () => {
    makeManager();
    manager.postMessage(conv, 'go');
    requestApproval(fake.state);
    const row = db.prepare('SELECT * FROM approvals').get() as ApprovalRow;

    const result = manager.resolveApproval(row.id, 'approved', 1);
    expect(result).toEqual({ ok: true, status: 'approved' });
    expect(fake.state.respondCalls).toEqual([{ requestId: 'req-1', decision: { behavior: 'allow' } }]);

    const fresh = db.prepare('SELECT * FROM approvals WHERE id = ?').get(row.id) as ApprovalRow;
    expect(fresh.status).toBe('approved');
    expect(fresh.resolved_by).toBe(1);
    expect(fresh.resolved_at).toBeTruthy();

    const resolved = events.find((e) => e.event.type === 'approval_resolved')?.event;
    expect(resolved?.type === 'approval_resolved' && resolved.outcome).toBe('approved');
    expect(manager.statusOf('conv-1')).toBe('working'); // turn still in flight
  });

  it('deny: responds deny with a message and records the denial', () => {
    makeManager();
    manager.postMessage(conv, 'go');
    requestApproval(fake.state);
    const row = db.prepare('SELECT * FROM approvals').get() as ApprovalRow;

    const result = manager.resolveApproval(row.id, 'denied', 1);
    expect(result).toEqual({ ok: true, status: 'denied' });
    const call = fake.state.respondCalls[0]!;
    expect(call.decision.behavior).toBe('deny');
    expect(call.decision.behavior === 'deny' && call.decision.message).toContain('declined');
    expect((db.prepare('SELECT status FROM approvals WHERE id = ?').get(row.id) as ApprovalRow).status).toBe('denied');
  });

  it('resolving twice fails with not_pending', () => {
    makeManager();
    manager.postMessage(conv, 'go');
    requestApproval(fake.state);
    const row = db.prepare('SELECT * FROM approvals').get() as ApprovalRow;
    manager.resolveApproval(row.id, 'approved', 1);
    expect(manager.resolveApproval(row.id, 'denied', 1)).toEqual({ ok: false, error: 'not_pending' });
    expect(manager.resolveApproval(9999, 'approved', 1)).toEqual({ ok: false, error: 'not_found' });
  });

  it('expires the approval when the process is already gone', () => {
    makeManager();
    manager.postMessage(conv, 'go');
    requestApproval(fake.state);
    fake.state.respondResult = false; // stdin dead
    const row = db.prepare('SELECT * FROM approvals').get() as ApprovalRow;

    expect(manager.resolveApproval(row.id, 'approved', 1)).toEqual({ ok: false, error: 'expired' });
    expect((db.prepare('SELECT status FROM approvals WHERE id = ?').get(row.id) as ApprovalRow).status).toBe('expired');
    const resolved = events.find((e) => e.event.type === 'approval_resolved')?.event;
    expect(resolved?.type === 'approval_resolved' && resolved.outcome).toBe('expired');
  });

  it('auto-denies after the approval timeout with an expired marker', async () => {
    makeManager(40);
    manager.postMessage(conv, 'go');
    requestApproval(fake.state);
    await new Promise((r) => setTimeout(r, 120));

    const row = db.prepare('SELECT * FROM approvals').get() as ApprovalRow;
    expect(row.status).toBe('expired');
    const call = fake.state.respondCalls[0]!;
    expect(call.decision.behavior).toBe('deny');
    expect(call.decision.behavior === 'deny' && call.decision.message).toContain('automatically declined');
    const resolved = events.find((e) => e.event.type === 'approval_resolved')?.event;
    expect(resolved?.type === 'approval_resolved' && resolved.outcome).toBe('expired');
    expect(manager.statusOf('conv-1')).toBe('working'); // turn continues after auto-deny
  });

  it('expires pending approvals when the turn ends (process death)', async () => {
    makeManager();
    manager.postMessage(conv, 'go');
    requestApproval(fake.state);
    fake.state.finishTurn!();
    await flush();

    expect((db.prepare('SELECT status FROM approvals').get() as ApprovalRow).status).toBe('expired');
    expect(manager.statusOf('conv-1')).toBe('idle');
  });

  it('expires stale pending approvals at boot', () => {
    db.prepare(
      "INSERT INTO approvals (conversation_id, request_id, tool_name, request_json) VALUES ('conv-1', 'req-old', 'Write', '{}')",
    ).run();
    makeManager();
    expect((db.prepare('SELECT status FROM approvals').get() as ApprovalRow).status).toBe('expired');
    expect(manager.statusOf('conv-1')).toBe('idle');
  });
});
