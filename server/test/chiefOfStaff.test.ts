import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { createChiefOfStaffService } from '../src/bots/chiefOfStaff.js';
import { BotError, createBotService, type Actor } from '../src/bots/service.js';
import type { UserRow } from '../src/db/db.js';

let db: Database.Database;
let chief: ReturnType<typeof createChiefOfStaffService>;
let bots: ReturnType<typeof createBotService>;
let owner: Actor;
const user = (id: number) => db.prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow;
const as = (conversationId: string, id = 1): Actor => ({ user: user(id), conversationId });
const proposal = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    question: 'Refund the damaged awning?', recommendation: 'Refund in full', consequence: 'Customer waits',
    assignee_id: 1, team: '', deadline: null, evidence: [], blocked_action: 'Refund', blocks_scope: 'task',
    choices: [{ id: 'a', label: 'Refund in full', recommended: true }, { id: 'b', label: 'Offer a replacement' }],
    review_summary: { action_title: 'Refund the awning', request: 'Choose refund or replacement' },
    ...extra,
  });
const decision = (id: string, chat: string, assignee = 1, extra: Record<string, unknown> = {}, state = 'needs_input') =>
  db.prepare('INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id,state) VALUES(?,?,?,?,?,?,?)')
    .run(id, chat, id, id, proposal(extra), assignee, state);
const status = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof BotError) return e.status; throw e; }
  return 200;
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@fixture.test','Owner','owner'),(2,'staff@fixture.test','Staff','member'),(3,'other@fixture.test','Other','owner')").run();
  const platformDev = (db.prepare("SELECT id FROM assistants WHERE slug='platform-dev'").get() as { id: number }).id;
  const ordinary = (db.prepare("SELECT id FROM assistants WHERE slug<>'platform-dev' ORDER BY id LIMIT 1").get() as { id: number }).id;
  const chats: [string, number, number][] = [
    ['archer', 1, ordinary], ['spare', 1, ordinary], ['dev', 1, platformDev], ['sage', 1, ordinary],
    ['mark', 1, ordinary], ['loose', 1, ordinary], ['foreign', 3, ordinary], ['staff-chat', 2, ordinary],
  ];
  for (const [id, userId, assistant] of chats)
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,model,effort) VALUES(?,?,?,?, 'claude',?,'team','m','medium')")
      .run(id, assistant, userId, id, `native-${id}`);
  db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('ervp','ERVP',1),('mph','MP Health',1),('theirs','Theirs',3)").run();
  for (const [id, team] of [['sage', 'ervp'], ['mark', 'mph'], ['foreign', 'theirs']] as const) {
    db.prepare('UPDATE conversations SET business_team_id=? WHERE id=?').run(team, id);
    db.prepare('INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,1)').run(id, id);
  }
  db.prepare("INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES('loose','Loose',1,1)").run();
  owner = { user: user(1) };
  chief = createChiefOfStaffService(db);
  bots = createBotService(db);
});
afterEach(() => db.close());

describe('chief of staff designation', () => {
  it('lets only the owner or the owner’s Platform Dev designate, and audits it', () => {
    const grant = { conversation_id: 'archer', name: 'Archer', enabled: true };
    expect(status(() => chief.designate({ user: user(2) }, { ...grant, conversation_id: 'staff-chat' }))).toBe(403);
    expect(status(() => chief.designate(as('archer'), grant))).toBe(403);
    expect(status(() => chief.designate(as('sage'), grant))).toBe(403);
    expect(status(() => chief.designate({ user: user(3) }, grant))).toBe(404);
    expect(chief.designate(as('dev'), grant)).toEqual({ conversation_id: 'archer', designated: true, name: 'Archer' });
    expect(chief.designate(owner, grant).designated).toBe(true);
    expect(db.prepare('SELECT name,active FROM bot_registrations WHERE conversation_id=?').get('archer')).toEqual({ name: 'Archer', active: 1 });
    expect(db.prepare('SELECT actor_id,actor_chat,action FROM chief_of_staff_audit').all()).toEqual([{ actor_id: 1, actor_chat: 'dev', action: 'granted' }]);
    expect(chief.status(owner).chief_of_staff).toMatchObject({ conversation_id: 'archer', name: 'Archer', active: true });
  });

  it('refuses enrolled, Platform Dev, archived, unnamed and second chats', () => {
    expect(status(() => chief.designate(owner, { conversation_id: 'sage', enabled: true }))).toBe(409);
    expect(status(() => chief.designate(owner, { conversation_id: 'dev', name: 'Dev', enabled: true }))).toBe(409);
    expect(status(() => chief.designate(owner, { conversation_id: 'spare', enabled: true }))).toBe(400);
    db.prepare("UPDATE conversations SET archived=1 WHERE id='spare'").run();
    expect(status(() => chief.designate(owner, { conversation_id: 'spare', name: 'Spare', enabled: true }))).toBe(409);
    db.prepare("UPDATE conversations SET archived=0 WHERE id='spare'").run();
    chief.designate(owner, { conversation_id: 'archer', name: 'Archer', enabled: true });
    expect(status(() => chief.designate(owner, { conversation_id: 'spare', name: 'Spare', enabled: true }))).toBe(409);
    expect(chief.designate(owner, { conversation_id: 'archer', enabled: false })).toEqual({ conversation_id: 'archer', designated: false });
    expect(chief.designate(owner, { conversation_id: 'spare', name: 'Spare', enabled: true }).designated).toBe(true);
    expect((db.prepare('SELECT action FROM chief_of_staff_audit ORDER BY id').all() as { action: string }[]).map((r) => r.action)).toEqual(['granted', 'revoked', 'granted']);
    expect(db.prepare("SELECT active FROM bot_registrations WHERE conversation_id='archer'").get()).toEqual({ active: 1 });
  });
});

