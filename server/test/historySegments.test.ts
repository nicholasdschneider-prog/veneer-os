import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { ConversationRow } from '../src/db/db.js';
import type { ProviderAdapter, TurnSpec } from '../src/providers/types.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import { indexConversation } from '../src/botWorkflows/search.js';
import type { AppContext } from '../src/context.js';

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const turn = (n: number, at: string): ConversationEvent[] => [
  { type: 'turn_started', turnId: `t${n}`, role: 'user', text: `question ${n}`, at, via: 'web' },
  { type: 'tool_started', turnId: `t${n}`, toolId: `call-${n}`, toolName: 'Bash', displayName: 'Run', inputPreview: 'ls' },
  { type: 'text_final', turnId: `t${n}`, markdown: `answer ${n}`, at },
];

function setup(legacy?: ConversationEvent[], withClaude = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-segments-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, migrations);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  db.prepare(`INSERT INTO conversations (id, assistant_id, user_id, title, provider, model, native_session_id, last_input_tokens, last_active_at)
    VALUES ('bot', 1, 1, 'Tess', 'codex', 'gpt', 'session-0', 210000, '2026-11-05 12:00:00')`).run();
  db.prepare("INSERT INTO settings VALUES ('turn_ran:bot', 'true')").run();
  db.prepare("INSERT INTO bot_registrations (conversation_id, name, active, registered_by) VALUES ('bot', 'Tess', 1, 1)").run();
  db.prepare("INSERT INTO token_governor_bots (conversation_id, rotation) VALUES ('bot', 1)").run();
  if (legacy) {
    db.prepare(`INSERT INTO conversation_provider_context (conversation_id, history_json, files_json, handoff, pending)
      VALUES ('bot', ?, '[]', 'old handoff', 0)`).run(JSON.stringify(legacy));
  }
  const transcripts = new Map<string, ConversationEvent[]>();
  const now = Date.now();
  transcripts.set('session-0', [...turn(1, new Date(now - 60_000).toISOString()), ...turn(2, new Date(now - 50_000).toISOString())]);
  const runs: Array<{ spec: TurnSpec; emit: (event: ConversationEvent) => void; finish: () => void }> = [];
  let minted = 0;
  const codex: ProviderAdapter = {
    id: 'codex',
    mintSessionId: () => `session-${++minted}`,
    listModels: async () => [{ id: 'gpt', label: 'GPT' }],
    readTranscript: async ({ nativeSessionId }) => transcripts.get(nativeSessionId) ?? [],
    runTurn(spec, emit) {
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      runs.push({ spec, emit, finish });
      return { done, kill: () => finish(), respondToApproval: () => false };
    },
  };
  const claude: ProviderAdapter = {
    id: 'claude', mintSessionId: () => 'claude-1', listModels: async () => [{ id: 'opus', label: 'Opus' }],
    readTranscript: async ({ nativeSessionId }) => transcripts.get(nativeSessionId) ?? [],
    runTurn: () => ({ done: Promise.resolve(), kill() {}, respondToApproval: () => false }),
  };
  const manager = createConversationManager({
    db, adapters: withClaude ? { codex, claude } : { codex },
    resolveWorkspace: () => ({ workspaceDir: cwd, assistantSlug: 'assistant', elevated: false }),
    log: { warn() {}, error() {} },
  });
  const row = () => db.prepare("SELECT * FROM conversations WHERE id = 'bot'").get() as ConversationRow;
  const segments = () => db.prepare("SELECT seq, events_json FROM conversation_history_segments WHERE conversation_id = 'bot' ORDER BY seq")
    .all() as { seq: number; events_json: string }[];
  /** Make the chat due for a rotation: three completed turns since the last one, context over the threshold. */
  const makeDue = () => {
    for (let i = 0; i < 3; i += 1) {
      const at = new Date(Date.now() + i).toISOString();
      db.prepare(`INSERT INTO turn_token_usage (conversation_id, bot_id, turn_id, origin, provider, outcome, input_tokens, output_tokens, started_at, finished_at)
        VALUES ('bot', 'bot', ?, 'human', 'codex', 'completed', 1, 1, ?, ?)`).run(`due-${Math.random()}`, at, at);
    }
    db.prepare("UPDATE conversations SET last_input_tokens = 210000 WHERE id = 'bot'").run();
    // A real provider marks its session started; this fake one never reports a session id.
    db.prepare("INSERT OR REPLACE INTO settings VALUES ('turn_ran:bot', 'true')").run();
  };
  /** Send a message and let its turn finish; returns the spec the provider received. */
  const turnNow = async (text: string) => {
    const before = runs.length;
    manager.postMessage(row(), text);
    for (let i = 0; i < 80 && runs.length === before; i += 1) await flush();
    const run = runs[before]!;
    run.emit({ type: 'turn_done', turnId: run.spec.turnId, outcome: 'completed' });
    run.finish();
    await flush();
    return run.spec;
  };
  cleanups.push(async () => { manager.shutdown(); await flush(); db.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { db, manager, row, transcripts, segments, makeDue, turnNow };
}

const visible = (events: ConversationEvent[]) => events
  .filter((e) => e.type === 'turn_started' || e.type === 'text_final' || e.type === 'tool_started')
  .map((e) => `${e.type}:${'turnId' in e ? e.turnId.replace(/^[0-9a-f-]{36}:/, '') : ''}:${e.type === 'turn_started' ? e.text : e.type === 'text_final' ? e.markdown : ''}`);

describe('append-only frozen history', () => {
  it('appends each ended session as one piece, keeps earlier pieces byte-identical, and shows the same chat', async () => {
    const { db, manager, row, transcripts, segments, makeDue, turnNow } = setup();
    db.prepare(`INSERT INTO turn_token_usage (conversation_id, bot_id, turn_id, origin, provider, outcome, input_tokens, output_tokens, started_at, finished_at)
      VALUES ('bot', 'bot', 'earlier', 'routine', 'codex', 'completed', 1, 1, '2026-11-05T10:00:00.000Z', '2026-11-05T10:01:00.000Z')`).run();
    const before = visible(await manager.snapshot(row()));

    const first = await turnNow('next');
    expect(first.nativeSessionId).toBe('session-1');
    expect(segments()).toHaveLength(1);
    const piece1 = segments()[0]!.events_json;
    // The ended session only, namespaced once, and the rotation notice.
    expect(visible(JSON.parse(piece1))).toEqual(before);
    expect((JSON.parse(piece1) as ConversationEvent[]).at(-1)).toMatchObject({ type: 'notice' });
    for (const e of JSON.parse(piece1) as ConversationEvent[]) if ('turnId' in e) expect(e.turnId).toMatch(/^[0-9a-f-]{36}:t\d$/);
    expect(db.prepare("SELECT history_json FROM conversation_provider_context WHERE conversation_id='bot'").get()).toEqual({ history_json: '[]' });

    transcripts.set('session-1', [...turn(3, new Date().toISOString())]);
    makeDue();
    const second = await turnNow('again');
    expect(second.nativeSessionId).toBe('session-2');
    const pieces = segments();
    expect(pieces).toHaveLength(2);
    expect(pieces[0]!.events_json).toBe(piece1);
    // The new piece holds only session-1, so its size tracks new work, not the chat.
    expect(visible(JSON.parse(pieces[1]!.events_json))).toEqual(['turn_started:t3:question 3', 'tool_started:t3:', 'text_final:t3:answer 3']);
    expect(pieces[1]!.events_json.length).toBeLessThan(piece1.length);

    // The visible chat is every session in order, with each notice in place.
    const all = await manager.snapshot(row());
    expect(visible(all)).toEqual([...before, 'turn_started:t3:question 3', 'tool_started:t3:', 'text_final:t3:answer 3']);
    expect(all.filter((e) => e.type === 'notice' && e.message.includes('fresh working session'))).toHaveLength(2);
  });

  it('keeps a legacy history row as the oldest piece and never rewrites it', async () => {
    const legacy = [...turn(0, '2026-10-01T00:00:00.000Z')].map((e) => ('turnId' in e ? { ...e, turnId: `11111111-1111-1111-1111-111111111111:${e.turnId}` } : e)) as ConversationEvent[];
    const { db, manager, row, segments, turnNow } = setup(legacy);
    db.prepare(`INSERT INTO turn_token_usage (conversation_id, bot_id, turn_id, origin, provider, outcome, input_tokens, output_tokens, started_at, finished_at)
      VALUES ('bot', 'bot', 'earlier', 'routine', 'codex', 'completed', 1, 1, '2026-11-05T10:00:00.000Z', '2026-11-05T10:01:00.000Z')`).run();
    const legacyJson = JSON.stringify(legacy);
    await turnNow('rotate');
    expect(db.prepare("SELECT history_json, handoff FROM conversation_provider_context WHERE conversation_id='bot'").get())
      .toMatchObject({ history_json: legacyJson });
    expect(segments()).toHaveLength(1);
    expect(visible(await manager.snapshot(row())).slice(0, 4)).toEqual([
      'turn_started:t0:question 0', 'tool_started:t0:', 'text_final:t0:answer 0', 'turn_started:t1:question 1',
    ]);
  });

  it('switches providers by appending the ended session, and round-trips without losing history', async () => {
    const { manager, row, segments } = setup(undefined, true);
    const before = visible(await manager.snapshot(row()));
    expect(await manager.switchProvider(row(), { provider: 'claude', model: 'opus', effort: null })).toEqual({ ok: true });
    expect(segments()).toHaveLength(1);
    expect(visible(JSON.parse(segments()[0]!.events_json))).toEqual(before);
    expect(await manager.switchProvider(row(), { provider: 'codex', model: 'gpt', effort: null })).toEqual({ ok: true });
    expect(segments()).toHaveLength(2);
    // The claude session ran no turns, so its piece holds only the switch notice.
    expect(visible(JSON.parse(segments()[1]!.events_json))).toEqual([]);
    expect(visible(await manager.snapshot(row()))).toEqual(before);
  });

  it('indexes search once across rotations: frozen pieces add no duplicate documents', async () => {
    const { db, manager, row, transcripts, makeDue, turnNow } = setup();
    db.prepare(`INSERT INTO turn_token_usage (conversation_id, bot_id, turn_id, origin, provider, outcome, input_tokens, output_tokens, started_at, finished_at)
      VALUES ('bot', 'bot', 'earlier', 'routine', 'codex', 'completed', 1, 1, '2026-11-05T10:00:00.000Z', '2026-11-05T10:01:00.000Z')`).run();
    const ctx = { db, manager: { searchableEvents: (id: string, since: string | null) => manager.searchableEvents(row(), since) } } as unknown as AppContext;
    const index = async () => {
      db.prepare("UPDATE conversations SET last_active_at = datetime('now') WHERE id = 'bot'").run();
      await indexConversation(ctx, row());
    };
    await index();
    const docs = () => (db.prepare("SELECT COUNT(*) AS n FROM bot_search_documents WHERE conversation_id='bot'").get() as { n: number }).n;
    expect(docs()).toBe(4);
    await turnNow('rotate');
    await index();
    transcripts.set('session-1', turn(3, new Date().toISOString()));
    makeDue();
    await turnNow('rotate again');
    await index();
    await index();
    // Two original turns, the third, and the two prompts that triggered rotations.
    const texts = (db.prepare("SELECT body FROM bot_search_documents WHERE conversation_id='bot' ORDER BY body").all() as { body: string }[]).map((r) => r.body);
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts).toEqual(expect.arrayContaining(['question 1', 'answer 1', 'question 2', 'answer 2', 'question 3', 'answer 3']));
  });
});
