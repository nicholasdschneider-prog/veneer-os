import { focusedAutomations, isFocusedMember } from '../src/bots/focusedWorkspace.js';
import express from 'express';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createTeamService } from '../src/bots/teams.js';
import { createBotService, proposalSchema, type Actor } from '../src/bots/service.js';
import { canViewConversation, canSendToConversation, canTrainBusinessBot, businessScopeSql } from '../src/conversations/access.js';
import { employeeRouteAllowed } from '../src/bots/employeeAccess.js';
import { createApiRouter } from '../src/routes/api.js';
import { attachWebSocket } from '../src/channels/webSocket.js';
import { getGeneratedFile } from '../src/files/generatedFiles.js';
import type { AppContext } from '../src/context.js';
import type { ConversationRow, UserRow } from '../src/db/db.js';
let db: Database.Database;
let owner: Actor;
let ali: Actor;
let teams: ReturnType<typeof createTeamService>;
let decisions: ReturnType<typeof createBotService>;
let teamId: string;
const actor = (id: number): Actor => ({ user: db.prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow });
const grant = (ids = ['grant', 'nora'], activate = true) => teams.manage(owner, { action: 'employee', team_id: teamId, user_id: 2, email: 'ali@fixture.test', conversation_ids: ids, activate });
const raise = (id = 'grant', source = 'case') => decisions.raise({ ...owner, conversationId: id }, { source_key: source, proposal_key: 'question', proposal: proposalSchema.parse({ question: 'Confirm customer details?', recommendation: 'Use the supplied information.', consequence: 'Internal fixture only', assignee_id: 1, blocked_action: 'Finish the response', evidence: [{ label: 'Case', conversation_id: id }] }) });
const answer = { action: 'approve', text: 'Use the confirmed information.', scope: 'this_case' };
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
  db.prepare("INSERT INTO users(id,email,display_name,role,status) VALUES(1,'owner@fixture.test','Owner','owner','active'),(2,'ali@fixture.test','Ali','member','pending'),(3,'viewer@fixture.test','Viewer','member','active')").run();
  owner = actor(1); ali = actor(2); teams = createTeamService(db); decisions = createBotService(db);
  for (const id of ['henry', 'grant', 'nora', 'dev']) {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,visibility,title,provider,native_session_id) VALUES(?,1,1,'team',?,'codex',?)").run(id, id, `fixture-${id}`);
    decisions.register(owner, id, id, true);
  }
  teamId = teams.manage(owner, { action: 'create', name: 'ERVP' }).id;
  const p = teams.bulk(owner, { mode: 'preview', team_id: teamId, request_key: 'enroll', bots: [
    { conversation_id: 'henry', name: 'Henry', role: 'coordinator' },
    { conversation_id: 'grant', name: 'Grant', role: 'lead', subteam: 'Customer Service' },
    { conversation_id: 'nora', name: 'Nora', role: 'bot', subteam: 'Customer Service', reports_to: 'grant' },
  ] });
  teams.bulk(owner, { mode: 'apply', team_id: teamId, preview_id: p.preview_id });
});
afterEach(() => db.close());

