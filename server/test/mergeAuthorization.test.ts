import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createBotService, proposalSchema, type Actor } from '../src/bots/service.js';
import { mergeAuthorization, type MergeIO } from '../src/bots/mergeAuthorization.js';
import { mergeAuthorizationServiceRoutes } from '../src/bots/mergeAuthorizationRoutes.js';
import { candidateHashOf, commitHashOf, eventHashOf, evidenceRevisionOf, intentHashFor, intentBaseHash, registrationSchema, MERGE_CONTRACT_HASH, type Registration } from '../src/bots/mergeAuthorizationContract.js';
import { acceptEventDetailed, saveRoutine } from '../src/botWorkflows/routines.js';
import { createBotsRouter } from '../src/bots/routes.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';

const uid = () => crypto.randomUUID(), H = (c: string) => c.repeat(64), origin = 'https://orderops-dev-web-production.up.railway.app';
const bearer = crypto.randomBytes(32).toString('base64url');

describe('merge authorization contract (build 498)', () => {
  let db: Database.Database, s: ReturnType<typeof mergeAuthorization>, bots: ReturnType<typeof createBotService>, reg: Registration, io: MergeIO, now: number;
  let owner: Actor, executor: Actor, readback: unknown;
  const business = uid(), executorId = uid(), reviewerId = uid(), source = 'orderops';
  const caseA = uid(), caseB = uid(), caseC = uid();
  const servers: Server[] = [];
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys=ON');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    now = Date.parse('2026-09-30T16:00:00Z');
    db.prepare("INSERT INTO users(id,email,display_name,role,status) VALUES(1,'owner@test','Owner','owner','active')").run();
    db.prepare('INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,1)').run(business, 'ERVP');
    for (const id of [reviewerId, executorId]) {
      db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,'Bot','claude',?,'team',?)").run(id, id, business);
      db.prepare('INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,1)').run(id, id);
      db.prepare("INSERT INTO business_bot_members(conversation_id,team_id,role) VALUES(?,?,'bot')").run(id, business);
    }
    db.prepare("INSERT INTO bot_event_sources(id,team_id,created_by,name) VALUES(?,?,1,'OrderOps')").run(source, business);
    owner = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow }; executor = { ...owner, conversationId: executorId };
    reg = registrationSchema.parse({ schemaVersion: 'merge-authorization-registration/v1', id: uid(), revision: 1, active: true, businessId: business, ownerUserId: 1, sourceOrigin: origin, sourceId: source,
      runtime: { projectId: uid(), environmentId: uid(), serviceId: uid() }, reviewerConversationId: reviewerId, executorConversationId: executorId, executorPrincipalId: 'ervp:avery', servicePrincipalId: 'orderops:merge',
      audience: 'merge-aud', cfClientId: 'merge-client', bearerHash: crypto.createHash('sha256').update(bearer).digest('hex'), readbackCredential: { project: 'orderops', config: 'prd', name: 'MERGE_AUTHORIZATION_READBACK' },
      contractHash: MERGE_CONTRACT_HASH, expiresAt: '2026-12-31T00:00:00Z' });
    readback = null;
    io = { registration: () => structuredClone(reg), registrations: () => [structuredClone(reg)], attemptReadback: async () => structuredClone(readback), now: () => now };
    s = mergeAuthorization(db, io); bots = createBotService(db);
    s.enroll(owner, reg.id);
  });
  afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(r => server.close(() => r())); db.close(); });

  const tuples = (extra: { ticket: string; caseId: string; rev?: string }[] = []) => s.registerCases(reg.id, { cases: [{ ticket: 'T-A', caseId: caseA, materialRevision: H('a'), observedAt: new Date(now).toISOString() }, { ticket: 'T-B', caseId: caseB, materialRevision: H('b'), observedAt: new Date(now).toISOString() }] }) && extra.length && s.registerCases(reg.id, { cases: extra.map(e => ({ ticket: e.ticket, caseId: e.caseId, materialRevision: e.rev ?? H('c'), observedAt: new Date(now).toISOString() })) });
  const intentBody = (pair: string, overrides: Record<string, unknown> = {}) => ({ schemaVersion: 'orderops-merge-intent/v1', pairReceiptId: pair, executorConversationId: executorId, cases: { a: { ticket: 'T-A', caseId: caseA, materialRevision: H('a') }, b: { ticket: 'T-B', caseId: caseB, materialRevision: H('b') } }, offeredDirections: ['a_into_b', 'b_into_a'], action: 'merge_retain_source', requestKey: uid(), ...overrides });
  function hashFor(pair: string, revision: number, direction: 'a_into_b' | 'b_into_a', body = intentBody(pair)) {
    const i = { ...body, requestKey: uid() } as Parameters<typeof intentHashFor>[2];
    return intentHashFor(source, business, i, revision, intentBaseHash(source, business, i, revision), direction);
  }
  const proposal = (extra: Record<string, unknown>) => proposalSchema.parse({ question: 'Merge T-A into T-B?', recommendation: 'Same customer, same order.', consequence: 'Source ticket is retained.', blocked_action: 'OrderOps merges after redemption', assignee_id: 1, ...extra });
  function raiseMerge(pair: string, revision = 1, direction: 'a_into_b' | 'b_into_a' = 'a_into_b', hash = hashFor(pair, revision, direction)) {
    const binding = s.prepareBinding({ pairReceiptId: pair, intentRevision: revision, direction }, executorId, [{ action: 'approve', answer: hash }, { action: 'reject' }]);
    const d = bots.raise(executor, { source_key: pair, proposal_key: `merge-${revision}-${direction}`, proposal: proposal({ merge_intent: { pairReceiptId: pair, intentRevision: revision, direction }, choices: [{ id: 'merge', label: 'Merge T-A into T-B', description: 'Retains T-A as source', action: 'approve', answer: hash }, { id: 'keep', label: 'Keep separate', description: 'No merge', action: 'reject' }], as_of: { captured_at: new Date(now).toISOString(), ticket_id: 'T-B', last_inbound: [], related_ticket_ids: [{ ticket_id: 'T-A' }] } }) });
    s.recordBinding(d.id, d.version, binding);
    return { decision: d, hash };
  }
  function approve(id: string, version = 1) { return bots.choose(owner, id, version, `approve-${id}-${version}`, 'merge', '', 'this_case'); }
  function setupApproved(pair = uid()) { tuples(); s.registerIntent(reg.id, intentBody(pair)); const { decision, hash } = raiseMerge(pair); approve(decision.id); return { pair, decision, hash }; }
  function reserve(pair: string, hash: string, key = uid()) { return s.reserve(reg.id, { pairReceiptId: pair, intentHash: hash, requestKey: key }); }
  const mergedEvent = (pair: string, res: { reservationId: string; generation: number; intentHash: string }, redemptionId: string, attemptId: string, overrides: Record<string, unknown> = {}, commitOverrides: Record<string, unknown> = {}) => {
    const commit = { schemaVersion: 'orderops-merge-commit/v1', pairReceiptId: pair, generation: res.generation, reservationId: res.reservationId, redemptionId, attemptId, intentHash: res.intentHash, preconditions: { fromMaterialRevision: H('a'), intoMaterialRevision: H('b') }, result: { fromMaterialRevision: H('a'), intoMaterialRevision: H('e'), sourceRetained: true, sourceCommitId: 'oo-commit-1' }, ...commitOverrides } as Parameters<typeof commitHashOf>[0];
    return { id: `merge:${pair}:${res.generation}`, type: 'ticket.merged', occurred_at: new Date(now + 1000).toISOString(), ticket_id: 'T-B', assigned_bot: executorId, commit: { ...commit, commitHash: commitHashOf(commit) }, ...overrides };
  };
  const stub = (): MergeIO => ({ registration: (id) => io.registration(id), attemptReadback: (r, a) => io.attemptReadback(r, a), now: () => now });

  it('registers tuples idempotently and refuses conflicting mappings', () => {
    tuples();
    expect(s.registerCases(reg.id, { cases: [{ ticket: 'T-A', caseId: caseA, materialRevision: H('9'), observedAt: new Date(now + 5).toISOString() }] }).cases[0]).toMatchObject({ lastMaterialRevision: H('9') });
    expect(() => s.registerCases(reg.id, { cases: [{ ticket: 'T-A', caseId: caseC, materialRevision: H('a'), observedAt: new Date(now).toISOString() }] })).toThrow('TUPLE_CONFLICT');
    expect(() => s.registerCases(reg.id, { cases: [{ ticket: 'T-X', caseId: caseA, materialRevision: H('a'), observedAt: new Date(now).toISOString() }] })).toThrow('TUPLE_CONFLICT');
  });

  it('allocates one pair per unordered case pair with immutable revisions and request-key idempotency', () => {
    tuples();
    const pair = uid(), body = intentBody(pair);
    const first = s.registerIntent(reg.id, body);
    expect(first).toMatchObject({ intentRevision: 1, state: 'open', execute: false });
    expect(s.registerIntent(reg.id, body).intentRevision).toBe(1);
    expect(() => s.registerIntent(reg.id, { ...body, offeredDirections: ['a_into_b'] })).toThrow('IDEMPOTENCY_CONFLICT');
    // Same material with a new key: no new revision. Changed material: revision 2, revision 1 untouched.
    expect(s.registerIntent(reg.id, { ...body, requestKey: uid() }).intentRevision).toBe(1);
    expect(s.registerIntent(reg.id, { ...body, requestKey: uid(), offeredDirections: ['a_into_b'] }).intentRevision).toBe(2);
    expect(() => db.prepare('DELETE FROM merge_intent_revisions').run()).toThrow('Immutable');
    const swapped = intentBody(uid(), { cases: { a: body.cases.b, b: body.cases.a } });
    expect(() => s.registerIntent(reg.id, swapped)).toThrow(`PAIR_EXISTS:${pair}`);
    expect(() => s.registerIntent(reg.id, intentBody(uid(), { cases: { a: body.cases.a, b: { ticket: 'T-C', caseId: caseC, materialRevision: H('c') } } }))).toThrow('UNKNOWN_CASE');
    expect(() => s.registerIntent(reg.id, intentBody(uid(), { cases: { a: body.cases.a, b: body.cases.a } }))).toThrow('SAME_CASE');
    const read = s.readIntentFor(reg.id, pair);
    expect(read.revisions).toHaveLength(2);
    expect(read.revisions[0].intentHashes.a_into_b).toBe(hashFor(pair, 1, 'a_into_b'));
  });

  it('binds one merge question per pair whose approve answer is the intentHash', () => {
    tuples(); const pair = uid(); s.registerIntent(reg.id, intentBody(pair));
    expect(() => s.prepareBinding({ pairReceiptId: pair, intentRevision: 1, direction: 'a_into_b' }, executorId, [{ action: 'approve', answer: 'wrong' }])).toThrow('must equal the intentHash');
    expect(() => s.prepareBinding({ pairReceiptId: pair, intentRevision: 1, direction: 'a_into_b' }, reviewerId, [{ action: 'approve', answer: hashFor(pair, 1, 'a_into_b') }])).toThrow('executor');
    expect(() => s.prepareBinding({ pairReceiptId: pair, intentRevision: 2, direction: 'a_into_b' }, executorId, [])).toThrow('Unknown intent revision');
    const { decision } = raiseMerge(pair);
    expect(() => s.prepareBinding({ pairReceiptId: pair, intentRevision: 1, direction: 'b_into_a' }, executorId, [{ action: 'approve', answer: hashFor(pair, 1, 'b_into_a') }])).toThrow(`MERGE_QUESTION_OPEN:${decision.id}`);
    // The owning bot may revise the same decision to the other direction.
    expect(s.prepareBinding({ pairReceiptId: pair, intentRevision: 1, direction: 'b_into_a' }, executorId, [{ action: 'approve', answer: hashFor(pair, 1, 'b_into_a') }], decision.id).direction).toBe('b_into_a');
    expect(s.readIntentFor(reg.id, pair).bindings[0]).toMatchObject({ decisionId: decision.id, state: 'open' });
    expect(() => s.exportApproval(reg.id, decision.id, 1)).not.toThrow();
    expect(s.exportApproval(reg.id, decision.id, 1)).toMatchObject({ execute: false, state: 'open', answerEventId: null });
  });

  it('issues, redeems once, replays without a grant, and refuses redemption after edits, staleness, expiry or revocation', () => {
    const { pair, decision, hash } = setupApproved();
    expect(s.exportApproval(reg.id, decision.id, 1)).toMatchObject({ state: 'approved', currentVersion: 1 });
    const key = uid(), res = reserve(pair, hash, key);
    expect(res).toMatchObject({ execute: false, state: 'issued', generation: 1, replay: false });
    expect(reserve(pair, hash, key)).toMatchObject({ reservationId: res.reservationId, replay: true, execute: false });
    expect(() => reserve(pair, hash)).toThrow(`CASE_PENDING:${pair}`);
    const redeemKey = uid(), attempt = uid();
    expect(() => s.redeem(reg.id, res.reservationId, { requestKey: redeemKey, attemptId: uid() })).not.toThrow();
    const r1 = s.readReservation(reg.id, res.reservationId);
    expect(r1).toMatchObject({ state: 'redeemed', execute: false });
    // Replay of the same redeem key is a readback; a different key on a redeemed reservation is refused.
    expect(s.redeem(reg.id, res.reservationId, { requestKey: redeemKey, attemptId: attempt })).toMatchObject({ execute: false, replay: true, state: 'redeemed' });
    expect(() => s.redeem(reg.id, res.reservationId, { requestKey: uid(), attemptId: attempt })).toThrow('RESERVATION_REDEEMED');
    expect(s.readByRequestKey(reg.id, key)).toMatchObject({ reservationId: res.reservationId, execute: false });
    expect(s.readByRequestKey(reg.id, redeemKey)).toMatchObject({ reservationId: res.reservationId, execute: false });
    expect(() => s.readByRequestKey(reg.id, uid())).toThrow('No reservation');
    expect(() => s.revoke(owner, res.reservationId, 'too late')).toThrow('ALREADY_REDEEMED');
    expect(() => db.prepare('DELETE FROM merge_reservations').run()).toThrow('Immutable');

    // Second pair: each redeem re-check failure leaves the reservation issued.
    const pair2 = uid(); s.registerCases(reg.id, { cases: [{ ticket: 'T-C', caseId: caseC, materialRevision: H('c'), observedAt: new Date(now).toISOString() }] });
    // Cannot even reserve while A–B is fenced (redeemed, not committed).
    s.registerIntent(reg.id, intentBody(pair2, { cases: { a: { ticket: 'T-B', caseId: caseB, materialRevision: H('b') }, b: { ticket: 'T-C', caseId: caseC, materialRevision: H('c') } } }));
    const hash2 = hashFor(pair2, 1, 'a_into_b', intentBody(pair2, { cases: { a: { ticket: 'T-B', caseId: caseB, materialRevision: H('b') }, b: { ticket: 'T-C', caseId: caseC, materialRevision: H('c') } } }));
    const q2 = raiseMerge(pair2, 1, 'a_into_b', hash2); approve(q2.decision.id);
    expect(() => reserve(pair2, hash2)).toThrow(`CASE_PENDING:${pair}`);
  });

  it('redeem re-checks approval, expiry, revocation and staleness and revocation only prevents unredeemed work', () => {
    const { pair, decision, hash } = setupApproved();
    // Withdrawn between issue and redeem: refused, state unchanged.
    let res = reserve(pair, hash);
    bots.revise(executor, decision.id, 1, 'rev-2', proposal({ merge_intent: { pairReceiptId: pair, intentRevision: 1, direction: 'a_into_b' }, choices: [{ id: 'merge', label: 'Merge T-A into T-B', description: 'x', action: 'approve', answer: hash }, { id: 'keep', label: 'Keep separate', description: 'y', action: 'reject' }] }));
    expect(() => s.redeem(reg.id, res.reservationId, { requestKey: uid(), attemptId: uid() })).toThrow('APPROVAL_NOT_CURRENT:superseded');
    expect(s.readReservation(reg.id, res.reservationId).state).toBe('issued');
    expect(s.revoke(owner, res.reservationId, 'superseded').state).toBe('revoked');
    expect(() => s.redeem(reg.id, res.reservationId, { requestKey: uid(), attemptId: uid() })).toThrow('RESERVATION_REVOKED');
    // Re-approve version 2 with a fresh binding; issued reservation expires unredeemed and frees the fence.
    s.recordBinding(decision.id, 2, { pairReceiptId: pair, intentRevision: 1, direction: 'a_into_b', intentHash: hash });
    approve(decision.id, 2);
    res = reserve(pair, hash);
    now += 16 * 60 * 1000;
    expect(s.readReservation(reg.id, res.reservationId).state).toBe('expired_unredeemed');
    expect(() => s.redeem(reg.id, res.reservationId, { requestKey: uid(), attemptId: uid() })).toThrow('RESERVATION_EXPIRED_UNREDEEMED');
    // A new generation re-checks the approval; expiry after redemption becomes uncertain and keeps the fence.
    const gen2 = reserve(pair, hash);
    expect(gen2.generation).toBe(3);
    s.redeem(reg.id, gen2.reservationId, { requestKey: uid(), attemptId: uid() });
    now += 16 * 60 * 1000;
    expect(s.readReservation(reg.id, gen2.reservationId).state).toBe('redeemed_uncertain');
    expect(() => reserve(pair, hash)).toThrow('CASE_PENDING');
    expect(() => s.redeem(reg.id, gen2.reservationId, { requestKey: uid(), attemptId: uid() })).toThrow('RESERVATION_REDEEMED_UNCERTAIN');
    expect(() => s.revoke(owner, gen2.reservationId, 'late')).toThrow('ALREADY_REDEEMED');
  });

  it('rejects overlapping pairs in both orders and merged-away cases at issue and redeem', () => {
    const { pair: ab, hash: hAB } = setupApproved();
    s.registerCases(reg.id, { cases: [{ ticket: 'T-C', caseId: caseC, materialRevision: H('c'), observedAt: new Date(now).toISOString() }] });
    const bcBody = intentBody(uid(), { cases: { a: { ticket: 'T-B', caseId: caseB, materialRevision: H('b') }, b: { ticket: 'T-C', caseId: caseC, materialRevision: H('c') } } });
    s.registerIntent(reg.id, bcBody); const bc = bcBody.pairReceiptId, hBC = hashFor(bc, 1, 'a_into_b', bcBody);
    const qbc = raiseMerge(bc, 1, 'a_into_b', hBC); approve(qbc.decision.id);
    // B→C reserved first, A→B attempted: CASE_PENDING naming B–C.
    const rbc = reserve(bc, hBC);
    expect(() => reserve(ab, hAB)).toThrow(`CASE_PENDING:${bc}`);
    s.revoke(owner, rbc.reservationId, 'switch order');
    // A→B reserved and redeemed; B→C blocked until A→B commits; after commit B is merged-into (fine) but A is merged away.
    const rab = reserve(ab, hAB);
    expect(() => reserve(bc, hBC)).toThrow(`CASE_PENDING:${ab}`);
    const red = s.redeem(reg.id, rab.reservationId, { requestKey: uid(), attemptId: uid() });
    const attempt = s.readReservation(reg.id, rab.reservationId).attemptId!;
    const accepted = acceptEventDetailed(db, source, mergedEvent(ab, rab, red.redemptionId, attempt), stub());
    expect(accepted.accepted).toMatchObject({ effects: { mergeRecorded: true } });
    // B→C may now proceed (B survives); an A–C pair would be merged-away.
    expect(reserve(bc, hBC).state).toBe('issued');
    const acBody = intentBody(uid(), { cases: { a: { ticket: 'T-A', caseId: caseA, materialRevision: H('a') }, b: { ticket: 'T-C', caseId: caseC, materialRevision: H('c') } } });
    s.registerIntent(reg.id, acBody); const ac = acBody.pairReceiptId, hAC = hashFor(ac, 1, 'a_into_b', acBody);
    const qac = raiseMerge(ac, 1, 'a_into_b', hAC); approve(qac.decision.id);
    expect(() => reserve(ac, hAC)).toThrow(/CASE_PENDING|CASE_MERGED_AWAY/);
  });

  it('accepts ticket.merged only against its redeemed reservation, idempotently by envelope, and stales bound questions across aliases', () => {
    const { pair, decision, hash } = setupApproved();
    const res = reserve(pair, hash);
    // Commit for an unredeemed reservation is rejected.
    expect(() => acceptEventDetailed(db, source, mergedEvent(pair, res, uid(), uid()), stub())).toThrow('NOT_REDEEMED');
    const red = s.redeem(reg.id, res.reservationId, { requestKey: uid(), attemptId: uid() });
    const attempt = s.readReservation(reg.id, res.reservationId).attemptId!;
    const bad = (overrides: Record<string, unknown>, commit: Record<string, unknown> = {}) => () => acceptEventDetailed(db, source, mergedEvent(pair, res, red.redemptionId, attempt, overrides, commit), stub());
    expect(bad({}, { result: { fromMaterialRevision: H('a'), intoMaterialRevision: H('e'), sourceRetained: false, sourceCommitId: 'x' } })).toThrow('SOURCE_NOT_RETAINED');
    expect(bad({ ticket_id: 'T-A' })).toThrow('ENVELOPE_TICKET_MISMATCH');
    expect(bad({ assigned_bot: reviewerId })).toThrow('ENVELOPE_EXECUTOR_MISMATCH');
    expect(bad({}, { preconditions: { fromMaterialRevision: H('a'), intoMaterialRevision: H('9') } })).toThrow('PRECONDITION_MISMATCH');
    expect(bad({}, { redemptionId: uid() })).toThrow('REDEMPTION_MISMATCH');
    expect(bad({ occurred_at: new Date(now - 60000).toISOString() })).toThrow('TIME_ORDER');
    // Another open question on T-A (a refund) goes stale when the merge lands; a routine for ticket.merged is woken.
    const other = bots.raise(executor, { source_key: 'refund', proposal_key: 'x', proposal: proposal({ question: 'Refund T-A?', choices: [{ id: 'a', label: 'Refund $10 after return', description: 'x', action: 'approve' }, { id: 'b', label: 'Replace instead', description: 'y', action: 'approve' }], as_of: { captured_at: new Date(now).toISOString(), ticket_id: 'T-A', last_inbound: [] } }) });
    saveRoutine(db, owner.user, executorId, { name: 'Merged', instructions: 'Re-read both tickets', kind: 'ticket.merged', source, enabled: true });
    const event = mergedEvent(pair, res, red.redemptionId, attempt);
    const first = acceptEventDetailed(db, source, event, stub());
    expect(first).toMatchObject({ queued: 1, accepted: { eventId: event.id, payloadHash: event.commit.commitHash, effects: { mergeRecorded: true, staledDecisions: 1, wakesEnqueued: 1 } } });
    expect((first.accepted as { eventHash: string }).eventHash).toBe(eventHashOf(source, event));
    expect(bots.view(owner, bots.read(owner, other.id)).stale).toMatchObject({ reason: 'ticket_merged' });
    expect(bots.view(owner, bots.read(owner, decision.id)).stale).toBeNull(); // already answered
    expect(s.readReservation(reg.id, res.reservationId).state).toBe('committed');
    expect(s.readIntentFor(reg.id, pair)).toMatchObject({ fence: 'committed', merge: { fromTicket: 'T-A', intoTicket: 'T-B' } });
    // Identical envelope: original receipt, queued 0. Changed outer field with same commitHash: 409. Same pair/generation under another id: 409.
    const replay = acceptEventDetailed(db, source, event, stub());
    expect(replay).toMatchObject({ queued: 0, accepted: first.accepted });
    expect(() => acceptEventDetailed(db, source, { ...event, occurred_at: new Date(now + 2000).toISOString() }, stub())).toThrow('EVENT_CONFLICT');
    expect(() => acceptEventDetailed(db, source, { ...event, id: 'merge:other' }, stub())).toThrow(/DUPLICATE_COMMIT|RESERVATION_COMMITTED/);
    expect(s.receipt(reg.id, event.id)).toMatchObject({ eventHash: eventHashOf(source, event), payloadHash: event.commit.commitHash });
    expect(() => db.prepare('DELETE FROM case_merges').run()).toThrow('Immutable');
    // Alias-aware staling: a later customer reply on the merged-away ticket stales a question bound to the survivor.
    const survivor = bots.raise(executor, { source_key: 'survivor', proposal_key: 'x', proposal: proposal({ question: 'Ship T-B replacement?', choices: [{ id: 'a', label: 'Ship replacement now', description: 'x', action: 'approve' }, { id: 'b', label: 'Wait for photos', description: 'y', action: 'defer' }], as_of: { captured_at: new Date(now).toISOString(), ticket_id: 'T-B', last_inbound: [] } }) });
    expect(bots.markStaleForCase(['T-A'], { reason: 'customer_replied', detail: 'replied', event_id: 'e1' })).toContain(survivor.id);
  });

  it('records duplicate candidates only against a registered intent revision, wakes the assigned bot once, and never reopens on identical evidence', () => {
    tuples(); const pair = uid();
    const reasons = [{ kind: 'order', evidenceHash: H('1'), explanation: 'Same order number' }, { kind: 'email_digest', evidenceHash: H('2'), explanation: 'Same sender digest' }] as const;
    const evidenceRevision = evidenceRevisionOf([...reasons]), candidateId = uid();
    s.registerIntent(reg.id, intentBody(pair, { candidateId, evidenceRevision }));
    saveRoutine(db, owner.user, executorId, { name: 'Dupes', instructions: 'Review the pair', kind: 'ticket.duplicate_candidate', source, enabled: true });
    const candidate = { schemaVersion: 'orderops-duplicate-candidate/v1', candidateId, pairReceiptId: pair, intentRevision: 1, evidenceRevision, reasons: [...reasons], identityClusterVerified: false } as Parameters<typeof candidateHashOf>[0];
    const event = { id: `dup:${candidateId}`, type: 'ticket.duplicate_candidate', occurred_at: new Date(now).toISOString(), ticket_id: 'T-B', assigned_bot: executorId, candidate: { ...candidate, candidateHash: candidateHashOf(candidate) } };
    expect(() => acceptEventDetailed(db, source, { ...event, candidate: { ...event.candidate, reasons: [reasons[0]] } }, stub())).toThrow(/CANDIDATE_HASH_MISMATCH|EVIDENCE_REVISION_MISMATCH/);
    expect(() => acceptEventDetailed(db, source, { ...event, assigned_bot: reviewerId }, stub())).toThrow('ENVELOPE_EXECUTOR_MISMATCH');
    expect(() => acceptEventDetailed(db, source, { ...event, ticket_id: 'T-Z' }, stub())).toThrow('ENVELOPE_TICKET_MISMATCH');
    const first = acceptEventDetailed(db, source, event, stub());
    expect(first).toMatchObject({ queued: 1, accepted: { payloadHash: event.candidate.candidateHash, effects: { candidateRecorded: true, wakesEnqueued: 1 } } });
    // Reordered reasons produce the same evidenceRevision; identical envelope replays; nothing reopens.
    expect(evidenceRevisionOf([reasons[1], reasons[0]])).toBe(evidenceRevision);
    expect(acceptEventDetailed(db, source, event, stub())).toMatchObject({ queued: 0 });
    // A candidate with unknown intent is rejected.
    const foreign = { ...event, id: 'dup:foreign', candidate: { ...candidate, candidateId: uid(), pairReceiptId: uid() } };
    expect(() => acceptEventDetailed(db, source, { ...foreign, candidate: { ...foreign.candidate, candidateHash: candidateHashOf(foreign.candidate) } }, stub())).toThrow('INTENT_UNKNOWN');
    expect(s.readIntentFor(reg.id, pair).candidates).toHaveLength(1);
  });

  it('resolves nonexecution only with a matching native readback that proves a fenced terminal rollback', async () => {
    const { pair, hash } = setupApproved();
    const res = reserve(pair, hash);
    const attemptId = uid();
    s.redeem(reg.id, res.reservationId, { requestKey: uid(), attemptId });
    const report = { requestKey: uid(), attemptId, readback: { schemaVersion: 'orderops-merge-attempt-readback/v1', attemptId, state: 'not_executed', fencedAt: new Date(now).toISOString(), attemptRowHash: H('f') } };
    await expect(s.nonexecution(reg.id, res.reservationId, { ...report, attemptId: uid(), readback: { ...report.readback, attemptId: uid() } })).rejects.toThrow('ATTEMPT_MISMATCH');
    readback = null;
    await expect(s.nonexecution(reg.id, res.reservationId, report)).rejects.toThrow('SOURCE_READBACK_UNAVAILABLE');
    readback = { schemaVersion: 'orderops-merge-attempt-readback/v1', attemptId, pairReceiptId: pair, generation: 1, reservationId: res.reservationId, state: 'unknown', lateCommitFenced: false, fencedAt: null, attemptRowHash: H('f') };
    await expect(s.nonexecution(reg.id, res.reservationId, report)).rejects.toThrow('NONEXECUTION_UNPROVEN');
    now += 16 * 60 * 1000;
    expect(s.readReservation(reg.id, res.reservationId).state).toBe('redeemed_uncertain');
    readback = { ...(readback as object), state: 'not_executed', lateCommitFenced: true, fencedAt: new Date(now).toISOString() };
    expect(await s.nonexecution(reg.id, res.reservationId, report)).toMatchObject({ state: 'nonexecuted' });
    expect(s.readIntentFor(reg.id, pair).fence).toBe('open');
    expect(reserve(pair, hash).generation).toBe(2);
  });

  it('inherits fences across registration rotation and requires owner enrollment', () => {
    const { pair, hash } = setupApproved();
    const res = reserve(pair, hash);
    reg = { ...reg, revision: 2, bearerHash: crypto.createHash('sha256').update('rotated').digest('hex') };
    expect(() => reserve(pair, hash)).toThrow('MERGE_AUTHORIZATION_UNAVAILABLE');
    s.enroll(owner, reg.id);
    expect(() => reserve(pair, hash)).toThrow(`CASE_PENDING:${pair}`);
    expect(s.readReservation(reg.id, res.reservationId).state).toBe('issued');
    expect(() => s.enroll(executor, reg.id)).toThrow('human');
    // A never-enrolled registration is refused outright.
    reg = { ...reg, id: uid() };
    expect(() => reserve(pair, hash)).toThrow('MERGE_AUTHORIZATION_UNAVAILABLE');
  });

  it('shows the owner a plain on/off status and never to bots or non-owners', () => {
    expect(s.status(owner)).toMatchObject({ configured: true, registrations: [{ id: reg.id, enrolled: true, reviewerName: reviewerId, executorName: executorId }] });
    expect(JSON.stringify(s.status(owner))).not.toContain(reg.bearerHash);
    // A rotated revision is off until the owner switches it on again.
    reg = { ...reg, revision: 2 };
    expect(s.status(owner).registrations[0]).toMatchObject({ enrolled: false, enrolledAt: null });
    s.enroll(owner, reg.id);
    expect(s.status(owner).registrations[0].enrolled).toBe(true);
    expect(() => s.status(executor)).toThrow('Only the business owner');
    db.prepare("INSERT INTO users(id,email,display_name,role,status) VALUES(2,'ali@test','Ali','member','active')").run();
    expect(() => s.status({ user: db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow })).toThrow('Only the business owner');
    // No registry: an owner sees "not set up", not an error.
    io.registrations = () => [];
    expect(s.status(owner)).toEqual({ configured: false, registrations: [] });
  });

  it('serves the contract only to the dedicated bearer and rejects bots at the human surface', async () => {
    const app = express();
    app.use('/api/cs/merge-authorization', mergeAuthorizationServiceRoutes({ db, config: { cfAud: 'other', autoshipVerifierCfAud: null, returnVerifierCfAud: null, routineVerifierCfAud: null, purchaseTimingCfAud: null, autoshipCandidateCfAud: null, autoshipVerifierClientId: null, returnVerifierClientId: null, routineVerifierClientId: null, purchaseTimingClientId: null, autoshipCandidateClientId: null } } as unknown as AppContext, { io, cf: async () => true }));
    let who: Actor = executor;
    app.use((req, _res, next) => { req.user = who.user; req.agentConversationId = who.conversationId; next(); });
    app.use('/api/bots', createBotsRouter({ db, config: { dataDir: '/tmp' }, manager: { statusOf: async () => 'idle' } } as unknown as AppContext, { evidenceFetchers: {}, mergeIO: io }));
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise<void>(r => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = (path: string, body?: object, auth = bearer) => fetch(`${base}/api/cs/merge-authorization${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-merge-authorization-registration-id': reg.id, authorization: `Bearer ${auth}` }, body: body ? JSON.stringify(body) : undefined });
    expect((await call('/cases', { cases: [] }, 'wrong-bearer-value-that-is-long-enough-000')).status).toBe(401);
    const cases = await call('/cases', { cases: [{ ticket: 'T-A', caseId: caseA, materialRevision: H('a'), observedAt: new Date(now).toISOString() }, { ticket: 'T-B', caseId: caseB, materialRevision: H('b'), observedAt: new Date(now).toISOString() }] });
    expect(cases.status).toBe(200);
    const pair = uid();
    expect((await call('/intents', intentBody(pair))).status).toBe(200);
    expect((await (await call(`/intents/${pair}`)).json()).revisions).toHaveLength(1);
    // Bot raises the merge question through the API: wrong answer is refused, right answer binds.
    const hash = hashFor(pair, 1, 'a_into_b');
    const raise = (answer: string) => fetch(`${base}/api/bots/decisions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_key: pair, proposal_key: 'merge', proposal: proposal({ merge_intent: { pairReceiptId: pair, intentRevision: 1, direction: 'a_into_b' }, choices: [{ id: 'merge', label: 'Merge T-A into T-B', description: 'x', action: 'approve', answer }, { id: 'keep', label: 'Keep separate', description: 'y', action: 'reject' }] }) }) });
    expect((await raise('nope')).status).toBe(400);
    const ok = await raise(hash); expect(ok.status).toBe(200);
    const { decision } = await ok.json();
    expect(db.prepare('SELECT intent_hash FROM merge_intent_bindings WHERE decision_id=?').get(decision.id)).toEqual({ intent_hash: hash });
    who = owner;
    approve(decision.id);
    const reserved = await call('/reservations', { pairReceiptId: pair, intentHash: hash, requestKey: uid() });
    expect(reserved.status).toBe(200);
    const r = await reserved.json();
    expect((await (await call(`/merge-approvals/${decision.id}/1`)).json()).state).toBe('approved');
    const redeemed = await call(`/reservations/${r.reservationId}/redeem`, { requestKey: uid(), attemptId: uid() });
    expect(await redeemed.json()).toMatchObject({ execute: true });
    expect((await call(`/reservations/${r.reservationId}/redeem`, { requestKey: uid(), attemptId: uid() })).status).toBe(409);
    // Bots cannot revoke at the human surface; the owner can only before redemption.
    who = executor;
    expect((await fetch(`${base}/api/bots/merge-authorization/reservations/${r.reservationId}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x' }) })).status).toBe(403);
    who = owner;
    expect((await fetch(`${base}/api/bots/merge-authorization/reservations/${r.reservationId}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x' }) })).status).toBe(409);
    expect((await call('/unknown', {})).status).toBe(405);
  });
});
