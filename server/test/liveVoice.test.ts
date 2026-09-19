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
import { createBotService } from '../src/bots/service.js';

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
let posted: { id: string; text: string; actorUserId?: number }[] = [];
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
  identity = 'owner@example.com'; agentConversationId = undefined; posted = [];
  ctx = { db, resolveIdentity: async () => ({ email: identity, agentConversationId }), manager: {
    getQuestion: async (id: string) => runtime.getQuestion(id),
    resolveQuestion: async (id: string, answers: Record<string,string[]>) => runtime.resolveQuestion(id, answers),
    snapshot: async (id: string) => runtime.snapshot(db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow),
    statusOf: async (id: string) => runtime.statusOf(id),
    postMessage: async (id: string, text: string, actorUserId?: number) => { posted.push({ id, text, actorUserId }); return { ok: true, queued: true }; },
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

describe('bot voice calls', () => {
  const owner = () => db.prepare('SELECT * FROM users WHERE id=1').get() as import('../src/db/db.js').UserRow;
  function registerBot() {
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES('own','Grant',1,1)").run();
    const bots = createBotService(db);
    return bots.raise({ user: owner(), conversationId: 'own' }, { source_key: 'ticket-1', proposal_key: 'refund', proposal: {
      question: 'Refund the duplicate order?', recommendation: 'Refund the second charge.', consequence: '$48 refund', assignee_id: 1,
      team: '', deadline: null, evidence: [], blocked_action: 'Issue refund', blocks_scope: 'task' } });
  }
  it('scopes a bot call to that bot’s chat, questions and decisions', async () => {
    const decision = registerBot();
    const call = new VoiceWorkspace(ctx, 1, 'own');
    expect(call.bot()).toMatchObject({ conversationId: 'own', name: 'Grant', canMessage: true });
    expect(call.blockers()).toMatchObject([{ requestId, conversationId: 'own' }]);
    expect(call.decisions()).toMatchObject([{ decisionId: decision.id, state: 'needs_input', canAnswer: true, question: 'Refund the duplicate order?' }]);
    expect(call.readDecision(decision.id)).toMatchObject({ decisionId: decision.id, discussion: [] });
    await expect(call.readChat('other')).rejects.toThrow('Only the bot');
    expect(() => new VoiceWorkspace(ctx, 1, 'other').bot()).toThrow();
    db.prepare("UPDATE conversations SET visibility='private' WHERE id='own'").run();
    expect(() => new VoiceWorkspace(ctx, 2, 'own').bot()).toThrow();
    expect(() => new VoiceWorkspace(ctx, 1, 'missing').bot()).toThrow();
  });
  it('relays messages, discussion and explicit decisions to the bot', async () => {
    const decision = registerBot();
    const call = new VoiceWorkspace(ctx, 1, 'own');
    await expect(call.sendMessage('Go ahead and refund the customer')).resolves.toMatchObject({ ok: true });
    expect(posted).toEqual([{ id: 'own', text: '[Voice call] Go ahead and refund the customer', actorUserId: 1 }]);
    expect(call.discuss('call1', decision.id, 'What did the customer actually pay?')).toMatchObject({ ok: true });
    expect(call.readDecision(decision.id).discussion).toMatchObject([{ from: 'Owner', text: '[Voice call] What did the customer actually pay?' }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversation_wakeups WHERE conversation_id='own'").get()).toEqual({ n: 1 });
    expect(() => call.answerDecision('call1', { decisionId: decision.id, version: 99, action: 'approve', text: 'Yes' })).toThrow();
    expect(call.answerDecision('call1', { decisionId: decision.id, version: 1, action: 'approve', text: 'Refund it, this case only' })).toMatchObject({ ok: true, state: 'decided' });
    expect(call.decisions()[0]).toMatchObject({ state: 'decided', answer: { action: 'approve' } });
    expect(call.history()).toMatchObject([{ role: 'decision' }]);
    expect(new VoiceWorkspace(ctx, 1).history()).toEqual([]);
    expect(() => call.answerDecision('call1', { decisionId: decision.id, version: 1, action: 'reject', text: 'No' })).toThrow('already');
  });
  it('refuses relays for bots the caller cannot message', async () => {
    registerBot();
    db.prepare("UPDATE conversations SET archived=1 WHERE id='own'").run();
    await expect(new VoiceWorkspace(ctx, 1, 'own').sendMessage('hello')).rejects.toThrow();
    expect(posted).toEqual([]);
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
  it('describes a bot call and hides bots the caller cannot see', async () => {
    const url = await base();
    expect((await fetch(`${url}?bot=own`)).status).toBe(404);
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES('own','Grant',1,1)").run();
    expect(await (await fetch(`${url}?bot=own`)).json()).toMatchObject({ bot: { name: 'Grant' }, decisions: [], blockers: [{ requestId }], chats: [] });
    expect((await fetch(`${url}?bot=other`)).status).toBe(404);
  });
  it('refuses agent tokens and member accounts', async () => {
    const url = await base(); agentConversationId = 'own';
    expect((await fetch(url)).status).toBe(403);
    agentConversationId = undefined; identity = 'member@example.com';
    expect((await fetch(url)).status).toBe(403);
  });
});