describe('restricted employee workspace', () => {
  it('approves atomically, preserves bot identity, and denies legacy Team chats and other departments', () => {
    const before = db.prepare('SELECT * FROM conversations ORDER BY id').all();
    expect(() => grant(['grant', 'dev'])).toThrow('active, shared bots');
    expect(actor(2).user.status).toBe('pending');
    expect(db.prepare('SELECT * FROM employee_workspaces').all()).toHaveLength(0);
    grant();
    expect(actor(2).user.status).toBe('active');
    expect(db.prepare('SELECT * FROM conversations ORDER BY id').all()).toEqual(before);
    for (const id of ['henry', 'grant', 'nora', 'dev']) {
      const row = db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow;
      expect(canViewConversation(ali.user, row, db)).toBe(['grant', 'nora'].includes(id));
      expect(canViewConversation(owner.user, row, db)).toBe(true);
    }
    expect(db.prepare(`SELECT id FROM conversations c WHERE ${businessScopeSql(2)} ORDER BY id`).all()).toEqual([{ id: 'grant' }, { id: 'nora' }]);
    expect(() => teams.manage(owner, { action: 'employee', team_id: teamId, user_id: 2, email: 'wrong@fixture.test', conversation_ids: ['grant'] })).toThrow('correct');
    expect(() => teams.manage({ ...owner, conversationId: 'grant' }, { action: 'employee', team_id: teamId, user_id: 2, email: 'ali@fixture.test', conversation_ids: ['grant'] })).toThrow('Platform Dev');
  });

  it('retains restriction after revocation, with no fallback to legacy or broad business membership', () => {
    grant();
    teams.manage(owner, { action: 'member', team_id: teamId, user_id: 2, role: null });
    expect(db.prepare(`SELECT id FROM conversations c WHERE ${businessScopeSql(2)}`).all()).toEqual([]);
    teams.manage(owner, { action: 'member', team_id: teamId, user_id: 2, role: 'manager' });
    expect(db.prepare(`SELECT id FROM conversations c WHERE ${businessScopeSql(2)}`).all()).toEqual([]);
  });

  it('explicitly promotes a verified employee without granting platform administration', async () => {
    grant(['nora']);
    const input = { action: 'member', team_id: teamId, user_id: 2, email: 'ali@fixture.test', role: 'member' };
    expect(() => teams.manage(owner, { ...input, email: 'wrong@fixture.test' })).toThrow('verified member email');
    expect(() => teams.manage(owner, { ...input, role: null })).toThrow('verified member email');
    expect(() => teams.manage({ ...owner, conversationId: 'grant' }, input)).toThrow('Platform Dev');
    expect(db.prepare('SELECT * FROM employee_workspaces').all()).toHaveLength(1);
    teams.manage(owner, input);
    expect(db.prepare('SELECT * FROM employee_workspaces').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM employee_bot_access WHERE user_id=2').all()).toHaveLength(0);
    expect(actor(2).user.role).toBe('member');
    expect(db.prepare("SELECT payload_json FROM business_audit WHERE action='member' ORDER BY id DESC LIMIT 1").get()).toBeDefined();

    const steerMessage = vi.fn(async () => ({ disposition: 'delivered', messageId: 1 }));
    const ctx = { db, resolveIdentity: async () => ({ email: 'ali@fixture.test', agentConversationId: 'nora' }), manager: {
      bus: new EventEmitter(), statusOf: async () => 'idle', snapshot: async () => [], steerMessage,
    } } as unknown as AppContext;
    const app = express(); app.use('/api', createApiRouter(ctx)); const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    try {
      expect((await (await fetch(base + '/me')).json()).user.employeeWorkspace).toBe(false);
      expect((await fetch(base + '/conversations/grant/transcript')).status).toBe(200);
      expect((await fetch(base + '/conversations/grant/steer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Provide the CS evidence for this accounting case.' }) })).status).toBe(200);
      expect(steerMessage).toHaveBeenCalledOnce();
      expect((await fetch(base + '/admin/users')).status).toBe(403);
      teams.manage(owner, { action: 'member', team_id: teamId, user_id: 2, role: 'viewer' });
      expect((await fetch(base + '/conversations/grant/steer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Viewer cannot send.' }) })).status).toBe(404);
      expect(steerMessage).toHaveBeenCalledOnce();
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });

  it('does not lift account-wide restrictions across a different business owner', () => {
    grant();
    db.prepare("UPDATE users SET role='owner' WHERE id=3").run();
    const other = teams.manage(actor(3), { action: 'create', name: 'Other' });
    teams.manage(actor(3), { action: 'member', team_id: other.id, user_id: 2, role: 'member' });
    expect(() => teams.manage(owner, { action: 'member', team_id: teamId, user_id: 2, email: 'ali@fixture.test', role: 'member' })).toThrow('Another business owner');
    expect(db.prepare('SELECT * FROM employee_workspaces').all()).toHaveLength(1);
  });

  it('shares owner questions in both notification queries and serializes claim, release, and answers', () => {
    grant(); const d = raise();
    expect(decisions.list(ali, 'me').map(d => d.id)).toContain(d.id);
    expect(decisions.list(owner, 'me').map(d => d.id)).toContain(d.id);
    expect(() => decisions.answer(ali, d.id, 1, 'unclaimed', answer, 0)).toThrow('Claim');
    const claimed = decisions.handle(ali, d.id, 1, 'claim', 'claim', 0);
    expect(claimed.handler_name).toBe('Ali');
    expect(decisions.handle(ali, d.id, 1, 'claim', 'claim', 0).handling_revision).toBe(1);
    expect(() => decisions.handle(owner, d.id, 1, 'race', 'claim', 0)).toThrow('Handling changed');
    expect(() => decisions.answer(owner, d.id, 1, 'race-answer', answer, 1)).toThrow('Claim');
    decisions.handle(owner, d.id, 1, 'release', 'release', 1);
    expect(() => decisions.answer(ali, d.id, 1, 'stale', answer, 1)).toThrow('Handling changed');
    decisions.handle(owner, d.id, 1, 'take', 'claim', 2);
    decisions.answer(owner, d.id, 1, 'answer', answer, 3);
    expect(() => decisions.answer(ali, d.id, 1, 'duplicate', answer, 3)).toThrow();
    expect(decisions.answer(owner, d.id, 1, 'answer', answer, 3).answer.actor_id).toBe(1);
    expect(db.prepare("SELECT * FROM bot_decision_events WHERE kind='answered'").all()).toHaveLength(1);
    expect(decisions.list(ali, 'me').filter(d => d.state === 'needs_input')).toHaveLength(0);
  });

  it('lets Ali answer and discuss, records attribution, and resets claims on new proposals', () => {
    grant(); const d = raise();
    decisions.reply(ali, d.id, 'reply', 'I checked the case.');
    decisions.handle(ali, d.id, 1, 'claim', 'claim', 0);
    decisions.answer(ali, d.id, 1, 'answer', answer, 1);
    expect(decisions.view(owner, decisions.read(owner, d.id)).answer.actor_id).toBe(2);
    const wake = db.prepare("SELECT reason FROM conversation_wakeups WHERE wake_key LIKE 'bot-decision:%' ORDER BY rowid DESC LIMIT 1").get() as { reason: string };
    expect(wake.reason).toContain('do not request a duplicate owner approval');
    expect(decisions.thread(owner, d.id).messages).toMatchObject([{ actor_name: 'Ali' }]);
    const revised = decisions.revise({ ...owner, conversationId: 'grant' }, d.id, 1, 'revise', { ...d.proposal, question: 'Updated question?' });
    expect(revised.handler_id).toBeNull(); expect(revised.handling_revision).toBe(2);
    expect(() => decisions.handle(ali, d.id, 1, 'old-proposal', 'claim', 2)).toThrow('Proposal changed');
  });
  it('allows pinned employee voice while keeping unrelated APIs closed', () => {
    expect(employeeRouteAllowed('GET', '/live-voice')).toBe(true);
    for (const route of ['/live-voice/calls', '/live-voice/calls/abc/heartbeat', '/live-voice/calls/abc/end']) expect(employeeRouteAllowed('POST', route)).toBe(true);
    expect(employeeRouteAllowed('POST', '/live-voice/admin')).toBe(false);
    expect(employeeRouteAllowed('GET', '/live-voice/other')).toBe(false);
  });

  it('keeps viewer, revoked, foreign evidence, and owner-development authority separate', () => {
    grant(); const d = raise(); const dev = raise('dev');
    teams.manage(owner, { action: 'member', team_id: teamId, user_id: 3, role: 'viewer' });
    expect(() => decisions.handle(actor(3), d.id, 1, 'claim', 'claim', 0)).toThrow('authorized');
    expect(() => decisions.reply(actor(3), d.id, 'reply', 'No')).toThrow('Read-only');
    expect(() => decisions.read(ali, dev.id)).toThrow('not found');
    decisions.handle(ali, d.id, 1, 'claim', 'claim', 0);
    grant(['nora']);
    expect(() => decisions.answer(ali, d.id, 1, 'revoked', answer, 1)).toThrow('not found');
    expect(decisions.list(ali)).toHaveLength(0);
    grant();
    decisions.revise({ ...owner, conversationId: 'grant' }, d.id, 1, 'private-evidence', { ...d.proposal, evidence: [{ label: 'Owner notes', conversation_id: 'henry' }] });
    expect(decisions.list(ali)).toHaveLength(0);
    expect(() => decisions.read(ali, d.id)).toThrow('not found');
  });

  it('denies platform APIs by default, filters HTTP discovery, and refuses employee-origin tools', async () => {
    grant(); raise(); raise('dev');
    let email = 'ali@fixture.test'; let agentConversationId: string | undefined;
    const ctx = { db, resolveIdentity: async () => ({ email, agentConversationId }), manager: { bus: new EventEmitter(), statusOf: async () => 'idle', snapshot: async () => [] } } as unknown as AppContext;
    const app = express(); app.use('/api', createApiRouter(ctx)); const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    try {
      expect((await (await fetch(base + '/me')).json()).user.employeeWorkspace).toBe(true);
      for (const path of ['/projects', '/files', '/memory', '/connectors', '/approvals', '/desktop', '/veneer-browser', '/admin/users', '/todos', '/new-platform-feature']) expect((await fetch(base + path)).status, path).toBe(403);
      for (const id of ['henry', 'dev']) expect((await fetch(base + '/conversations/' + id)).status).toBe(404);
      expect((await fetch(base + '/conversations/grant/transcript')).status).toBe(200);
      const all = await (await fetch(base + '/conversations')).json();
      expect(all.conversations.map((c: { id: string }) => c.id).sort()).toEqual(['grant', 'nora']);
      const bots = await (await fetch(base + '/bots?filter=me')).json();
      expect(bots.bots.map((b: { name: string }) => b.name).sort()).toEqual(['Grant', 'Nora']);
      expect(bots.decisions).toHaveLength(1);
      agentConversationId = 'grant'; expect((await fetch(base + '/bots')).status).toBe(403);
      agentConversationId = undefined; email = 'owner@fixture.test';
      expect((await (await fetch(base + '/bots')).json()).bots).toHaveLength(4);
    } finally { await new Promise<void>(r => server.close(() => r())); }
    expect(employeeRouteAllowed('POST', '/bots/teams/manage')).toBe(false);
    expect(employeeRouteAllowed('POST', '/conversations/new')).toBe(false);
  });

  it('checks generated-file direct IDs against the same bot grants', () => {
    grant();
    for (const id of ['grant', 'dev']) db.prepare("INSERT INTO generated_files(id,path,name,source,conversation_id,user_id,size,mtime_ms) VALUES(?,?,?,'write',?,1,1,1)").run(id, `/fixture/${id}.txt`, `${id}.txt`, id);
    const ctx = { db } as AppContext;
    expect(getGeneratedFile(ctx, ali.user, 'grant')?.id).toBe('grant');
    expect(getGeneratedFile(ctx, ali.user, 'dev')).toBeNull();
  });

  it('revokes an open websocket before subsequent events without relying on a broadcast notification', async () => {
    grant(); const bus = new EventEmitter();
    const ctx = { db, resolveIdentity: async () => ({ email: 'ali@fixture.test' }), manager: { bus, snapshot: async () => [], statusOf: async () => 'idle', activityOf: async () => null, queueSnapshot: async () => ({ revision: 0, messages: [], failedTurn: null }), listWakeups: async () => [] } } as unknown as AppContext;
    const server = createServer(); attachWebSocket(server, ctx);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`);
    const frame = () => new Promise<Record<string, unknown>>(r => ws.once('message', data => r(JSON.parse(String(data)))));
    try {
      await new Promise<void>(r => ws.once('open', r));
      ws.send(JSON.stringify({ kind: 'subscribe', conversationId: 'dev' })); expect((await frame()).kind).toBe('error');
      ws.send(JSON.stringify({ kind: 'subscribe', conversationId: 'grant' })); expect((await frame()).kind).toBe('snapshot');
      grant(['nora']);
      const frames: unknown[] = []; ws.on('message', data => frames.push(JSON.parse(String(data))));
      bus.emit('event', 'grant', { type: 'text_final', turnId: 't', markdown: 'Revoked content', at: new Date().toISOString() });
      ws.send(JSON.stringify({ kind: 'ping' })); await frame();
      expect(frames).toEqual([{ kind: 'pong' }]);
    } finally { ws.close(); await new Promise<void>(r => server.close(() => r())); }
  });
});


describe('focused business members', () => {
  function focus(ids = ['nora'], enabled = true) {
    return teams.manage(owner, { action: 'focus', team_id: teamId, user_id: 2, email: 'ali@fixture.test', conversation_ids: ids, enabled });
  }
  function fullMember() {
    grant(['nora']);
    teams.manage(owner, { action: 'member', team_id: teamId, user_id: 2, email: 'ali@fixture.test', role: 'member' });
  }
  it('scopes chats and routines without changing membership, training or native identity', () => {
    fullMember();
    const before = db.prepare('SELECT * FROM conversations ORDER BY id').all();
    focus();
    const nora = db.prepare("SELECT * FROM conversations WHERE id='nora'").get() as ConversationRow;
    expect(canViewConversation(actor(2).user, nora, db)).toBe(true);
    expect(canSendToConversation(actor(2).user, nora, db)).toBe(true);
    expect(canTrainBusinessBot(actor(2).user, { ...nora, project_id: 'accounting-project' }, db)).toBe(true);
    expect(db.prepare('SELECT * FROM employee_workspaces').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM conversations ORDER BY id').all()).toEqual(before);
    expect(db.prepare(`SELECT id FROM conversations c WHERE ${businessScopeSql(2)}`).all()).toEqual([{ id: 'nora' }]);
    for (const id of ['henry','grant','dev']) {
      const row = db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow;
      expect(canViewConversation(actor(2).user, row, db)).toBe(false);
      expect(canViewConversation(owner.user, row, db)).toBe(true);
    }
    for (const id of ['nora','grant']) db.prepare("INSERT INTO bot_routines(id,conversation_id,created_by,name,instructions,kind) VALUES(?,?,1,?,'private instructions','ticket.created')").run(id,id,id);
    expect(focusedAutomations(db, actor(2).user)).toEqual([expect.objectContaining({ name: 'nora', enabled: false })]);
    expect(JSON.stringify(focusedAutomations(db, actor(2).user))).not.toContain('private instructions');
    expect(db.prepare("SELECT * FROM business_audit WHERE action='focus'").all()).toHaveLength(1);
    focus([], false);
    expect(isFocusedMember(db, 2)).toBe(false);
    expect(canViewConversation(actor(2).user, db.prepare("SELECT * FROM conversations WHERE id='grant'").get() as ConversationRow, db)).toBe(true);
  });
  it('requires verified owner configuration and keeps revoked bot scope closed', () => {
    fullMember();
    expect(() => teams.manage(owner, { action: 'focus', team_id: teamId, user_id: 2, email: 'wrong@fixture.test', conversation_ids: ['nora'] })).toThrow('verified');
    expect(() => focus(['dev'])).toThrow('active, shared');
    expect(() => teams.manage({ ...owner, conversationId: 'nora' }, { action: 'focus', team_id: teamId, user_id: 2, email: 'ali@fixture.test', conversation_ids: ['nora'] })).toThrow('Platform Dev');
    focus();
    teams.manage(owner, { action: 'member', team_id: teamId, user_id: 2, role: null });
    teams.manage(owner, { action: 'member', team_id: teamId, user_id: 2, role: 'member' });
    expect(isFocusedMember(db,2)).toBe(true);
    expect(db.prepare(`SELECT id FROM conversations c WHERE ${businessScopeSql(2)}`).all()).toEqual([]);
    focus();
    teams.manage(owner, { action: 'remove_bot', team_id: teamId, conversation_id: 'nora' });
    expect(db.prepare(`SELECT id FROM conversations c WHERE ${businessScopeSql(2)}`).all()).toEqual([]);
  });
  it('enforces direct HTTP routes and keeps the full-member flag for accounting tools', async () => {
    fullMember(); focus();
    const ctx = { db, resolveIdentity: async () => ({ email: 'ali@fixture.test' }), manager: { bus: new EventEmitter(), statusOf: async () => 'idle', snapshot: async () => [] } } as unknown as AppContext;
    const app = express(); app.use('/api', createApiRouter(ctx)); const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    try {
      expect((await (await fetch(base + '/me')).json()).user).toMatchObject({ focusedWorkspace: true, employeeWorkspace: false, role: 'member' });
      expect((await fetch(base + '/conversations/nora/transcript')).status).toBe(200);
      expect((await fetch(base + '/conversations/grant/transcript')).status).toBe(404);
      expect((await fetch(base + '/scheduled-tasks')).status).toBe(403);
      expect((await fetch(base + '/scheduled-tasks/task/run-now', { method: 'POST' })).status).toBe(403);
      expect((await fetch(base + '/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
      expect((await fetch(base + '/focused-workspace/automations')).status).toBe(200);
      expect((await fetch(base + '/admin/users')).status).toBe(403);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });
});
