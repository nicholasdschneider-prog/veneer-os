import Database from 'better-sqlite3';
import express from 'express';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createBotService, proposalSchema, type Actor } from '../src/bots/service.js';
import {
  DECISION_HELPER_CAP,
  decisionHelperPrompt,
  recentExchangeExcerpt,
} from '../src/bots/decisionHelper.js';
import { createConversationWakeupScheduler } from '../src/scheduled/wakeups.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import { createApiRouter } from '../src/routes/api.js';
import type { AppContext } from '../src/context.js';
import type { ConversationRow, UserRow } from '../src/db/db.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import type { ProviderAdapter, TurnSpec } from '../src/providers/types.js';

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

describe('decision card helpers', () => {
  let db: Database.Database;
  let s: ReturnType<typeof createBotService>;
  let human: Actor;
  let manager: ReturnType<typeof createConversationManager>;
  let scheduler: ReturnType<typeof createConversationWakeupScheduler>;
  const runs: { conversationId: string; spec: TurnSpec; finish: (answer?: string) => void }[] = [];

  function build(decisionHelpers = true) {
    const adapter: ProviderAdapter = {
      id: 'claude',
      mintSessionId: () => '',
      readTranscript: async () => [],
      runTurn(spec, onEvent) {
        let finish!: (answer?: string) => void;
        const done = new Promise<void>((resolve) => {
          finish = (answer) => {
            if (answer) onEvent({ type: 'text_final', turnId: spec.turnId, markdown: answer, at: new Date().toISOString() } as ConversationEvent);
            onEvent({ type: 'turn_done', turnId: spec.turnId, outcome: 'completed' } as ConversationEvent);
            resolve();
          };
        });
        runs.push({ conversationId: spec.conversationId, spec, finish });
        return { done, kill: () => finish(), respondToApproval: () => true };
      },
    };
    manager = createConversationManager({
      db,
      decisionHelpers,
      steerAckWaitMs: 5,
      adapters: { claude: adapter },
      resolveWorkspace: () => ({ workspaceDir: '/tmp', assistantSlug: 'assistant', elevated: false, fullAccess: true }),
      log: { warn: vi.fn(), error: vi.fn() },
    });
    scheduler = createConversationWakeupScheduler({ db, manager, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.test','Nick','owner')").run();
    for (const id of ['sage', 'atlas', 'robin', 'wren', 'finch'])
      db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'claude',?,'team')").run(id, `${id} chat`, `native-${id}`);
    s = createBotService(db);
    human = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow };
    for (const id of ['sage', 'atlas', 'robin', 'wren', 'finch']) s.register(human, id, id[0]!.toUpperCase() + id.slice(1), true);
    runs.length = 0;
    build();
  });
  afterEach(async () => {
    scheduler.stop();
    manager.shutdown();
    await flush();
    db.close();
  });

  const conv = (id: string) => db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow;
  const raise = (owner = 'sage', key = 'case') =>
    s.raise({ ...human, conversationId: owner }, {
      source_key: key,
      proposal_key: 'refund',
      proposal: proposalSchema.parse({
        question: 'Refund order 946 for the damaged step?',
        recommendation: 'Refund $42.10 to the original card.',
        consequence: 'The customer gets $42.10 back.',
        assignee_id: 1,
        blocked_action: 'Refund order 946',
      }),
    });
  const busy = async (owner = 'sage') => { manager.postMessage(conv(owner), 'Long stalled-order sweep'); await flush(); };
  const ask = async (decisionId: string, text: string, key = 'q1') => {
    s.reply(human, decisionId, key, text);
    scheduler.tick();
    await flush();
  };
  const helperRuns = () => runs.filter((r) => db.prepare('SELECT 1 FROM decision_helpers WHERE conversation_id=?').get(r.conversationId));

  it('answers a card question in seconds while the bot is busy, read-only, and hands the answer to the bot', async () => {
    await busy();
    const d = raise();
    await ask(d.id, 'What is this even about?');

    const [helper] = helperRuns();
    expect(helper).toBeDefined();
    expect(helper!.spec.readOnly).toBe(true);
    expect(helper!.spec.dangerous).toBe(false);
    expect(helper!.spec.developerInstructions).toContain('read-only helper copy of Sage');
    expect(helper!.spec.prompt).toContain('Refund order 946');
    expect(helper!.spec.prompt.trim().endsWith('What is this even about?')).toBe(true);
    const helperRow = conv(helper!.conversationId);
    expect(helperRow.side_chat_of).toBe('sage');
    expect(s.view(human, s.read(human, d.id)).reply_status).toBe('helper_answering');

    helper!.finish('Sage wants to refund $42.10 on order 946 because the step arrived damaged.');
    await flush();
    const thread = s.thread(human, d.id).messages as { text: string; helper: number; actor_conversation_id: string }[];
    expect(thread.at(-1)).toMatchObject({ helper: 1, actor_conversation_id: helper!.conversationId, text: expect.stringContaining('$42.10') });
    expect(s.view(human, s.read(human, d.id)).reply_status).toBe('helper_answered');
    // The helper never answers or changes the decision.
    expect(s.read(human, d.id).state).toBe('needs_input');

    // The human's message still reaches the bot, carrying the helper's answer.
    runs[0]!.finish();
    await flush();
    const owner = runs.filter((r) => r.conversationId === 'sage').at(-1)!;
    expect(owner.spec.prompt).toContain('What is this even about?');
    expect(owner.spec.prompt).toContain('a read-only helper copy of you already answered');
    expect(owner.spec.prompt).toContain('$42.10 on order 946');
    expect(owner.spec.readOnly).toBeUndefined();
  });

  it('does not start a helper when the bot is idle', async () => {
    const d = raise();
    await ask(d.id, 'Why this refund?');
    expect(helperRuns()).toHaveLength(0);
    expect(runs.map((r) => r.conversationId)).toEqual(['sage']);
  });

  it('is off unless the runtime enables it', async () => {
    scheduler.stop(); manager.shutdown(); runs.length = 0;
    build(false);
    await busy();
    const d = raise();
    await ask(d.id, 'Why this refund?');
    expect(helperRuns()).toHaveLength(0);
  });

  it('keeps one helper per card and continues it for a follow-up', async () => {
    await busy();
    const d = raise();
    await ask(d.id, 'First question?', 'q1');
    await ask(d.id, 'And a follow-up?', 'q2');
    expect(db.prepare('SELECT count(*) AS n FROM decision_helpers').get()).toEqual({ n: 1 });
    expect(helperRuns()).toHaveLength(1);
    helperRuns()[0]!.finish('First answer.');
    await flush();
    const runsNow = helperRuns();
    expect(runsNow).toHaveLength(2);
    expect(runsNow[1]!.conversationId).toBe(runsNow[0]!.conversationId);
    expect(runsNow[1]!.spec.prompt).toContain('And a follow-up?');
    // Same native session: the helper remembers its first answer itself.
    expect(runsNow[1]!.spec.nativeSessionId).toBe(runsNow[0]!.spec.nativeSessionId);
    expect(runsNow[1]!.spec.firstTurn).toBe(false);
  });

  it(`falls back to the plain queue above ${DECISION_HELPER_CAP} helpers at once`, async () => {
    const owners = ['sage', 'atlas', 'robin', 'wren'];
    for (const owner of owners) await busy(owner);
    for (const [i, owner] of owners.entries()) await ask(raise(owner, `case-${i}`).id, `Question ${i}?`, `q-${i}`);
    expect(helperRuns()).toHaveLength(DECISION_HELPER_CAP);
    const last = s.list(human).find((d: { conversation_id: string }) => d.conversation_id === 'wren')!;
    expect(s.view(human, s.read(human, last.id)).reply_status).toBe('queued');
  });

  it('records a direction only through the bot, never the helper', async () => {
    await busy();
    const d = raise();
    await ask(d.id, 'Approve it.');
    helperRuns()[0]!.finish('Sage will act on this after its current step.');
    await flush();
    expect(s.read(human, d.id).state).toBe('needs_input');
    expect(s.read(human, d.id).answer_json).toBeNull();
  });

  it('refuses every write from a helper token and still serves its reads', async () => {
    await busy();
    const d = raise();
    await ask(d.id, 'What is this?');
    const helperId = helperRuns()[0]!.conversationId;
    const ctx = {
      db,
      manager: { bus: new EventEmitter(), statusOf: async () => 'idle', snapshot: async () => [] },
      resolveIdentity: async () => ({ email: 'owner@example.test', agentConversationId: helperId }),
    } as unknown as AppContext;
    const app = express();
    app.use('/api', createApiRouter(ctx));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const write = await fetch(`${base}/api/bots/decisions/${d.id}/thread`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Approved', request_key: 'x' }),
      });
      expect(write.status).toBe(403);
      expect(await write.json()).toMatchObject({ error: expect.stringContaining('read-only') });
      const read = await fetch(`${base}/api/bots/decisions/${d.id}`);
      expect(read.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('builds the helper prompt from the card, its discussion and the bot chat, question last', () => {
    const events: ConversationEvent[] = [
      { type: 'turn_started', turnId: 't1', role: 'user', text: 'Sweep stalled orders', at: 'a', via: 'web' } as ConversationEvent,
      { type: 'text_final', turnId: 't1', markdown: 'Checking order 946 now.', at: 'b' } as ConversationEvent,
      { type: 'tool_started', turnId: 't1', toolId: 'x', name: 'Bash', input: {} } as unknown as ConversationEvent,
    ];
    expect(recentExchangeExcerpt(events, 'Sage')).toBe('User: Sweep stalled orders\nSage: Checking order 946 now.');
    const prompt = decisionHelperPrompt({
      botName: 'Sage', ownerTitle: 'Stalled orders', proposal: { question: 'Refund?' },
      thread: [{ who: 'Nick', text: 'Earlier note' }], ownerEvents: events, question: 'What is this?',
    });
    expect(prompt).toContain('"Stalled orders" is busy');
    expect(prompt).toContain('Nick: Earlier note');
    expect(prompt).toContain('Sage: Checking order 946 now.');
    expect(prompt.endsWith('---\nWhat is this?')).toBe(true);
  });
});
