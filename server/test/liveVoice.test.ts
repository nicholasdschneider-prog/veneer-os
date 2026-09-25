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
    steerMessage: async (id: string, text: string, actorUserId?: number) => { posted.push({ id, text, actorUserId }); return { ok: true, queued: true }; },
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
  it('pages older visible context and reports clipping without leaking hidden events', async () => {
    ctx.manager.snapshot = async () => [
      ...Array.from({length:30}, (_,i) => ({type:'text_final' as const,turnId:`t${i}`,markdown:`Result ${i}`,at:new Date().toISOString()})),
      {type:'text_final' as const,turnId:'long',markdown:'a'.repeat(4500)+'FINAL RECEIPT',at:new Date().toISOString()},
    ];
    const latest = await workspace.readChat('own');
    expect(latest.coverage).toEqual({totalMessages:31,returnedMessages:24,olderBefore:7,clippedMessages:1});
    expect(latest.messages.at(-1)?.text).toContain('FINAL RECEIPT');
    expect(latest.messages.at(-1)?.text).toContain('omitted');
    const older = await workspace.readChat('own',latest.coverage.olderBefore!);
    expect(older.coverage.olderBefore).toBeNull();
    expect(older.messages.map(m=>m.text)).toEqual(Array.from({length:7},(_,i)=>`Result ${i}`));
    await expect(workspace.readChat('own',-1)).rejects.toThrow('cursor');
    await expect(new VoiceWorkspace(ctx,2).readChat('own',7)).rejects.toThrow();
  });
  it('searches recorded facts directly without waking a bot or leaking hidden tool data', async () => {
    ctx.manager.snapshot = async () => [
      { type: 'text_final', turnId: 'a', at: '2026-09-21T15:00:00Z', markdown: 'Order 100121722: the second parcel has no carrier acceptance. Weight is unknown.' },
      { type: 'tool_finished', turnId: 'a', toolId: 'secret', ok: true, resultPreview: 'PRIVATE 100121722' },
    ];
    const pinned = new VoiceWorkspace(ctx, 1, 'own');
    const result = await pinned.searchContext('100121722');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ role: 'assistant', at: '2026-09-21T15:00:00Z', excerpt: false });
    expect(result.source).toContain('not a fresh');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(posted).toEqual([]);
    expect((await pinned.searchContext('absent-order')).matches).toEqual([]);
    db.prepare("UPDATE users SET status='disabled' WHERE id=2").run();
    await expect(new VoiceWorkspace(ctx, 2, 'own').searchContext('100121722')).rejects.toThrow();
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

