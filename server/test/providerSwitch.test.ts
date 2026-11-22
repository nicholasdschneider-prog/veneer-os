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
import { writeProviderHandoff } from '../src/runtime/providerSwitch.js';
import { insertOwnerLane } from '../src/coordination/store.js';

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function setup() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-provider-switch-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, migrations);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  db.prepare(`INSERT INTO conversations (id, assistant_id, user_id, title, title_auto, provider, model, native_session_id)
    VALUES ('piper', 1, 1, 'Piper', 0, 'claude', 'fable', 'claude-original')`).run();
  db.prepare("INSERT INTO settings VALUES ('turn_ran:piper', 'true')").run();
  const runs: Array<{ spec: TurnSpec; emit: (event: ConversationEvent) => void; finish: () => void }> = [];
  const transcripts = new Map<string, ConversationEvent[]>([['claude-original', [
    { type: 'turn_started', turnId: 't0', role: 'user', text: 'You are Piper. Load piper-catalog-fixer. Fix SKU 123. Attachment: /workspace/photo.png', at: '2026-09-17T20:00:00Z', via: 'web' },
    { type: 'text_final', turnId: 't0', markdown: 'Product title updated. Inventory still needs checking.', at: '2026-09-17T20:00:01Z' },
  ]]]);
  const adapter = (id: 'claude' | 'codex'): ProviderAdapter => ({
    id,
    mintSessionId: () => `${id}-new-${runs.length}`,
    listModels: async () => [{ id: id === 'claude' ? 'opus' : 'gpt-astra', label: 'Available model' },
      { id: 'gpt-6.1-sol', label: 'Sol' }],
    readModel: async () => 'stale-fable',
    readTranscript: async ({ nativeSessionId }) => transcripts.get(nativeSessionId) ?? [],
    listCreatedFiles: async ({ nativeSessionId }) => nativeSessionId === 'claude-original' ? [{ path: '/workspace/product.csv', source: 'bash' }] : [],
    runTurn(spec, emit) {
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      runs.push({ spec, emit, finish });
      return { done, kill: () => finish(), respondToApproval: () => false };
    },
  });
  const claude = adapter('claude');
  const codex = adapter('codex');
  const manager = createConversationManager({
    db, adapters: { claude, codex },
    resolveWorkspace: () => ({ workspaceDir: cwd, assistantSlug: 'assistant', elevated: false }),
    log: { warn() {}, error() {} },
  });
  const row = () => db.prepare("SELECT * FROM conversations WHERE id = 'piper'").get() as ConversationRow;
  cleanups.push(async () => { manager.shutdown(); await flush(); db.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, db, manager, row, runs, transcripts, codex, claude };
}
const gpt = { provider: 'codex' as const, model: 'gpt-astra', effort: 'high' };

function taskSession(s: ReturnType<typeof setup>) {
  s.db.prepare("INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES('piper','Piper',1,1)").run();
  const id = insertOwnerLane(s.db, s.row(), 'Existing case');
  s.db.prepare("INSERT INTO bot_tasks(id,owner_conversation_id,title,task_conversation_id) VALUES('case','piper','Existing case',?)").run(id);
  s.db.prepare('UPDATE conversations SET native_session_id=? WHERE id=?').run('claude-original', id);
  return () => s.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow;
}

