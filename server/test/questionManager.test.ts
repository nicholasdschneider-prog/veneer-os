import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { ConversationRow, QuestionRow } from '../src/db/db.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import type { ConversationEvent, QuestionAnswers, QuestionPrompt } from '../src/runtime/events.js';
import type { ProviderAdapter, TurnSpec } from '../src/providers/types.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('owner@example.com', 'Sam', 'owner')").run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES ('conv-1', 1, 1, 'Test', 'codex', 'sid-1', 'web')`,
  ).run();
  return db;
}

function fakeAdapter() {
  const state = {
    onEvent: null as ((event: ConversationEvent) => void) | null,
    finish: null as (() => void) | null,
    turnId: '',
    transcript: [] as ConversationEvent[],
    questionResponses: [] as { requestId: string; answers: QuestionAnswers }[],
  };
  const adapter: ProviderAdapter = {
    id: 'codex',
    mintSessionId: () => 'sid-1',
    runTurn(spec: TurnSpec, onEvent) {
      state.onEvent = onEvent;
      state.turnId = spec.turnId;
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      state.finish = () => {
        onEvent({ type: 'turn_done', turnId: spec.turnId, outcome: 'completed' });
        resolveDone();
      };
      return {
        done,
        kill: resolveDone,
        respondToApproval: () => true,
        respondToQuestion: (requestId, answers) => {
          state.questionResponses.push({ requestId, answers });
          return true;
        },
      };
    },
    readTranscript: async () => state.transcript,
  };
  return { adapter, state };
}

