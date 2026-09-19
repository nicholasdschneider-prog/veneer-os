import express from 'express';
import { EventEmitter } from 'node:events';
import { createApiRouter } from '../src/routes/api.js';
import type { AppContext } from '../src/context.js';
import type { AddressInfo } from 'node:net';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { createTeamService } from '../src/bots/teams.js';
import { createBotService, type Actor } from '../src/bots/service.js';
import {
  canViewConversation,
  canSendToConversation,
  businessScopeSql,
} from '../src/conversations/access.js';
import type { ConversationRow, UserRow } from '../src/db/db.js';
let db: Database.Database;
let s: ReturnType<typeof createTeamService>;
let human: Actor;
let bot: Actor;
let teamId: string;
const bots = [
  { conversation_id: 'henry', name: 'Henry', role: 'coordinator' },
  { conversation_id: 'grant', name: 'Grant', role: 'lead', subteam: 'CS' },
  { conversation_id: 'nora', name: 'Nora', role: 'bot', subteam: 'CS', reports_to: 'grant' },
];
const preview = (request_key = 'preview') =>
  s.bulk(bot, { mode: 'preview', team_id: teamId, request_key, bots });
const apply = (preview_id: string) => s.bulk(bot, { mode: 'apply', team_id: teamId, preview_id });
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
  db.prepare(
    "INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@fixture.test','Owner','owner'),(2,'staff@fixture.test','Staff','member'),(3,'other@fixture.test','Other','owner')",
  ).run();
  for (const id of ['henry', 'grant', 'nora', 'foreign', 'other-business'])
    db.prepare(
      "INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,model,effort) VALUES(?,1,?,?, 'codex',?,'team','original-model','medium')",
    ).run(id, id === 'foreign' ? 3 : 1, id, `native-${id}`);
  human = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow };
  bot = { ...human, conversationId: 'henry' };
  s = createTeamService(db);
  teamId = s.manage(human, { action: 'create', name: 'ERVP' }).id;
  s.manage(human, {
    action: 'delegate',
    team_id: teamId,
    conversation_id: 'henry',
    allowed_ids: ['henry', 'grant', 'nora'],
  });
});
afterEach(() => db.close());
describe('business fleet enrollment and permissions', () => {
  it('enforces direct native API, list, discovery, tools and viewer write boundaries', async () => {
    apply(preview().preview_id);
    let email = 'staff@fixture.test';
    const ctx = {
      db,
      resolveIdentity: async () => ({ email }),
      manager: { bus: new EventEmitter(), statusOf: async () => 'idle', snapshot: async () => [] },
    } as unknown as AppContext;
    const app = express();
    app.use('/api', createApiRouter(ctx));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(base + '/api/conversations/henry')).status).toBe(404);
      const all = await (await fetch(base + '/api/conversations')).json();
      expect(all.conversations.some((c: { id: string }) => c.id === 'henry')).toBe(false);
      const recent = await (await fetch(base + '/api/recent-conversations')).json();
      expect(
        recent.conversations.some((c: { conversationId: string }) => c.conversationId === 'henry'),
      ).toBe(false);
      expect(
        (
          await fetch(base + '/api/bots/teams/manage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'member',
              team_id: teamId,
              user_id: 2,
              role: 'manager',
            }),
          })
        ).status,
      ).toBe(403);
      s.manage(human, { action: 'member', team_id: teamId, user_id: 2, role: 'viewer' });
      expect((await fetch(base + '/api/conversations/henry')).status).toBe(200);
      expect(
        (
          await fetch(base + '/api/conversations/henry/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Internal fixture' }),
          })
        ).status,
      ).toBe(404);
      s.manage(human, { action: 'member', team_id: teamId, user_id: 2, role: null });
      expect((await fetch(base + '/api/conversations/henry')).status).toBe(404);
      email = 'owner@fixture.test';
      expect((await fetch(base + '/api/conversations/henry')).status).toBe(200);
      expect(() => s.manage(bot, { action: 'create', name: 'Unauthorized fleet' })).toThrow(
        'Platform Dev',
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('previews then enrolls exactly once across service restart, preserving native identity and ownership', () => {
    const before = db
      .prepare(
        'SELECT id,user_id,project_id,provider,native_session_id,model,effort FROM conversations ORDER BY id',
      )
      .all();
    const p = preview();
    expect(db.prepare('SELECT * FROM business_bot_members').all()).toHaveLength(0);
    const receipt = apply(p.preview_id);
    s = createTeamService(db);
    expect(apply(p.preview_id)).toEqual(receipt);
    expect(preview().preview_id).toBe(p.preview_id);
    expect(db.prepare('SELECT * FROM business_bot_members').all()).toHaveLength(3);
    expect(
      db
        .prepare(
          'SELECT id,user_id,project_id,provider,native_session_id,model,effort FROM conversations ORDER BY id',
        )
        .all(),
    ).toEqual(before);
    expect(() => db.prepare("UPDATE business_audit SET action='changed'").run()).toThrow(
      'immutable',
    );
  });
  it('rejects duplicate, foreign, unapproved and changed enrollment without partial writes', () => {
    expect(() =>
      s.bulk(bot, {
        mode: 'preview',
        team_id: teamId,
        request_key: 'dup',
        bots: [bots[0], bots[0]],
      }),
    ).toThrow('Duplicate');
    expect(() =>
      s.bulk(bot, {
        mode: 'preview',
        team_id: teamId,
        request_key: 'foreign',
        bots: [{ ...bots[0], conversation_id: 'foreign' }],
      }),
    ).toThrow('allowlist');
    expect(() =>
      s.manage(human, {
        action: 'delegate',
        team_id: teamId,
        conversation_id: 'henry',
        allowed_ids: ['foreign'],
      }),
    ).toThrow('allowlist');
    const p = preview();
    db.prepare("UPDATE conversations SET model='changed' WHERE id='grant'").run();
    expect(() => apply(p.preview_id)).toThrow('changed');
    expect(db.prepare('SELECT * FROM business_bot_members').all()).toHaveLength(0);
    expect(() =>
      s.bulk(bot, { mode: 'preview', team_id: teamId, request_key: 'preview', bots: [bots[0]] }),
    ).toThrow('different enrollment');
  });
  it('revokes native delegation, binds previews to actor and rejects existing memberships', () => {
    const p = preview();
    expect(() =>
      s.bulk(
        { ...human, conversationId: 'grant' },
        { mode: 'apply', team_id: teamId, preview_id: p.preview_id },
      ),
    ).toThrow('actor');
    s.manage(human, {
      action: 'delegate',
      team_id: teamId,
      conversation_id: 'henry',
      allowed_ids: [],
    });
    expect(() => apply(p.preview_id)).toThrow('delegation');
    s.manage(human, {
      action: 'delegate',
      team_id: teamId,
      conversation_id: 'henry',
      allowed_ids: ['henry', 'grant', 'nora'],
    });
    expect(() => apply(p.preview_id)).toThrow('changed');
    apply(preview('fresh').preview_id);
    expect(() => preview('again')).toThrow('already belongs');
  });
  it('enforces business membership even for workspace-shared chats and keeps viewer role read-only', () => {
    apply(preview().preview_id);
    const staff = db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow;
    const c = db.prepare("SELECT * FROM conversations WHERE id='grant'").get() as ConversationRow;
    expect(canViewConversation(staff, c, db)).toBe(false);
    expect(canViewConversation(staff, c)).toBe(false);
    expect(
      db.prepare(`SELECT c.id FROM conversations c WHERE ${businessScopeSql(2)}`).all(),
    ).not.toContainEqual({ id: 'grant' });
    expect(s.list({ user: staff })).toHaveLength(0);
    s.manage(human, { action: 'member', team_id: teamId, user_id: 2, role: 'viewer' });
    expect(canViewConversation(staff, c, db)).toBe(true);
    expect(canSendToConversation(staff, c, db)).toBe(false);
    s.manage(human, { action: 'member', team_id: teamId, user_id: 2, role: null });
    expect(canViewConversation(staff, c, db)).toBe(false);
  });
  it('blocks cross-business evidence and agent reads, but visibility never grants answering authority', () => {
    apply(preview().preview_id);
    const other = s.manage(human, { action: 'create', name: 'Other fixture business' });
    const p = s.bulk(human, {
      mode: 'preview',
      team_id: other.id,
      request_key: 'other',
      bots: [{ conversation_id: 'other-business', name: 'Other', role: 'coordinator' }],
    });
    s.bulk(human, { mode: 'apply', team_id: other.id, preview_id: p.preview_id });
    const decisions = createBotService(db);
    expect(() => decisions.chat(bot, 'other-business')).toThrow('not found');
    expect(s.list(bot).map((t) => t.id)).toEqual([teamId]);
    const proposal = {
      question: 'Internal draft?',
      recommendation: 'Review',
      consequence: 'Internal only',
      assignee_id: 1,
      team: '',
      deadline: null,
      evidence: [],
      blocked_action: 'Draft',
      blocks_scope: 'task' as const,
    };
    expect(() =>
      decisions.raise(bot, {
        source_key: 'x',
        proposal_key: 'y',
        proposal: {
          ...proposal,
          evidence: [{ label: 'Other', conversation_id: 'other-business' }],
        },
      }),
    ).toThrow();
    const d = decisions.raise(bot, { source_key: 'x', proposal_key: 'y', proposal });
    s.manage(human, { action: 'member', team_id: teamId, user_id: 2, role: 'member' });
    const staff = { user: db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow };
    expect(decisions.read(staff, d.id).id).toBe(d.id);
    expect(() =>
      decisions.answer(staff, d.id, 1, 'a', { action: 'approve', text: 'yes', scope: 'this_case' }),
    ).toThrow('assigned');
    s.manage(human, { action: 'member', team_id: teamId, user_id: 2, role: null });
    expect(() => decisions.thread(staff, d.id)).toThrow('not found');
  });
  it('reverses membership safely and restores prior registration metadata', () => {
    db.prepare(
      "INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES('nora','Prior Nora',1,1)",
    ).run();
    apply(preview().preview_id);
    expect(() =>
      s.manage(human, { action: 'remove_bot', team_id: teamId, conversation_id: 'grant' }),
    ).toThrow('reporting');
    for (const conversation_id of ['nora', 'grant', 'henry'])
      s.manage(human, { action: 'remove_bot', team_id: teamId, conversation_id });
    expect(db.prepare('SELECT * FROM business_bot_members').all()).toHaveLength(0);
    expect(
      db.prepare("SELECT name,active FROM bot_registrations WHERE conversation_id='nora'").get(),
    ).toEqual({ name: 'Prior Nora', active: 1 });
    expect(db.prepare("SELECT business_team_id FROM conversations WHERE id='henry'").get()).toEqual(
      { business_team_id: null },
    );
  });
});