describe('ordinary thread voice and staff permissions', () => {
  it('persists a dispatch receipt across reconnects and never repeats uncertain work', async () => {
    const call = new VoiceWorkspace(ctx, 1, 'own');
    await call.sendMessage('Review this order', 'order-1');
    await new VoiceWorkspace(ctx, 1, 'own').sendMessage('Review this order', 'order-1');
    expect(posted).toHaveLength(1);
    await expect(call.sendMessage('Different action', 'order-1')).rejects.toThrow('different text');
    db.prepare("INSERT INTO voice_dispatches(user_id,conversation_id,instruction_id,text) VALUES(1,'own','uncertain','Check status')").run();
    expect(await call.sendMessage('Check status','uncertain')).toMatchObject({ok:false});
    expect(posted).toHaveLength(1);
  });
  it('lets staff use shared threads but isolates transcripts by both user and thread', async () => {
    const staff = new VoiceWorkspace(ctx, 3, 'own');
    expect(staff.bot().canMessage).toBe(true);
    await staff.sendMessage('Check the order', 'staff-1');
    expect(posted[0]?.actorUserId).toBe(3);
    staff.record('call','user','Staff private voice history');
    expect(new VoiceWorkspace(ctx, 1, 'own').history()).toEqual([]);
    expect(new VoiceWorkspace(ctx, 3, 'other').history()).toEqual([]);
    expect(staff.history()).toHaveLength(1);
    db.prepare("UPDATE conversations SET visibility='private' WHERE id='own'").run();
    expect(() => staff.history()).toThrow('not found');
    await expect(staff.sendMessage('Again','staff-2')).rejects.toThrow('not found');
  });
  it('respects business membership and viewer permissions without granting staff question approval', async () => {
    db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Support',1)").run();
    db.prepare("UPDATE conversations SET business_team_id='team' WHERE id='own'").run();
    const staff = new VoiceWorkspace(ctx,3,'own');
    expect(() => staff.bot()).toThrow();
    db.prepare("INSERT INTO business_team_members(team_id,user_id,role) VALUES('team',3,'viewer')").run();
    expect(staff.bot().canMessage).toBe(false);
    await expect(staff.sendMessage('Do it','viewer-1')).rejects.toThrow();
    db.prepare("UPDATE business_team_members SET role='member' WHERE user_id=3").run();
    expect(staff.bot().canMessage).toBe(true);
    expect(staff.blockers()).toHaveLength(1);
    await expect(staff.answer('call',{requestId,answers:{q1:['replace']}})).rejects.toThrow('cannot answer');
    db.prepare("UPDATE users SET status='disabled' WHERE id=3").run();
    await expect(staff.readChat('own')).rejects.toThrow();
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
    await expect(call.readChat('other')).rejects.toThrow('Only the conversation');
    expect(new VoiceWorkspace(ctx, 1, 'other').bot()).toMatchObject({ conversationId: 'other' });
    db.prepare("UPDATE conversations SET visibility='private' WHERE id='own'").run();
    expect(() => new VoiceWorkspace(ctx, 2, 'own').bot()).toThrow();
    expect(() => new VoiceWorkspace(ctx, 1, 'missing').bot()).toThrow();
  });
  it('queues a live fact check without changing the proposal or approving an action', () => {
    const decision = registerBot();
    const call = new VoiceWorkspace(ctx, 1, 'own');
    call.discuss('call-facts', decision.id, 'Confirm the package weight.', true);
    const current = call.readDecision(decision.id);
    expect(current).toMatchObject({ version: 1, state: 'needs_input', answer: null });
    expect(current.discussion[0]?.text).toContain('Read-only investigation');
    expect(current.discussion[0]?.text).toContain('Confirm the package weight.');
    expect(call.discussionRevision()).toBeGreaterThan(0);
  });
  it('relays messages, discussion and explicit decisions to the bot', async () => {
    const decision = registerBot();
    const call = new VoiceWorkspace(ctx, 1, 'own');
    await expect(call.sendMessage('Go ahead and refund the customer', 'refund-1')).resolves.toMatchObject({ ok: true });
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
    await expect(new VoiceWorkspace(ctx, 1, 'own').sendMessage('hello', 'hello-1')).rejects.toThrow();
    expect(posted).toEqual([]);
  });
  it('pages the exact reply and structured constraints without mutating the proposal', () => {
    const decision = registerBot();
    const original = JSON.parse((db.prepare('SELECT proposal_json FROM bot_decisions WHERE id=?').get(decision.id) as {proposal_json:string}).proposal_json);
    original.review_summary = { action_title: 'Request the label photo', customer_request: 'Confirm the correct part', background: ['Photo received'], refund: {status:'not_verified'} };
    original.message_delivery = { canonical_case:'case-1', executor_conversation_id:'own', payload:{channel:'email',account:'help@example.com',recipients:['customer@example.com'],subject:'Your part',body:'Details '.repeat(500)+'Please send the product label.',attachments:[],customer:'Customer',ticket:'case-1',context:''} };
    db.prepare('UPDATE bot_decisions SET proposal_json=? WHERE id=?').run(JSON.stringify(original),decision.id);
    const call = new VoiceWorkspace(ctx, 1, 'own');
    let offset: number | null = 0;
    let details = '';
    while (offset !== null) {
      const page = call.voiceDecision(decision.id, offset);
      details += page.proposalDetails;
      offset = page.coverage.nextOffset;
    }
    expect(JSON.parse(details).message_delivery).toEqual(original.message_delivery);
    expect(JSON.parse(details).review_summary).toEqual(original.review_summary);
    expect(call.readDecision(decision.id)).toMatchObject({state:'needs_input',actionTitle:'Request the label photo',customerRequest:'Confirm the correct part'});
    expect(() => new VoiceWorkspace(ctx, 1, 'other').voiceDecision(decision.id)).toThrow('another bot');
  });
  it('saves a spoken reply edit once and requires approval of its new version', () => {
    const decision = registerBot();
    db.prepare("UPDATE bot_decisions SET proposal_json=json_set(proposal_json,'$.blocked_action','EXACT DRAFT: Please send a photo.') WHERE id=?").run(decision.id);
    db.prepare("UPDATE conversations SET visibility='team' WHERE id='own'").run();
    db.prepare('INSERT INTO employee_workspaces(user_id) VALUES(3)').run();
    db.prepare("INSERT INTO employee_bot_access VALUES(3,'own')").run();
    db.prepare("INSERT INTO shared_bot_queues VALUES('own')").run();
    const call = new VoiceWorkspace(ctx, 3, 'own');
    const edit = {decisionId:decision.id,version:1,requestId:'edit-1',body:'Please send a clear photo of the product label. Thank you!'};
    expect(() => call.editReply('call', {...edit,version:9})).toThrow('Proposal changed');
    expect(db.prepare('SELECT handler_id FROM bot_decisions WHERE id=?').get(decision.id)).toEqual({handler_id:null});
    expect(call.editReply('call', edit)).toMatchObject({ok:true,version:2,state:'needs_input',alreadyRecorded:false});
    expect(call.editReply('call', edit)).toMatchObject({ok:true,version:2,alreadyRecorded:true});
    expect(() => call.editReply('call', {...edit,body:'Different text'})).toThrow('conflict');
    expect(call.readDecision(decision.id)).toMatchObject({version:2,answer:null,blockedAction:`EXACT DRAFT: ${edit.body}`});
    expect(db.prepare("SELECT count(*) AS n FROM conversation_wakeups WHERE conversation_id='own'").get()).toEqual({n:0});
    expect(() => call.answerDecision('call', {decisionId:decision.id,version:1,action:'approve',text:'Send it'})).toThrow('Proposal changed');
    expect(call.answerDecision('call', {decisionId:decision.id,version:2,action:'approve',text:'Send that updated reply'})).toMatchObject({ok:true,state:'decided'});
    expect(db.prepare("SELECT count(*) AS n FROM conversation_wakeups WHERE conversation_id='own'").get()).toEqual({n:1});
    db.prepare('DELETE FROM employee_bot_access WHERE user_id=3').run();
    expect(() => call.editReply('call',edit)).toThrow();
  });
  it('retains accepted instructions even when a later status lookup would fail', async () => {
    registerBot();
    ctx.manager.statusOf = async () => { throw new Error('status unavailable'); };
    const call = new VoiceWorkspace(ctx, 1, 'own');
    const receipt = await call.sendMessage('Check the delivery evidence', 'follow-up', 'call-followup');
    expect(receipt).toMatchObject({ok:true});
    expect(await call.sendMessage('Check the delivery evidence','follow-up','call-followup')).toEqual(receipt);
    expect(posted).toHaveLength(1);
    expect(call.history()).toHaveLength(1);
    expect(call.history()[0]?.text).toContain('Instruction delivered');
  });
  it('claims and approves shared cards by phone for staff, with atomic retries and no owner click', () => {
    const decision = registerBot();
    db.prepare("UPDATE conversations SET visibility='team' WHERE id='own'").run();
    db.prepare('INSERT INTO employee_workspaces(user_id) VALUES(3)').run();
    db.prepare("INSERT INTO employee_bot_access VALUES(3,'own')").run();
    db.prepare("INSERT INTO shared_bot_queues VALUES('own')").run();
    const staff = new VoiceWorkspace(ctx, 3, 'own');
    expect(staff.readDecision(decision.id).canAnswer).toBe(true);
    const input = { decisionId: decision.id, version: 1, action: 'approve', text: 'Approve this proposal', scope: 'this_case' };
    expect(() => staff.answerDecision('call', { ...input, version: 99 })).toThrow('Proposal changed');
    expect(db.prepare('SELECT handler_id FROM bot_decisions WHERE id=?').get(decision.id)).toEqual({ handler_id: null });
    expect(staff.answerDecision('call', input)).toMatchObject({ ok: true, state: 'decided', alreadyRecorded: false });
    expect(staff.answerDecision('call', input)).toMatchObject({ ok: true, alreadyRecorded: true });
    expect(db.prepare('SELECT handler_id, json_extract(answer_json,\'$.actor_id\') AS actor FROM bot_decisions WHERE id=?').get(decision.id)).toEqual({ handler_id: 3, actor: 3 });
    expect(db.prepare("SELECT count(*) AS n FROM conversation_wakeups WHERE conversation_id='own'").get()).toEqual({ n: 1 });
    expect(staff.history().filter(e => e.role === 'decision')).toHaveLength(1);
    expect(() => staff.answerDecision('call', { ...input, text: 'Different approval' })).toThrow('Idempotency');
    db.prepare("DELETE FROM employee_bot_access WHERE user_id=3").run();
    expect(() => staff.answerDecision('call', input)).toThrow();
  });
  it('does not take over another teammate’s phone approval or turn discussion into approval', () => {
    const decision = registerBot();
    db.prepare("INSERT INTO shared_bot_queues VALUES('own')").run();
    const user = db.prepare('SELECT * FROM users WHERE id=1').get() as import('../src/db/db.js').UserRow;
    createBotService(db).handle({ user }, decision.id, 1, 'claim', 'claim', 0);
    db.prepare("UPDATE conversations SET visibility='team' WHERE id='own'").run();
    db.prepare('INSERT INTO employee_workspaces VALUES(3)').run();
    db.prepare("INSERT INTO employee_bot_access VALUES(3,'own')").run();
    const staff = new VoiceWorkspace(ctx, 3, 'own');
    expect(() => staff.answerDecision('call', { decisionId: decision.id, version: 1, action: 'approve', text: 'Yes' })).toThrow('Claim');
    const call = new VoiceWorkspace(ctx, 1, 'own');
    call.discuss('call', decision.id, 'Would a refund help?');
    expect(call.readDecision(decision.id)).toMatchObject({ state: 'needs_input', answer: null });
  });
});