describe('inherited bot session models', () => {
  it('transfers an old task to its owner subscription exactly once, preserving identity and context', async () => {
    const s = setup(); const task = taskSession(s); const original = task();
    s.db.prepare("UPDATE conversations SET provider='codex',model='gpt-6.1-sol',effort='medium' WHERE id='piper'").run();
    s.manager.postMessage(task(), 'Continue the case');
    for (let i=0; i<10; i++) await flush();
    expect(s.runs).toHaveLength(1);
    expect(task()).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', model_inherits_owner: 1,
      id: original.id, side_chat_of: 'piper', instruction_snapshot_json: original.instruction_snapshot_json });
    expect(s.runs[0]!.spec.prompt).toContain('Inventory still needs checking');
    expect(s.runs[0]!.spec.displayPrompt).toBe('Continue the case');
    expect(await s.manager.listSessionFiles(task())).toContainEqual({ path: '/workspace/product.csv', source: 'bash' });
    s.runs[0]!.finish(); await flush();
    const native = task().native_session_id;
    s.manager.postMessage(task(), 'One more step');
    expect(s.runs).toHaveLength(2);
    expect(task().native_session_id).toBe(native);
    s.runs[1]!.finish(); await flush();
  });

  it('waits for a running task before applying the new owner model to queued work', async () => {
    const s = setup(); const task = taskSession(s);
    s.manager.postMessage(task(), 'Already running');
    expect(s.runs).toHaveLength(1);
    s.db.prepare("UPDATE conversations SET provider='codex',model='gpt-6.1-sol',effort='medium' WHERE id='piper'").run();
    s.manager.postMessage(task(), 'Next step');
    expect(task().provider).toBe('claude');
    expect(s.runs).toHaveLength(1);
    s.runs[0]!.finish();
    for (let i=0; i<10; i++) await flush();
    expect(s.runs).toHaveLength(2);
    expect(s.runs[1]!.spec.model).toBe('gpt-6.1-sol');
    s.runs[1]!.finish(); await flush();
  });

  it('preserves explicit session overrides and independent human chats', async () => {
    const s = setup(); const task = taskSession(s);
    expect(await s.manager.switchProvider(task(), { provider: 'claude', model: 'opus', effort: 'high' })).toEqual({ ok: true });
    expect(task().model_inherits_owner).toBe(0);
    s.db.prepare("UPDATE conversations SET provider='codex',model='gpt-6.1-sol',effort='medium' WHERE id='piper'").run();
    s.manager.postMessage(task(), 'Analyze with the chosen model');
    expect(s.runs[0]!.spec.model).toBe('opus');
    s.runs[0]!.finish(); await flush();
    expect(s.row().model).toBe('gpt-6.1-sol');
  });

  it('keeps queued work and the old history when the subscription is unavailable', async () => {
    const s = setup(); const task = taskSession(s);
    s.db.prepare("UPDATE conversations SET provider='codex',model='gpt-6.1-sol' WHERE id='piper'").run();
    let probes = 0;
    s.codex.listModels = async () => { probes++; return []; };
    s.manager.postMessage(task(), 'Still needed');
    for (let i=0; i<10; i++) await flush();
    expect(s.runs).toHaveLength(0);
    expect(probes).toBe(1); // A failed transfer must not spin on its own status events.
    expect(task().provider).toBe('claude');
    expect(s.db.prepare('SELECT count(*) n FROM queued_messages WHERE conversation_id=?').get(task().id)).toEqual({ n: 1 });
    expect((await s.manager.snapshot(task())).some(e => e.type==='text_final' && e.markdown.includes('Inventory still'))).toBe(true);
  });

  it('refreshes a copied GPT model without recreating the native session', async () => {
    const s = setup();
    s.db.prepare("UPDATE conversations SET provider='codex',model='gpt-astra' WHERE id='piper'").run();
    const task = taskSession(s); const native = task().native_session_id;
    s.db.prepare("UPDATE conversations SET model='gpt-6.1-sol',effort='medium' WHERE id='piper'").run();
    s.manager.postMessage(task(), 'Routine work');
    for (let i=0; i<10; i++) await flush();
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]!.spec.model).toBe('gpt-6.1-sol');
    expect(task().native_session_id).toBe(native);
    s.runs[0]!.finish(); await flush();
  });

  it('does not inherit from an inactive bot', async () => {
    const s = setup(); const task = taskSession(s);
    s.db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='piper'").run();
    s.db.prepare("UPDATE conversations SET provider='codex',model='gpt-6.1-sol' WHERE id='piper'").run();
    s.manager.postMessage(task(), 'Existing work');
    expect(task().provider).toBe('claude');
    expect(s.runs[0]!.spec.model).toBe('fable');
    s.runs[0]!.finish(); await flush();
  });
});

