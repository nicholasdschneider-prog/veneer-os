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

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function setup(contextTokens: number) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-rotation-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, migrations);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  db.prepare(`INSERT INTO conversations (id, assistant_id, user_id, title, provider, model, native_session_id, last_input_tokens)
    VALUES ('worker', 1, 1, 'AutoShip Worker', 'codex', 'gpt-astra', 'codex-original', ?)`).run(contextTokens);
  db.prepare("INSERT INTO settings VALUES ('turn_ran:worker', 'true')").run();
  db.prepare("INSERT INTO bot_registrations (conversation_id, name, active, registered_by) VALUES ('worker', 'AutoShip Worker', 1, 1)").run();
  db.prepare("INSERT INTO token_governor_bots (conversation_id, rotation, precheck, budget) VALUES ('worker', 1, 1, 1)").run();
  db.prepare(`INSERT INTO turn_token_usage (conversation_id, bot_id, turn_id, origin, provider, outcome, input_tokens, output_tokens, started_at, finished_at)
    VALUES ('worker', 'worker', 'earlier', 'routine', 'codex', 'completed', 1000, 1, '2026-11-03T10:00:00.000Z', '2026-11-03T10:01:00.000Z')`).run();
  const runs: Array<{ spec: TurnSpec; emit: (event: ConversationEvent) => void; finish: () => void }> = [];
  const transcripts = new Map<string, ConversationEvent[]>([['codex-original', [
    { type: 'turn_started', turnId: 't0', role: 'user', text: 'Nick: never ship order 100122410 before Friday', at: new Date().toISOString(), via: 'web' },
    { type: 'text_final', turnId: 't0', markdown: 'Understood, 100122410 is on hold until Friday.', at: new Date().toISOString() },
  ]]]);
  const codex: ProviderAdapter = {
    id: 'codex',
    mintSessionId: () => `codex-fresh-${runs.length}`,
    readTranscript: async ({ nativeSessionId }) => transcripts.get(nativeSessionId) ?? [],
    runTurn(spec, emit) {
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      runs.push({ spec, emit, finish });
      return { done, kill: () => finish(), respondToApproval: () => false };
    },
  };
  const manager = createConversationManager({
    db, adapters: { codex },
    resolveWorkspace: () => ({ workspaceDir: cwd, assistantSlug: 'assistant', elevated: false }),
    log: { warn() {}, error() {} },
  });
  const row = () => db.prepare("SELECT * FROM conversations WHERE id = 'worker'").get() as ConversationRow;
  cleanups.push(async () => { manager.shutdown(); await flush(); db.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { db, manager, row, runs };
}

async function waitForRun(runs: unknown[]) {
  for (let i = 0; i < 50 && !runs.length; i += 1) await flush();
}

describe('token governor context rotation', () => {
  it('starts the next turn in a fresh session with a structured handoff and keeps one continuous chat', async () => {
    const { db, manager, row, runs } = setup(212_000);
    manager.postMessage(row(), 'Check the replies');
    await waitForRun(runs);
    const run = runs[0]!;
    expect(run.spec.firstTurn).toBe(true);
    expect(run.spec.nativeSessionId).toBe('codex-fresh-0');
    expect(run.spec.prompt).toContain('Context rotation for the SAME chat (worker)');
    expect(run.spec.prompt).toContain('never ship order 100122410 before Friday');
    expect(row().last_input_tokens).toBeNull();
    const history = await manager.snapshot(row());
    expect(history.some((e) => e.type === 'text_final' && e.markdown.includes('on hold until Friday'))).toBe(true);
    expect(history.some((e) => e.type === 'notice' && e.message.includes('Started a fresh working session'))).toBe(true);
    expect(db.prepare("SELECT kind FROM token_governor_events").all()).toEqual([{ kind: 'rotation' }]);
    run.emit({
      type: 'turn_done', turnId: run.spec.turnId, outcome: 'completed',
      usage: { inputTokens: 40_000, outputTokens: 50, totalInputTokens: 120_000, totalOutputTokens: 50, totalTokens: 120_050, cachedInputTokens: 80_000, modelCalls: 3 },
    });
    run.finish(); await flush();
    expect(db.prepare("SELECT origin, input_tokens, cached_input_tokens, model_calls, context_tokens FROM turn_token_usage WHERE turn_id <> 'earlier'").get())
      .toEqual({ origin: 'human', input_tokens: 120_000, cached_input_tokens: 80_000, model_calls: 3, context_tokens: 40_000 });
  });

  it('keeps the session when the chat is under the threshold or the switch is off', async () => {
    const { db, manager, row, runs } = setup(90_000);
    manager.postMessage(row(), 'Small turn');
    await waitForRun(runs);
    expect(runs[0]!.spec).toMatchObject({ firstTurn: false, nativeSessionId: 'codex-original' });
    runs[0]!.emit({ type: 'turn_done', turnId: runs[0]!.spec.turnId, outcome: 'completed' });
    runs[0]!.finish(); await flush();
    db.prepare("UPDATE conversations SET last_input_tokens = 300000 WHERE id = 'worker'").run();
    db.prepare('UPDATE token_governor_bots SET rotation = 0').run();
    manager.postMessage(row(), 'Big turn, switch off');
    for (let i = 0; i < 50 && runs.length < 2; i += 1) await flush();
    expect(runs[1]!.spec).toMatchObject({ firstTurn: false, nativeSessionId: 'codex-original' });
    runs[1]!.finish(); await flush();
  });
});
