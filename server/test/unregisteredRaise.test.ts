import Database from 'better-sqlite3';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createBotService, proposalSchema } from '../src/bots/service.js';
import { createBotsRouter } from '../src/bots/routes.js';
import { sendCoordination } from '../src/coordination/routes.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';

describe('raise_decision from a chat with no active registration', () => {
  let db: Database.Database, server: Server, base: string, user: UserRow;
  let bots: ReturnType<typeof createBotService>;
  const proposal = proposalSchema.parse({
    question: 'Which carrier should ship this order?',
    recommendation: 'Use the cheaper carrier.',
    consequence: 'No money moves.',
    assignee_id: 1,
    blocked_action: 'Carrier choice only.',
  });
  const chat = (id: string, extra: { project?: string; business?: string; archived?: number; assistant?: number; owner?: number } = {}) =>
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,project_id,business_team_id,archived,visibility) VALUES(?,?,?,?,'claude',?,?,?,?,'team')")
      .run(id, extra.assistant ?? 1, extra.owner ?? 1, id, `native-${id}`, extra.project ?? null, extra.business ?? null, extra.archived ?? 0);
  const register = (id: string, name: string, active = true) => bots.register({ user }, id, name, active);
  const refusal = (id: string) => {
    try {
      bots.raise({ user, conversationId: id }, { source_key: 's', proposal_key: 'p', proposal });
    } catch (e) {
      return e as Error & { status: number };
    }
    throw new Error('expected a refusal');
  };
  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'one@example.test','One','owner')").run();
    user = db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
    bots = createBotService(db);
    chat('asker');
    chat('sage');
    register('sage', 'Sage');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = user;
      req.agentConversationId = String(req.headers['x-chat']);
      next();
    });
    app.use('/bots', createBotsRouter({ db } as unknown as AppContext));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it('refuses without a card and names a bot and ask_user, never surface_to_human', () => {
    const e = refusal('asker');
    expect(e.status).toBe(409);
    expect(e.message).toContain('Bot registration is inactive');
    expect(e.message).toContain('no card was created');
    expect(e.message).toContain('send_message');
    expect(e.message).toContain('Sage (sage)');
    expect(e.message).toContain('ask_user');
    expect(e.message).not.toContain('surface_to_human');
    expect(db.prepare('SELECT COUNT(*) n FROM bot_decisions').get()).toEqual({ n: 0 });
  });

  it('names only bots send_message would accept, the chat’s own project first', () => {
    db.prepare("INSERT INTO projects(id,slug,name) VALUES('ervp','ervp','ERVP')").run();
    db.prepare("UPDATE conversations SET project_id='ervp' WHERE id='asker'").run();
    chat('tess', { project: 'ervp' });
    register('tess', 'Tess');
    chat('boris');
    register('boris', 'Boris');
    chat('gone');
    register('gone', 'Gone');
    db.prepare("UPDATE conversations SET archived=1 WHERE id='gone'").run();
    chat('off');
    register('off', 'Off', false);
    const { message } = refusal('asker');
    expect(message.indexOf('Tess (tess)')).toBeGreaterThan(-1);
    expect(message.indexOf('Tess (tess)')).toBeLessThan(message.indexOf('Sage (sage)'));
    for (const name of ['Boris', 'Gone', 'Off']) expect(message).not.toContain(name);
  });

  it('keeps another business’s bots out of the list', () => {
    db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('a','A',1),('b','B',1)").run();
    db.prepare("UPDATE conversations SET business_team_id='a' WHERE id='asker'").run();
    db.prepare("UPDATE conversations SET business_team_id='b' WHERE id='sage'").run();
    chat('tess');
    register('tess', 'Tess');
    db.prepare("UPDATE conversations SET business_team_id='a' WHERE id='tess'").run();
    const { message } = refusal('asker');
    expect(message).toContain('Tess (tess)');
    expect(message).not.toContain('Sage');
  });

  it('gives the same routes to a chat whose registration was turned off', () => {
    chat('former');
    register('former', 'Former', false);
    const { message } = refusal('former');
    expect(message).toContain('Sage (sage)');
    expect(message).not.toContain('Former (former)');
  });

  it('says so when no bot is reachable', () => {
    register('sage', 'Sage', false);
    const { message } = refusal('asker');
    expect(message).toContain('No registered bot is reachable');
    expect(message).toContain('ask_user');
  });

  it('refuses over HTTP before validating the proposal', async () => {
    const res = await fetch(`${base}/bots/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chat': 'asker' },
      body: JSON.stringify({ source_key: 's', proposal_key: 'p', proposal: { question: 'incomplete' } }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('Sage (sage)');
  });

  it('lets the named bot receive the question and raise under its own identity only', async () => {
    const queueMessage = vi.fn(async () => ({ messageId: 1, disposition: 'queued' }));
    const ctx = { db, manager: { queueMessage, statusOf: vi.fn(async () => 'idle'), bus: { emit: vi.fn() } } } as unknown as AppContext;
    const req = { user, agentConversationId: 'asker', body: { request_key: 'question-1' } } as unknown as express.Request;
    const target = db.prepare("SELECT * FROM conversations WHERE id='sage'").get() as Parameters<typeof sendCoordination>[2];
    await sendCoordination(ctx, req, target, 'Please ask Nick which carrier to use.');
    expect(queueMessage).toHaveBeenCalledOnce();
    const raised = bots.raise({ user, conversationId: 'sage' }, { source_key: 's', proposal_key: 'p', proposal });
    expect(db.prepare('SELECT conversation_id FROM bot_decisions WHERE id=?').get(raised.id)).toEqual({ conversation_id: 'sage' });
    expect(() => bots.answer({ user, conversationId: 'asker' }, raised.id, raised.version, 'k', { action: 'approve', text: 'yes', scope: 'this' })).toThrow();
    expect(() => bots.answer({ user, conversationId: 'sage' }, raised.id, raised.version, 'k', { action: 'approve', text: 'yes', scope: 'this' })).toThrow('A human answer is required');
    expect(db.prepare("SELECT 1 FROM bot_registrations WHERE conversation_id='asker'").get()).toBeUndefined();
  });
});
