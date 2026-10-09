import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { createBotService, proposalSchema } from '../src/bots/service.js';
import { botCalls, tickBotCalls, RETRY_MS } from '../src/bots/botCalls.js';
import {
  businessDay, businessMsBetween, defaultEscalationAdapters, escalateStaleDecisions, escalationEnabled,
  type EscalationAdapters,
} from '../src/bots/decisionEscalation.js';
import type { UserRow } from '../src/db/db.js';
import type { AppContext } from '../src/context.js';

const H = 3600_000;
const at = (iso: string) => Date.parse(iso);
/** SQLite datetime('now') form, in UTC. */
const sql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

describe('business hours', () => {
  it('counts only Mon-Fri 08:00-18:00 New York time', () => {
    // 2026-10-05 is a Monday; New York is UTC-4 in October.
    expect(businessMsBetween(at('2026-10-05T13:00:00Z'), at('2026-10-05T17:00:00Z'))).toBe(4 * H);
    // Crossing a night: Mon 15:00 -> Tue 11:00 is 3h + 3h.
    expect(businessMsBetween(at('2026-10-05T19:00:00Z'), at('2026-10-06T15:00:00Z'))).toBe(6 * H);
    // After hours only: Mon 19:00 -> Tue 07:00.
    expect(businessMsBetween(at('2026-10-05T23:00:00Z'), at('2026-10-06T11:00:00Z'))).toBe(0);
    // Across a weekend: Fri 16:00 -> Mon 10:00 is 2h + 2h.
    expect(businessMsBetween(at('2026-10-02T20:00:00Z'), at('2026-10-05T14:00:00Z'))).toBe(4 * H);
    // Weekend only.
    expect(businessMsBetween(at('2026-10-03T14:00:00Z'), at('2026-10-04T20:00:00Z'))).toBe(0);
    // Raised before opening counts from 08:00.
    expect(businessMsBetween(at('2026-10-05T10:00:00Z'), at('2026-10-05T13:30:00Z'))).toBe(1.5 * H);
    // Across the November DST change: Fri 17:00 EDT -> Mon 09:00 EST is 1h + 1h.
    expect(businessMsBetween(at('2026-10-30T21:00:00Z'), at('2026-11-02T14:00:00Z'))).toBe(2 * H);
    expect(businessMsBetween(at('2026-10-06T00:00:00Z'), at('2026-10-05T00:00:00Z'))).toBe(0);
  });
  it('names the business day only inside business hours', () => {
    expect(businessDay(at('2026-10-05T12:00:00Z'))).toBe('2026-10-05'); // Mon 08:00
    expect(businessDay(at('2026-10-05T11:59:00Z'))).toBeNull(); // Mon 07:59
    expect(businessDay(at('2026-10-05T21:59:00Z'))).toBe('2026-10-05'); // Mon 17:59
    expect(businessDay(at('2026-10-05T22:00:00Z'))).toBeNull(); // Mon 18:00
    expect(businessDay(at('2026-10-03T16:00:00Z'))).toBeNull(); // Saturday
    // 21:30 New York on Monday is already Tuesday in UTC, and after hours.
    expect(businessDay(at('2026-10-06T01:30:00Z'))).toBeNull();
    expect(businessDay(at('2026-11-02T14:00:00Z'))).toBe('2026-11-02'); // Mon 09:00 EST
  });
  it('is switched on unless the flag turns it off', () => {
    expect(escalationEnabled({})).toBe(true);
    expect(escalationEnabled({ VP_DECISION_ESCALATION: '1' })).toBe(true);
    for (const off of ['0', 'false', 'OFF', ' no ']) expect(escalationEnabled({ VP_DECISION_ESCALATION: off })).toBe(false);
  });
});