describe('open questions overview', () => {
  beforeEach(() => {
    chief.designate(owner, { conversation_id: 'archer', name: 'Archer', enabled: true });
    decision('ervp-q', 'sage');
    decision('mph-q', 'mark');
    decision('answered', 'sage', 1, {}, 'decided');
    decision('for-staff', 'sage', 2);
    decision('theirs-q', 'foreign', 3);
    decision('own-q', 'archer');
  });

  it('lists other bots’ unanswered questions for the owner across businesses', () => {
    const result = bots.openQuestions(as('archer'));
    expect(result.read_only).toBe(true);
    expect(result.questions.map((q) => q.decision_id).sort()).toEqual(['ervp-q', 'mph-q']);
    expect(result.questions.find((q) => q.decision_id === 'ervp-q')).toMatchObject({
      version: 1,
      bot: { conversation_id: 'sage', name: 'sage' },
      business: { id: 'ervp', name: 'ERVP' },
      question: 'Refund the damaged awning?',
      recommendation: 'Refund in full',
      review_summary: { action_title: 'Refund the awning' },
      choices: [{ label: 'Refund in full', description: null, recommended: true }, { label: 'Offer a replacement', description: null, recommended: false }],
    });
  });

  it('is closed to every other bot and to a human session', () => {
    expect(status(() => bots.openQuestions(as('loose')))).toBe(403);
    expect(status(() => bots.openQuestions(as('sage')))).toBe(403);
    expect(status(() => bots.openQuestions(owner))).toBe(403);
    expect(status(() => bots.openQuestions(as('archer', 3)))).toBe(403);
  });

  it('stops when the designation lapses', () => {
    db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='archer'").run();
    expect(status(() => bots.openQuestions(as('archer')))).toBe(403);
    db.prepare("UPDATE bot_registrations SET active=1 WHERE conversation_id='archer'").run();
    db.prepare("UPDATE conversations SET business_team_id='ervp' WHERE id='archer'").run();
    expect(status(() => bots.openQuestions(as('archer')))).toBe(403);
    db.prepare("UPDATE conversations SET business_team_id=NULL WHERE id='archer'").run();
    chief.designate(owner, { conversation_id: 'archer', enabled: false });
    expect(status(() => bots.openQuestions(as('archer')))).toBe(403);
  });

  it('omits a question whose evidence the owner cannot reach, and flags evidence access', () => {
    decision('hidden-evidence', 'sage', 1, { evidence: [{ label: 'Other owner chat', conversation_id: 'foreign' }] });
    decision('with-evidence', 'sage', 1, { evidence: [{ label: 'Order thread', conversation_id: 'sage' }] });
    const questions = bots.openQuestions(as('archer')).questions;
    expect(questions.some((q) => q.decision_id === 'hidden-evidence')).toBe(false);
    expect(questions.find((q) => q.decision_id === 'with-evidence')!.evidence).toEqual([{ label: 'Order thread', conversation_id: 'sage', source_access: true }]);
  });

  it('gives no way to answer or withdraw another bot’s question', () => {
    expect(status(() => bots.withdraw(as('archer'), 'ervp-q', 1, 'k', { reason: 'r', evidence: 'e' }))).toBe(403);
    expect(status(() => bots.answerCustom(as('archer'), 'ervp-q', 1, 'k', 'Refund it'))).toBe(403);
    expect(db.prepare("SELECT state,version FROM bot_decisions WHERE id='ervp-q'").get()).toEqual({ state: 'needs_input', version: 1 });
  });
});