describe('live voice HTTP boundary', () => {
  async function base() {
    const app = express(); app.use('/api',createApiRouter(ctx));
    await new Promise<void>(resolve => { server = app.listen(0,'127.0.0.1',resolve); });
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/live-voice`;
  }
  it('keeps session transcripts caller-private and checks current chat access on every page', async () => {
    const url=await base();
    db.prepare("INSERT INTO voice_sessions(id,user_id,conversation_id,started_ms,connected_ms,last_seen_ms,ended_ms,outcome) VALUES('saved',1,'own',1000,2000,5000,6000,'ended')").run();
    for(let i=0;i<205;i++)db.prepare("INSERT INTO voice_entries(user_id,session_id,bot_conversation_id,role,text) VALUES(1,'saved','own','user',?)").run('Line '+i);
    expect(await(await fetch(url+'/sessions?bot=own')).json()).toMatchObject({sessions:[{id:'saved',duration_ms:4000}]});
    expect((await(await fetch(url+'/sessions?bot=own&before_ms=1000&before_id=saved')).json()).sessions).toEqual([]);
    expect((await fetch(url+'/sessions?bot=own&before_ms=1000')).status).toBe(400);
    const first=await(await fetch(url+'/sessions/saved')).json();
    expect(first.entries).toHaveLength(200);
    expect((await(await fetch(url+'/sessions/saved?after='+first.next)).json()).entries).toHaveLength(5);
    identity='other@example.com';
    expect((await fetch(url+'/sessions/saved')).status).toBe(404);
    identity='owner@example.com';agentConversationId='own';
    expect((await fetch(url+'/sessions/saved')).status).toBe(403);
    agentConversationId=undefined;
    db.prepare("UPDATE conversations SET user_id=2,visibility='private' WHERE id='own'").run();
    expect((await fetch(url+'/sessions/saved')).status).toBe(404);
  });
  it('reports setup without exposing secrets and refuses unavailable calls', async () => {
    const url = await base();
    const result = await fetch(url);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toMatchObject({ configuration: { ready:false }, blockers: [{ requestId }] });
    expect((await fetch(`${url}/calls`, { method:'POST',headers:{'Content-Type':'application/json'},body:'{}' })).status).toBe(503);
  });
  it('describes a bot call and hides bots the caller cannot see', async () => {
    const url = await base();
    expect((await fetch(`${url}?bot=own`)).status).toBe(200);
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES('own','Grant',1,1)").run();
    expect(await (await fetch(`${url}?bot=own`)).json()).toMatchObject({ bot: { name: 'Grant' }, decisions: [], blockers: [{ requestId }], chats: [] });
    db.prepare("UPDATE conversations SET visibility='private' WHERE id='other'").run();
    expect((await fetch(`${url}?bot=other`)).status).toBe(404);
  });
  it('refuses agent tokens and unscoped member calls but permits accessible staff threads', async () => {
    const url = await base(); agentConversationId = 'own';
    expect((await fetch(url)).status).toBe(403);
    agentConversationId = undefined; identity = 'member@example.com';
    expect((await fetch(url)).status).toBe(403);
    expect((await fetch(`${url}?bot=own`)).status).toBe(200);
    db.prepare("UPDATE conversations SET visibility='private' WHERE id='own'").run();
    expect((await fetch(`${url}?bot=own`)).status).toBe(404);
  });
});