describe('durable structured questions', () => {
  let db: Database.Database;
  let conv: ConversationRow;
  let fake: ReturnType<typeof fakeAdapter>;

  const manager = () => createConversationManager({
    db,
    adapters: { codex: fake.adapter },
    resolveWorkspace: () => ({ workspaceDir: '/tmp', assistantSlug: 'assistant', elevated: false }),
    approvalTimeoutMs: 60_000,
    log: { warn() {}, error() {} },
  });

  beforeEach(() => {
    db = openTestDb();
    conv = db.prepare("SELECT * FROM conversations WHERE id = 'conv-1'").get() as ConversationRow;
    fake = fakeAdapter();
  });

  it('persists an MCP question and replaces its raw tool row in history', async () => {
    const runtime = manager();
    runtime.postMessage(conv, 'ask me');
    const requestId = runtime.askQuestion(
      conv.id,
      'Which release?',
      [{ label: 'Stable', value: 'stable', description: 'Use the proven channel.' }],
      false,
      true,
    );
    const row = db.prepare('SELECT * FROM questions').get() as QuestionRow;
    expect(row).toMatchObject({ request_id: requestId, response_mode: 'poll', status: 'pending' });
    expect(runtime.statusOf(conv.id)).toBe('needs_you');
    expect(runtime.resolveQuestion(requestId, { q1: ['stable'] })).toEqual({ ok: true });

    fake.state.transcript = [
      {
        type: 'tool_started',
        turnId: fake.state.turnId,
        toolId: 'ask-tool',
        toolName: 'mcp__agents__ask_user',
        displayName: 'Asking you a question',
        inputPreview: '{"question":"Which release?"}',
      },
      { type: 'tool_finished', turnId: fake.state.turnId, toolId: 'ask-tool', ok: true, resultPreview: 'stable' },
    ];
    fake.state.finish!();
    await flush();

    const snapshot = await runtime.snapshot(conv);
    expect(snapshot.some((event) => event.type === 'tool_started')).toBe(false);
    expect(snapshot).toContainEqual(expect.objectContaining({
      type: 'question_asked',
      requestId,
      questions: [expect.objectContaining({ allowOther: true })],
    }));
    expect(snapshot).toContainEqual(expect.objectContaining({
      type: 'question_answered',
      requestId,
      answers: { q1: ['stable'] },
    }));
  });

  it('round-trips a secret prompt and records only the saved marker', async () => {
    const runtime = manager();
    const events: ConversationEvent[] = [];
    runtime.bus.on('event', (_id: string, event: ConversationEvent) => events.push(event));
    runtime.postMessage(conv, 'I need the Stripe key');
    const value = 'sk_live_never_persist_me';
    const requestId = runtime.askQuestion(
      conv.id,
      'Stripe live key, from the Stripe dashboard under Developers → API keys.',
      [{ label: 'ignored', value: 'ignored' }],
      true,
      false,
      { name: 'STRIPE_API_KEY', project: 'veneer', config: 'prd', exists: false },
    );

    const prompts = JSON.parse((db.prepare('SELECT * FROM questions').get() as QuestionRow).questions_json);
    expect(prompts).toEqual([{
      id: 'q1',
      question: 'Stripe live key, from the Stripe dashboard under Developers → API keys.',
      options: [],
      multi: false,
      allowOther: true,
      kind: 'secret',
      secret: { name: 'STRIPE_API_KEY', project: 'veneer', config: 'prd', exists: false },
    }]);
    expect(runtime.getQuestion(requestId)).toMatchObject({
      status: 'pending',
      kind: 'secret',
      secret: { name: 'STRIPE_API_KEY', project: 'veneer', config: 'prd' },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'question_asked',
      requestId,
      questions: [expect.objectContaining({ kind: 'secret', secret: expect.objectContaining({ name: 'STRIPE_API_KEY' }) })],
    }));

    // The route writes the value to Doppler itself; only this marker is stored.
    expect(runtime.resolveQuestion(requestId, { q1: ['saved'] })).toEqual({ ok: true });
    const row = db.prepare('SELECT * FROM questions').get() as QuestionRow;
    expect(row.status).toBe('answered');
    expect(JSON.parse(row.answers_json)).toEqual({ q1: ['saved'] });

    const snapshot = await runtime.snapshot(conv);
    expect(snapshot).toContainEqual(expect.objectContaining({
      type: 'question_asked',
      requestId,
      questions: [expect.objectContaining({
        kind: 'secret',
        secret: { name: 'STRIPE_API_KEY', project: 'veneer', config: 'prd', exists: false },
      })],
    }));
    for (const text of [JSON.stringify(row), JSON.stringify(snapshot), JSON.stringify(events)]) {
      expect(text).not.toContain(value);
    }
  });

  it('delivers native multi-question answers through the live provider handle', () => {
    const runtime = manager();
    runtime.postMessage(conv, 'ask natively');
    const questions: QuestionPrompt[] = [
      {
        id: 'q1',
        header: 'Channel',
        question: 'Which release channel?',
        options: [{ label: 'Stable', value: 'Stable' }],
        multi: false,
        allowOther: false,
      },
      {
        id: 'q2',
        header: 'Note',
        question: 'Anything else?',
        options: [],
        multi: false,
        allowOther: true,
      },
    ];
    fake.state.onEvent!({
      type: 'question_asked',
      requestId: 'veneer-request',
      turnId: fake.state.turnId,
      questions,
      responseMode: 'provider',
    });

    const answers = { q1: ['Stable'], q2: ['Deploy after lunch'] };
    expect(runtime.resolveQuestion('veneer-request', answers)).toEqual({ ok: true });
    expect(fake.state.questionResponses).toEqual([{ requestId: 'veneer-request', answers }]);
    expect((db.prepare('SELECT * FROM questions').get() as QuestionRow).status).toBe('answered');
  });

  it('rejects missing or unrecognized answers without releasing the provider', () => {
    const runtime = manager();
    runtime.postMessage(conv, 'ask natively');
    fake.state.onEvent!({
      type: 'question_asked',
      requestId: 'veneer-request',
      turnId: fake.state.turnId,
      questions: [{
        id: 'q1',
        question: 'Choose one',
        options: [{ label: 'A', value: 'a' }],
        multi: false,
        allowOther: false,
      }],
      responseMode: 'provider',
    });
    expect(runtime.resolveQuestion('veneer-request', { q1: ['not-an-option'] })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(fake.state.questionResponses).toEqual([]);
    expect((db.prepare('SELECT * FROM questions').get() as QuestionRow).status).toBe('pending');
  });

  it('expires stale rows at boot but preserves their read-only card', async () => {
    const prompts: QuestionPrompt[] = [{
      id: 'q1',
      question: 'Still there?',
      options: [{ label: 'Yes', value: 'yes' }],
      multi: false,
      allowOther: false,
    }];
    db.prepare(
      `INSERT INTO questions
         (request_id, conversation_id, turn_id, response_mode, questions_json)
       VALUES ('stale-question', 'conv-1', 'old-turn', 'provider', ?)`,
    ).run(JSON.stringify(prompts));

    const runtime = manager();
    const row = db.prepare('SELECT * FROM questions').get() as QuestionRow;
    expect(row.status).toBe('expired');
    expect(runtime.statusOf(conv.id)).toBe('idle');
    expect(await runtime.snapshot(conv)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'question_asked', requestId: 'stale-question' }),
      expect.objectContaining({ type: 'question_answered', requestId: 'stale-question', expired: true }),
    ]));
  });
});
