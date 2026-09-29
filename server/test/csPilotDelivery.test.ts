import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { communicationService, draftPayload } from '../src/bots/communication.js';
import type { Actor } from '../src/bots/service.js';
import { saveRoutine, acceptEvent } from '../src/botWorkflows/routines.js';
import type { UserRow } from '../src/db/db.js';

// Controlled delivery checks for the approved customer reply. The provider is
// synthetic: `provider` stands for the one real send the executor may perform.
describe('customer service pilot delivery', () => {
  let db: Database.Database, human: Actor, bot: Actor, provider: string[];
  const messages = () => communicationService(db);
  const payload = draftPayload.parse({
    channel: 'email', account: 'Fixture Parts support', recipients: ['customer@fixture-mail.test'],
    subject: 'Your order F-1001', body: 'Please reply with a clear photo of the product label.',
    customer: 'Fixture Customer', ticket: 'fixture-ticket',
  });
  function authorized(key = 'draft') {
    const draft = messages().saveDraft(bot, '00000000-0000-4000-8000-000000000001', key, payload);
    messages().mutateDraft(human, draft.id, draft.version, 'send');
    return draft.id;
  }
  function send(id: string, key: string) {
    const claim = messages().claim(bot, id, key);
    if (claim.execute) provider.push(claim.idempotency_key);
    return claim;
  }
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys=ON');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@fixture.test','Owner','owner')").run();
    db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Fixture',1)").run();
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES('00000000-0000-4000-8000-000000000001',1,1,'Fixture','claude','fixture','team','team')").run();
    human = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow };
    bot = { ...human, conversationId: '00000000-0000-4000-8000-000000000001' };
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('00000000-0000-4000-8000-000000000001','Fixture',1)").run();
    db.prepare("INSERT INTO business_bot_members(conversation_id,team_id,role) VALUES('00000000-0000-4000-8000-000000000001','team','bot')").run();
    db.prepare("INSERT INTO bot_event_sources(id,team_id,created_by,name) VALUES('source','team',1,'Fixture source')").run();
    provider = [];
  });
  afterEach(() => db.close());

  it('wakes the owner once for a duplicate inbound event', () => {
    saveRoutine(db, human.user, '00000000-0000-4000-8000-000000000001', { name: 'Intake', instructions: 'Read the ticket within existing authority.', kind: 'customer.replied', source: 'source', enabled: true });
    const event = { id: 'evt-1', type: 'customer.replied', ticket_id: 'fixture-ticket', occurred_at: '2026-09-29T12:00:00Z', assigned_bot: '00000000-0000-4000-8000-000000000001' };
    expect(acceptEvent(db, 'source', event)).toBe(1);
    expect(acceptEvent(db, 'source', event)).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM conversation_wakeups').get()).toEqual({ n: 1 });
  });
  it('keeps one draft for a repeated save and refuses different text under the same key', () => {
    const first = messages().saveDraft(bot, '00000000-0000-4000-8000-000000000001', 'draft', payload);
    expect(messages().saveDraft(bot, '00000000-0000-4000-8000-000000000001', 'draft', payload).id).toBe(first.id);
    expect(() => messages().saveDraft(bot, '00000000-0000-4000-8000-000000000001', 'draft', { ...payload, body: 'Different text.' })).toThrow('different draft');
    expect(db.prepare('SELECT count(*) n FROM bot_message_drafts').get()).toEqual({ n: 1 });
  });
  it('sends nothing without a human authorization', () => {
    const draft = messages().saveDraft(bot, '00000000-0000-4000-8000-000000000001', 'draft', payload);
    expect(() => send(draft.id, 'claim')).toThrow();
    expect(provider).toEqual([]);
  });
  it('locks the approved text: an edit after approval is refused and the approved message is what sends', () => {
    const id = authorized();
    const current = messages().readDraft(human, id);
    expect(() => messages().mutateDraft(human, id, current.version, 'save', { ...payload, body: 'Different text.' })).toThrow('already queued');
    const claim = send(id, 'claim');
    expect(claim.execute).toBe(true);
    expect(claim.payload.body).toBe(payload.body);
    expect(provider).toHaveLength(1);
  });
  it('never sends again after a timeout that followed provider acceptance', () => {
    const id = authorized();
    expect(send(id, 'claim').execute).toBe(true);
    messages().receipt(bot, id, 'claim', 'uncertain', 'Request timed out after submission; reconciliation required.');
    expect(() => send(id, 'second')).toThrow('do not resend');
    expect(messages().receipt(bot, id, 'claim', 'sent', 'Provider receipt fixture-1').state).toBe('sent');
    expect(() => send(id, 'third')).toThrow('do not resend');
    expect(provider).toEqual([`veneer-message:${id}`]);
  });
  it('does not repeat the send when the executor restarts after claiming', () => {
    const id = authorized();
    expect(send(id, 'claim').execute).toBe(true);
    // A restarted executor holds no memory of the claim; only the record decides.
    const replay = send(id, 'claim');
    expect(replay).toMatchObject({ execute: false, idempotency_key: `veneer-message:${id}` });
    expect(() => send(id, 'new-key-after-restart')).toThrow('do not resend');
    expect(provider).toHaveLength(1);
    expect(messages().readDraft(human, id).state).toBe('sending');
  });
  it('records a receipt only from the claiming bot and closes the delivery', () => {
    const id = authorized();
    send(id, 'claim');
    expect(() => messages().receipt(bot, id, 'other-key', 'sent', 'Provider receipt fixture-1')).toThrow('claiming bot');
    expect(() => messages().receipt(human, id, 'claim', 'sent', 'Provider receipt fixture-1')).toThrow('claiming bot');
    messages().receipt(bot, id, 'claim', 'sent', 'Provider receipt fixture-1');
    expect(() => messages().receipt(bot, id, 'claim', 'failed', 'Changed outcome')).toThrow('closed');
  });
});
