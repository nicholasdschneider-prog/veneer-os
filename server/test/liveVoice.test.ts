import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import type { ConversationRow } from '../src/db/db.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import { VoiceWorkspace } from '../src/voice/workspace.js';
import { createApiRouter } from '../src/routes/api.js';

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
let db: Database.Database;
let ctx: AppContext;
let workspace: VoiceWorkspace;
let server: Server | undefined;
let runtime: ReturnType<typeof createConversationManager>;
let requestId: string;
let identity = 'owner@example.com';
let agentConversationId: string | undefined;
let resolveDone: (() => void) | undefined;
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrate(db, migrations);
  db.prepare("INSERT INTO users(email,display_name,role) VALUES('owner@example.com','Owner','owner'),('other@example.com','Other','owner'),('member@example.com','Member','member')").run();
  db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('own',1,1,'Order support','codex','s1'),('other',1,2,'Other work','codex','s2')").run();
  const adapter: ProviderAdapter = { id: 'codex', mintSessionId: () => 's1', readTranscript: async () => [
    { type: 'text_final', turnId: 't1', markdown: 'Customer needs a replacement.', at: new Date().toISOString() },
    { type: 'tool_finished', turnId: 't1', toolId: 'private', ok: true, resultPreview: 'DO NOT EXPOSE TOOL DATA' },
  ], runTurn: () => ({ done: new Promise<void>(r => { resolveDone = r; }), kill: () => resolveDone?.(), respondToApproval: () => true }) };
  runtime = createConversationManager({ db, adapters: { codex: adapter },
    resolveWorkspace: () => ({ workspaceDir: '/tmp', assistantSlug: 'assistant', elevated: false }), approvalTimeoutMs: 60_000,
    log: { warn() {}, error() {} } });
  const conv = db.prepare("SELECT * FROM conversations WHERE id='own'").get() as ConversationRow;
  runtime.postMessage(conv, 'Review pending tickets');
  requestId = runtime.askQuestion('own', 'Replace the item?', [{ label: 'Replace', value: 'replace' }, { label: 'Wait', value: 'wait' }], false, false);
  identity = 'owner@example.com'; agentConversationId = undefined;
  ctx = { db, resolveIdentity: async () => ({ email: identity, agentConversationId }), manager: {
    getQuestion: async (id: string) => runtime.getQuestion(id),
    resolveQuestion: async (id: string, answers: Record<string,string[]>) => runtime.resolveQuestion(id, answers),
    snapshot: async (id: string) => runtime.snapshot(db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow),
    statusOf: async (id: string) => runtime.statusOf(id),
  } } as unknown as AppContext;
  workspace = new VoiceWorkspace(ctx, 1);
});
afterEach(async () => { resolveDone?.(); await new Promise(r => setImmediate(r)); server?.close(); server = undefined; db.close(); });

describe('Henry voice workspace', () => {
  it('reads real blockers and only user-visible messages from owned chats', async () => {
    expect(workspace.blockers()).toMatchObject([{ requestId, conversationId: 'own' }]);
    expect(workspace.chats()).toMatchObject([{ id: 'own' }]);
    expect(await workspace.readChat('own')).toMatchObject({ title: 'Order support' });
    expect(JSON.stringify(await workspace.readChat('own'))).not.toContain('DO NOT EXPOSE');
    await expect(workspace.readChat('other')).rejects.toThrow('not found');
    expect(new VoiceWorkspace(ctx, 2).blockers()).toEqual([]);
  });
  it('validates answers in the real runner, saves the decision and releases the waiting question', async () => {
    expect(runtime.statusOf('own')).toBe('needs_you');
    await expect(workspace.answer('call1', { requestId, answers: { q1: ['bogus'] } })).rejects.toThrow('valid answers');
    expect(runtime.getQuestion(requestId)?.status).toBe('pending');
    expect(workspace.history()).toEqual([]);
    await expect(workspace.answer('call1', { requestId, answers: { q1: ['replace'] } })).resolves.toMatchObject({ ok: true });
    expect(runtime.getQuestion(requestId)).toMatchObject({ status: 'answered', answers: { q1: ['replace'] } });
    expect(runtime.statusOf('own')).toBe('working');
    expect(new VoiceWorkspace(ctx, 1).history()).toMatchObject([{ role: 'decision' }]);
    await expect(workspace.answer('call2', { requestId, answers: { q1: ['replace'] } })).resolves.toMatchObject({ alreadyDelivered: true });
    expect(workspace.history()).toHaveLength(1);
    await expect(workspace.answer('call2', { requestId, answers: { q1: ['wait'] } })).rejects.toThrow();
  });
  it('blocks cross-user decisions, secret cards, and malformed requests', async () => {
    await expect(new VoiceWorkspace(ctx, 2).answer('call', { requestId, answers: { q1: ['replace'] } })).rejects.toThrow();
    const secret = runtime.askQuestion('own','Enter key',[{ label: 'Saved', value: 'saved' }],false,false,{ name:'TEST_KEY',project:'main',config:'prd' });
    expect(workspace.blockers().map(b => b.requestId)).not.toContain(secret);
    await expect(workspace.answer('call', { requestId: secret, answers: { q1: ['saved'] } })).rejects.toThrow();
    await expect(workspace.answer('call', { requestId, answers: { q1: [] } })).rejects.toThrow();
    expect(runtime.getQuestion(requestId)?.status).toBe('pending');
  });
  it('preserves history across calls and redacts recognizable credentials', () => {
    workspace.record('call1','user','password=never_record_this please review orders');
    const saved = new VoiceWorkspace(ctx,1).history();
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain('never_record_this');
    expect(new VoiceWorkspace(ctx,2).history()).toEqual([]);
  });
});

describe('live voice HTTP boundary', () => {
  async function base() {
    const app = express(); app.use('/api',createApiRouter(ctx));
    await new Promise<void>(resolve => { server = app.listen(0,'127.0.0.1',resolve); });
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/live-voice`;
  }
  it('reports setup without exposing secrets and refuses unavailable calls', async () => {
    const url = await base();
    const result = await fetch(url);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toMatchObject({ configuration: { ready:false }, blockers: [{ requestId }] });
    expect((await fetch(`${url}/calls`, { method:'POST',headers:{'Content-Type':'application/json'},body:'{}' })).status).toBe(503);
  });
  it('refuses agent tokens and member accounts', async () => {
    const url = await base(); agentConversationId = 'own';
    expect((await fetch(url)).status).toBe(403);
    agentConversationId = undefined; identity = 'member@example.com';
    expect((await fetch(url)).status).toBe(403);
  });
});