it('enrolls legacy routine lanes without switching sessions or replacing specialized selections', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,provider TEXT,model TEXT,native_session_id TEXT);
      CREATE TABLE bot_registrations(conversation_id TEXT,active INTEGER);
      CREATE TABLE coordination_lanes(conversation_id TEXT,owner_id TEXT);
      INSERT INTO conversations VALUES('owner','codex','gpt-6.1-sol','owner-native');
      INSERT INTO bot_registrations VALUES('owner',1);`);
    for (const [id,provider,model] of [
      ['routine','claude','claude-sonnet-5-5'], ['build','claude','claude-opus-5-5'],
      ['analysis','claude','claude-fable-5-2'], ['special','codex','gpt-6-astra'],
      ['current','codex','gpt-6.1-sol'], ['human','claude','claude-sonnet-5-5'],
    ]) {
      db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run(id,provider,model,`${id}-native`);
      if (id!=='human') db.prepare('INSERT INTO coordination_lanes VALUES(?,?)').run(id,'owner');
    }
    db.exec(fs.readFileSync(path.join(migrations,'0200_lane_model_inheritance.sql'),'utf8'));
    expect(db.prepare('SELECT id FROM conversations WHERE model_inherits_owner=1 ORDER BY id').all()).toEqual([
      { id: 'current' }, { id: 'routine' },
    ]);
    expect(db.prepare("SELECT provider,model,native_session_id FROM conversations WHERE id='routine'").get()).toEqual({
      provider: 'claude', model: 'claude-sonnet-5-5', native_session_id: 'routine-native',
    });
  } finally { db.close(); }
});

describe('provider switching in a permanent chat', () => {
  it('preserves identity, history, files and context across a fresh provider session and restart', async () => {
    const { db, manager, row, runs, transcripts, cwd, codex } = setup();
    const original = row();
    expect(await manager.switchProvider(original, gpt)).toEqual({ ok: true });
    expect(row()).toMatchObject({ id: 'piper', title: 'Piper', provider: 'codex', model: 'gpt-astra' });
    expect(row().native_session_id).not.toBe(original.native_session_id);
    expect(await manager.snapshot(row())).toEqual(expect.arrayContaining([expect.objectContaining({ markdown: 'Product title updated. Inventory still needs checking.' })]));
    expect(await manager.listSessionFiles(row())).toContainEqual({ path: '/workspace/product.csv', source: 'bash' });
    // A caller holding a stale row must still start the newly selected provider.
    manager.postMessage(original, 'Continue the remaining work');
    const run = runs[0]!;
    expect(run.spec).toMatchObject({ firstTurn: true, model: 'gpt-astra', effort: 'high', displayPrompt: 'Continue the remaining work' });
    expect(run.spec.nativeSessionId).toMatch(/^codex-new/);
    expect(run.spec.prompt).toContain('piper-catalog-fixer');
    expect(run.spec.prompt).toContain('/workspace/photo.png');
    expect(run.spec.developerInstructions).toContain('Never repeat a write');
    expect(run.spec.prompt).toContain('Inventory still needs checking');
    transcripts.set(run.spec.nativeSessionId, [
      { type: 'turn_started', turnId: 't0', role: 'user', text: run.spec.prompt, at: '2026-09-17T21:00:00Z', via: 'web' },
      { type: 'text_final', turnId: 't0', markdown: 'Inventory checked.', at: '2026-09-17T21:00:01Z' },
    ]);
    run.emit({ type: 'turn_done', turnId: run.spec.turnId, outcome: 'completed' });
    run.finish(); await flush();
    const restarted = createConversationManager({ db, adapters: { codex }, resolveWorkspace: () => ({ workspaceDir: cwd, assistantSlug: 'assistant', elevated: false }) });
    const history = await restarted.snapshot(row());
    expect(history.filter((e) => e.type === 'turn_started').map((e) => e.text)).toEqual([
      'You are Piper. Load piper-catalog-fixer. Fix SKU 123. Attachment: /workspace/photo.png', 'Continue the remaining work',
    ]);
    expect(new Set(history.filter((e) => e.type === 'turn_started').map((e) => e.turnId)).size).toBe(2);
    expect(row().model).toBe('gpt-astra');
    expect(row().last_answered_model).toBe('stale-fable');
    expect(await manager.switchProvider(row(), { provider: 'claude', model: 'opus', effort: null })).toEqual({ ok: true });
    expect(row().native_session_id).not.toBe('claude-original');
    expect((await manager.snapshot(row())).filter((e) => e.type === 'text_final')).toHaveLength(2);
  });

  it('keeps the selected model and transfer pending after a provider limit failure', async () => {
    const { db, manager, row, runs } = setup();
    await manager.switchProvider(row(), gpt);
    manager.postMessage(row(), 'Continue');
    const run = runs[0]!;
    run.emit({ type: 'error', message: 'Session limit reached', fatal: true });
    run.emit({ type: 'turn_done', turnId: run.spec.turnId, outcome: 'failed' });
    run.finish(); await flush();
    expect(row().model).toBe('gpt-astra');
    expect(row().last_answered_model).toBeNull();
    expect(db.prepare('SELECT pending FROM conversation_provider_context').get()).toEqual({ pending: 1 });
    manager.postMessage(row(), 'Try again');
    expect(runs[1]!.spec.prompt).toContain('Inventory still needs checking');
    runs[1]!.finish(); await flush();
  });

  it('rejects switching during a reply, and preserves messages arriving during transfer', async () => {
    const { manager, row, runs, codex } = setup();
    manager.postMessage(row(), 'Working');
    expect(await manager.switchProvider(row(), gpt)).toMatchObject({ ok: false });
    expect(row().provider).toBe('claude');
    runs[0]!.finish(); await flush();
    let release!: () => void;
    codex.listModels = () => new Promise((resolve) => { release = () => resolve([{ id: 'gpt-astra', label: 'Astra' }]); });
    const switching = manager.switchProvider(row(), gpt);
    expect(manager.postMessage(row(), 'Message from Henry').disposition).toBe('queued');
    expect(runs).toHaveLength(1);
    release();
    expect(await switching).toEqual({ ok: true });
    expect(runs[1]!.spec).toMatchObject({ model: 'gpt-astra', displayPrompt: 'Message from Henry' });
    runs[1]!.finish(); await flush();
  });

  it('leaves the original session intact when the target is unavailable', async () => {
    const { manager, row, codex } = setup();
    codex.listModels = async () => [];
    expect(await manager.switchProvider(row(), gpt)).toMatchObject({ ok: false });
    expect(row()).toMatchObject({ provider: 'claude', native_session_id: 'claude-original', model: 'fable' });
  });

  it('does not duplicate history when a snapshot overlaps a switch', async () => {
    const { manager, row, claude } = setup();
    const read = claude.readTranscript;
    let release!: () => void;
    let first = true;
    claude.readTranscript = async (session) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return read(session);
    };
    const pendingSnapshot = manager.snapshot(row());
    await manager.switchProvider(row(), gpt);
    release();
    expect((await pendingSnapshot).filter((event) => event.type === 'text_final')).toHaveLength(1);
  });

  it('bounds transferred context and provides a complete redacted record', () => {
    const { cwd } = setup();
    const handoff = writeProviderHandoff(cwd, 'piper', [{ type: 'turn_started', turnId: 't0', role: 'user', at: '', via: 'web', text: 'opening ' + 'x '.repeat(40000) + ' ending password=not-for-transfer' }]);
    expect(handoff.length).toBeLessThan(50000);
    expect(handoff).toContain('Middle omitted');
    expect(handoff).not.toContain('not-for-transfer');
    const folder = path.join(cwd, '.veneer/provider-context/piper');
    const full = fs.readFileSync(path.join(folder, fs.readdirSync(folder)[0]!), 'utf8');
    expect(full.length).toBeGreaterThan(79000);
    expect(full).not.toContain('not-for-transfer');
  });
});