describe('stale question escalation', () => {
  let db: Database.Database; let ctx: AppContext; let seq = 0;
  let calls: { kind: 'notify' | 'ring'; userId: number; decisionId: string; key?: string }[];
  let lines: string[];
  const spy: EscalationAdapters = {
    notify: (user, card, key) => { calls.push({ kind: 'notify', userId: user.id, decisionId: card.id, key }); return 1; },
    ring: (user, card) => { calls.push({ kind: 'ring', userId: user.id, decisionId: card.id }); return 'rearmed'; },
  };
  const run = (iso: string, adapters = spy) => escalateStaleDecisions(ctx, at(iso), adapters, l => lines.push(l)).map(e => e.decisionId);
  const proposal = (assignee: number) => JSON.stringify(proposalSchema.parse({
    question: 'Should we refund Jane Customer for order #1234?', recommendation: 'Refund the shipping.', consequence: 'Internal test only.',
    assignee_id: assignee, blocked_action: 'Internal fixture',
  }));
  /** A card whose current version was raised at `raisedIso`, inserted directly so the clock is ours. */
  const card = (raisedIso: string, o: { assignee?: number; state?: string; parked?: boolean; stale?: boolean; conversation?: string } = {}) => {
    const id = `card-${++seq}`; const raised = sql(at(raisedIso));
    db.prepare('INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,state,proposal_json,assignee_id,parked_json,stale_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, o.conversation ?? 'a', id, id, o.state ?? 'needs_input', proposal(o.assignee ?? 2), o.assignee ?? 2, o.parked ? '{"released_leases":[],"evidence":"x"}' : null,
        o.stale ? '{"since":"x","detail":"y"}' : null, raised, raised);
    event(id, 1, 'raised', raised);
    return id;
  };
  const event = (id: string, version: number, kind: string, created: string) =>
    db.prepare("INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,actor_conversation_id,payload_json,request_key,created_at) VALUES(?,?,?,?,1,'a','{}',?,?)")
      .run(`${id}-${kind}-${version}-${++seq}`, id, version, kind, `${kind}-${seq}`, created);

  beforeEach(() => {
    calls = []; lines = [];
    db = new Database(':memory:'); db.pragma('foreign_keys=ON');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.test','Owner','owner'),(2,'staff@example.test','Staff','member'),(3,'other@example.test','Other','member')").run();
    const owner = db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
    const service = createBotService(db);
    for (const bot of ['a', 'b']) {
      db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'claude',?,'private')").run(bot, bot, bot);
      service.register({ user: owner }, bot, `Bot ${bot}`, true);
    }
    ctx = { db, doppler: { get: () => null }, liveVoice: { status: () => null, start: async () => ({}) } } as unknown as AppContext;
  });
  afterEach(() => { vi.useRealTimers(); db.close(); });

  it('escalates only waiting questions, never parked, stale, blocked, decided or answered ones', () => {
    const waiting = card('2026-10-05T12:00:00Z');
    card('2026-10-05T12:00:00Z', { parked: true });
    card('2026-10-05T12:00:00Z', { stale: true });
    for (const state of ['decided', 'blocked', 'action_pending', 'running', 'verified_completed', 'failed']) card('2026-10-05T12:00:00Z', { state });
    const answered = card('2026-10-05T12:00:00Z');
    event(answered, 1, 'answered', sql(at('2026-10-05T13:00:00Z')));
    expect(run('2026-10-05T17:30:00Z')).toEqual([waiting]);
  });

  it('waits more than four business hours, counting from the current version', () => {
    const id = card('2026-10-05T12:00:00Z'); // Mon 08:00
    expect(run('2026-10-05T16:00:00Z')).toEqual([]); // exactly 4h
    expect(run('2026-10-05T16:01:00Z')).toEqual([id]);
    // A revised version restarts the clock from its revision.
    const revised = card('2026-10-06T12:00:00Z');
    db.prepare("UPDATE bot_decisions SET version=2,updated_at=? WHERE id=?").run(sql(at('2026-10-07T12:00:00Z')), revised);
    event(revised, 2, 'revised', sql(at('2026-10-07T12:00:00Z'))); // Wed 08:00
    expect(run('2026-10-07T15:00:00Z')).not.toContain(revised); // only 3h on version 2
    expect(run('2026-10-07T16:30:00Z')).toContain(revised);
    expect(db.prepare('SELECT decision_version FROM bot_decision_escalations WHERE decision_id=?').all(revised)).toEqual([{ decision_version: 2 }]);
  });

  it('skips weekends and after-hours time and only fires inside business hours', () => {
    const id = card('2026-10-02T19:00:00Z'); // Fri 15:00
    expect(run('2026-10-02T21:59:00Z')).toEqual([]); // Fri 17:59, 2h59m
    expect(run('2026-10-03T16:00:00Z')).toEqual([]); // Saturday
    expect(run('2026-10-05T11:00:00Z')).toEqual([]); // Mon 07:00, before opening
    expect(run('2026-10-05T13:00:00Z')).toEqual([]); // Mon 09:00, exactly 4h
    expect(run('2026-10-05T13:01:00Z')).toEqual([id]);
  });

  it('escalates at most once per business day, again the next business day, and never once answered', () => {
    const id = card('2026-10-05T12:00:00Z');
    expect(run('2026-10-05T17:00:00Z')).toEqual([id]);
    expect(run('2026-10-05T19:00:00Z')).toEqual([]); // same day
    expect(run('2026-10-05T21:59:00Z')).toEqual([]);
    expect(run('2026-10-06T01:00:00Z')).toEqual([]); // Mon 21:00, after hours
    expect(run('2026-10-06T12:00:00Z')).toEqual([id]); // Tue 08:00
    expect(run('2026-10-06T12:05:00Z')).toEqual([]);
    expect(db.prepare('SELECT business_day FROM bot_decision_escalations WHERE decision_id=? ORDER BY business_day').all(id))
      .toEqual([{ business_day: '2026-10-05' }, { business_day: '2026-10-06' }]);
    db.prepare("UPDATE bot_decisions SET state='decided' WHERE id=?").run(id);
    event(id, 1, 'answered', sql(at('2026-10-06T13:00:00Z')));
    expect(run('2026-10-07T15:00:00Z')).toEqual([]);
    expect(() => db.prepare("INSERT INTO bot_decision_escalations(id,decision_id,decision_version,business_day,waiting_since,business_minutes,recipients_json) VALUES('x',?,1,'2026-10-06','x',0,'[]')").run(id)).toThrow(/UNIQUE/);
  });

  it('notifies and re-rings the assignee and the owner once each, and logs no question text', () => {
    const forStaff = card('2026-10-05T12:00:00Z', { assignee: 2 });
    run('2026-10-05T17:00:00Z');
    expect(calls).toEqual([
      { kind: 'notify', userId: 2, decisionId: forStaff, key: `escalation:${forStaff}:1:2026-10-05` },
      { kind: 'ring', userId: 2, decisionId: forStaff },
      { kind: 'notify', userId: 1, decisionId: forStaff, key: `escalation:${forStaff}:1:2026-10-05` },
      { kind: 'ring', userId: 1, decisionId: forStaff },
    ]);
    // The owner as assignee is one recipient with both roles.
    calls = [];
    const forOwner = card('2026-10-06T12:00:00Z', { assignee: 1 });
    run('2026-10-06T17:00:00Z');
    expect(calls.filter(c => c.decisionId === forOwner).map(c => [c.kind, c.userId])).toEqual([['notify', 1], ['ring', 1]]);
    expect(JSON.parse((db.prepare('SELECT outcome_json FROM bot_decision_escalations WHERE decision_id=?').get(forOwner) as { outcome_json: string }).outcome_json))
      .toEqual([{ user_id: 1, roles: ['assignee', 'owner'], pushes: 1, ring: 'rearmed' }]);
    expect(lines.some(l => l.includes(`decision=${forStaff}`) && l.includes('2:assignee') && l.includes('1:owner'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/Jane|refund|#1234/i);
    // An inactive assignee is skipped; the owner is still reached.
    db.prepare("UPDATE users SET status='disabled' WHERE id=2").run();
    calls = [];
    const orphan = card('2026-10-07T12:00:00Z', { assignee: 2 });
    run('2026-10-07T17:00:00Z');
    expect(calls.filter(c => c.decisionId === orphan).map(c => c.userId)).toEqual([1, 1]);
  });

  it('a failing adapter still records the escalation once', () => {
    const id = card('2026-10-05T12:00:00Z');
    const broken: EscalationAdapters = { notify: () => { throw new Error('x'); }, ring: () => { throw new Error('y'); } };
    expect(run('2026-10-05T17:00:00Z', broken)).toEqual([id]);
    expect(run('2026-10-05T17:30:00Z', broken)).toEqual([]);
    expect((db.prepare('SELECT outcome_json FROM bot_decision_escalations').get() as { outcome_json: string }).outcome_json).toContain('"ring":"error"');
  });

  describe('through the existing push outbox and call rings', () => {
    const NOW = '2026-10-05T17:00:00Z'; // Mon 13:00 New York, inside default calling hours
    beforeEach(() => {
      vi.useFakeTimers(); vi.setSystemTime(at(NOW));
      for (const [id, user] of [['d1', 1], ['d3', 3]] as const) {
        db.prepare("INSERT INTO bot_push_devices(id,user_id,endpoint_hash,created_at) VALUES(?,?,?,'2026-01-01 00:00:00')").run(id, user, `hash-${id}`);
        db.prepare("INSERT INTO bot_notification_preferences(user_id,conversation_id,created_at) VALUES(?,'a','2026-01-01 00:00:00')").run(user);
      }
    });
    const settings = (user: number) => db.prepare('SELECT * FROM users WHERE id=?').get(user) as UserRow;

    it('queues the usual input push only for recipients whose notifications are on', () => {
      const id = card('2026-10-05T12:00:00Z', { assignee: 1 });
      run(NOW, defaultEscalationAdapters(ctx));
      expect(db.prepare('SELECT device_id,kind,href,event_key FROM bot_notification_outbox').all())
        .toEqual([{ device_id: 'd1', kind: 'input', href: `#/bots/${id}`, event_key: `escalation:${id}:1:2026-10-05` }]);
      // Turning input notifications off for that bot is honored.
      db.prepare("UPDATE bot_notification_preferences SET input=0 WHERE user_id=1").run();
      const quiet = card('2026-10-05T12:00:00Z', { assignee: 1 });
      run(NOW, defaultEscalationAdapters(ctx));
      expect(db.prepare('SELECT count(*) AS n FROM bot_notification_outbox WHERE href=?').get(`#/bots/${quiet}`)).toEqual({ n: 0 });
    });

    it('makes a waiting re-ring due now, and leaves every call setting in charge', () => {
      const id = card('2026-10-05T12:00:00Z', { assignee: 1 });
      const owner = settings(1);
      // Calls not turned on for this bot: nothing is armed.
      run(NOW, defaultEscalationAdapters(ctx));
      expect(JSON.parse((db.prepare('SELECT outcome_json FROM bot_decision_escalations WHERE decision_id=?').get(id) as { outcome_json: string }).outcome_json)[0].ring).toBe('calls_off');
      expect(db.prepare('SELECT count(*) AS n FROM bot_call_rings').get()).toEqual({ n: 0 });

      botCalls(ctx, owner).update({ bot: { conversationId: 'a', enabled: true } });
      const later = at(NOW) + RETRY_MS;
      db.prepare("INSERT INTO bot_call_rings(user_id,decision_id,state,attempts,next_attempt_ms) VALUES(1,?,'missed',3,?)").run(id, later);
      expect(botCalls(ctx, owner).rearm(id, at(NOW))).toBe('rearmed');
      expect(db.prepare('SELECT next_attempt_ms FROM bot_call_rings WHERE decision_id=?').get(id)).toEqual({ next_attempt_ms: at(NOW) });
      // Do not disturb still wins: the due ring does not ring.
      botCalls(ctx, owner).update({ dnd: true });
      expect(tickBotCalls(ctx, at(NOW)).pushes).toEqual([]);
      expect(db.prepare('SELECT state FROM bot_call_rings WHERE decision_id=?').get(id)).toEqual({ state: 'missed' });
      botCalls(ctx, owner).update({ dnd: false });
      expect(tickBotCalls(ctx, at(NOW)).pushes.map(p => p.ring.decisionId)).toEqual([id]);
      // "Never ring this again" stays stopped.
      botCalls(ctx, owner).stop(id);
      expect(botCalls(ctx, owner).rearm(id, at(NOW))).toBe('stopped');
      // A card this person cannot answer is never rung for them.
      const forStaff = card('2026-10-05T12:00:00Z', { assignee: 2 });
      expect(botCalls(ctx, owner).rearm(forStaff, at(NOW))).toBe('not_answerable');
    });

    it('escalation pass re-arms the ring for the next call poll', () => {
      const id = card('2026-10-05T12:00:00Z', { assignee: 1 });
      const owner = settings(1);
      botCalls(ctx, owner).update({ bot: { conversationId: 'a', enabled: true } });
      db.prepare("INSERT INTO bot_call_rings(user_id,decision_id,state,attempts,next_attempt_ms) VALUES(1,?,'missed',3,?)").run(id, at(NOW) + RETRY_MS);
      run(NOW, defaultEscalationAdapters(ctx));
      expect(db.prepare('SELECT rings_rearmed,notifications_queued FROM bot_decision_escalations WHERE decision_id=?').get(id)).toEqual({ rings_rearmed: 1, notifications_queued: 1 });
      expect(tickBotCalls(ctx, at(NOW)).pushes.map(p => p.ring.decisionId)).toEqual([id]);
    });
  });
});
