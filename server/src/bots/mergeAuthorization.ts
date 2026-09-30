import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { BotError, createBotService, type Actor } from './service.js';
import { canonicalSha256 } from './canonical.js';
import {
  attemptReadbackSchema, candidateEventSchema, casesInput, commitHashOf, candidateHashOf, directionSchema, directedIntent, eventHashOf, evidenceRevisionOf,
  intentBase, intentBaseHash, intentHashFor, intentInput, mergeHash, mergedEventSchema, nonexecutionInput, redeemInput, registrationSchema, reservationInput,
  MERGE_CONTRACT_HASH, type CandidateEvent, type IntentInput, type MergedEvent, type Registration,
} from './mergeAuthorizationContract.js';

export interface MergeIO {
  registration: (id: string) => Registration;
  /** Native's own authenticated readback of ${sourceOrigin}/api/cs/merge-attempts/:attemptId. */
  attemptReadback: (r: Registration, attemptId: string) => Promise<unknown>;
  now: () => number;
}
const RESERVATION_TTL_MS = 15 * 60 * 1000;
function deny(code: string): never { throw new BotError(409, code); }
const unavailable = (): never => { throw new BotError(503, 'MERGE_AUTHORIZATION_UNAVAILABLE: dedicated owner enrollment and accepted source integration required'); };

type Scope = { sourceId: string; businessId: string };
type IntentRow = { pair_receipt_id: string; source_id: string; business_team_id: string; pair_key: string; case_a: string; case_b: string; executor_conversation_id: string };
type RevisionRow = { pair_receipt_id: string; intent_revision: number; request_key: string; request_hash: string; intent_json: string; intent_base_hash: string; created_at: string };
type Reservation = {
  reservation_id: string; pair_receipt_id: string; generation: number; source_id: string; business_team_id: string; request_key: string; state: string;
  intent_revision: number; intent_hash: string; direction: 'a_into_b' | 'b_into_a'; decision_id: string; decision_version: number; answer_event_id: string;
  registration_id: string; registration_revision: number; issued_at: string; expires_at: string; reservation_hash: string;
  redeem_request_key: string | null; attempt_id: string | null; redemption_id: string | null; redeemed_at: string | null; nonexecution_json: string | null; updated_at: string;
};
type Binding = { decision_id: string; decision_version: number; pair_receipt_id: string; intent_revision: number; direction: 'a_into_b' | 'b_into_a'; intent_hash: string; created_at: string };
type DecisionRow = { id: string; version: number; state: string; conversation_id: string; answer_json: string | null; stale_json: string | null; proposal_json: string };

export type StaleForCase = (caseIds: string[], mark: { reason: 'ticket_merged' | 'duplicate_evidence_changed'; since?: string; detail: string; event_id?: string }) => string[];

export function mergeAuthorization(db: Database.Database, io: MergeIO) {
  const bots = createBotService(db);
  const iso = () => new Date(io.now()).toISOString();

  function registration(id: string, enrolled = true): Registration {
    const r = registrationSchema.parse(io.registration(id));
    if (r.contractHash !== MERGE_CONTRACT_HASH || r.id !== id || !r.active || Date.parse(r.expiresAt) <= io.now()) return unavailable();
    const team = db.prepare('SELECT owner_id FROM business_teams WHERE id=?').get(r.businessId) as { owner_id: number } | undefined;
    if (team?.owner_id !== r.ownerUserId || !db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(r.ownerUserId)) return unavailable();
    if (!db.prepare('SELECT 1 FROM bot_event_sources WHERE id=? AND team_id=? AND enabled=1').get(r.sourceId, r.businessId)) return unavailable();
    for (const cid of [r.reviewerConversationId, r.executorConversationId]) {
      const c = db.prepare('SELECT user_id,business_team_id,archived FROM conversations WHERE id=?').get(cid) as { user_id: number; business_team_id: string; archived: number } | undefined;
      if (!c || c.archived || c.user_id !== r.ownerUserId || c.business_team_id !== r.businessId || !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(cid)) return unavailable();
    }
    if (enrolled && !db.prepare('SELECT 1 FROM merge_authorization_enrollments WHERE registration_id=? AND registration_hash=? AND owner_id=?').get(r.id, canonicalSha256(r), r.ownerUserId)) return unavailable();
    return r;
  }
  const scopeOf = (r: Registration): Scope => ({ sourceId: r.sourceId, businessId: r.businessId });
  function owner(a: Actor, r: Registration) { if (a.conversationId || a.user.id !== r.ownerUserId) throw new BotError(403, 'Actual human business owner required'); }

  // ── §2 tuples ─────────────────────────────────────────────────────────────
  function tuple(s: Scope, by: { ticket?: string; caseId?: string }) {
    return (by.ticket
      ? db.prepare('SELECT * FROM merge_case_tuples WHERE source_id=? AND business_team_id=? AND ticket=?').get(s.sourceId, s.businessId, by.ticket)
      : db.prepare('SELECT * FROM merge_case_tuples WHERE source_id=? AND business_team_id=? AND case_id=?').get(s.sourceId, s.businessId, by.caseId)) as { ticket: string; case_id: string; last_material_revision: string } | undefined;
  }
  function registerCases(regId: string, raw: unknown) {
    const p = casesInput.parse(raw), r = registration(regId), s = scopeOf(r);
    return db.transaction(() => {
      const out = [];
      for (const c of p.cases) {
        const byTicket = tuple(s, { ticket: c.ticket }), byCase = tuple(s, { caseId: c.caseId });
        if ((byTicket && byTicket.case_id !== c.caseId) || (byCase && byCase.ticket !== c.ticket)) deny('TUPLE_CONFLICT');
        if (!byTicket) db.prepare('INSERT INTO merge_case_tuples VALUES(?,?,?,?,?,?,?,?,?,?)').run(s.sourceId, s.businessId, c.ticket, c.caseId, c.materialRevision, c.observedAt, r.id, r.revision, iso(), iso());
        else if (Date.parse(c.observedAt) >= Date.parse((db.prepare('SELECT observed_at FROM merge_case_tuples WHERE source_id=? AND business_team_id=? AND ticket=?').get(s.sourceId, s.businessId, c.ticket) as { observed_at: string }).observed_at))
          db.prepare('UPDATE merge_case_tuples SET last_material_revision=?,observed_at=?,updated_at=? WHERE source_id=? AND business_team_id=? AND ticket=?').run(c.materialRevision, c.observedAt, iso(), s.sourceId, s.businessId, c.ticket);
        out.push({ ticket: c.ticket, caseId: c.caseId, lastMaterialRevision: tuple(s, { ticket: c.ticket })!.last_material_revision });
      }
      return { execute: false as const, cases: out };
    }).immediate();
  }

  // ── §3 intents ────────────────────────────────────────────────────────────
  function intentRow(s: Scope, pairReceiptId: string): IntentRow {
    const row = db.prepare('SELECT * FROM merge_intents WHERE pair_receipt_id=? AND source_id=? AND business_team_id=?').get(pairReceiptId, s.sourceId, s.businessId) as IntentRow | undefined;
    if (!row) throw new BotError(404, 'Unknown pair');
    return row;
  }
  function latestRevision(pairReceiptId: string): RevisionRow | undefined {
    return db.prepare('SELECT * FROM merge_intent_revisions WHERE pair_receipt_id=? ORDER BY intent_revision DESC LIMIT 1').get(pairReceiptId) as RevisionRow | undefined;
  }
  function revisionRow(pairReceiptId: string, revision: number): RevisionRow | undefined {
    return db.prepare('SELECT * FROM merge_intent_revisions WHERE pair_receipt_id=? AND intent_revision=?').get(pairReceiptId, revision) as RevisionRow | undefined;
  }
  function fence(pairReceiptId: string) { return db.prepare('SELECT * FROM merge_actions WHERE pair_receipt_id=?').get(pairReceiptId) as { state: string; live_generation: number | null } | undefined; }
  function setFence(pairReceiptId: string, s: Scope, state: string, live: number | null) {
    db.prepare('INSERT INTO merge_actions VALUES(?,?,?,?,?,?) ON CONFLICT(pair_receipt_id) DO UPDATE SET state=excluded.state,live_generation=excluded.live_generation,updated_at=excluded.updated_at').run(pairReceiptId, s.sourceId, s.businessId, state, live, iso());
  }
  function registerIntent(regId: string, raw: unknown) {
    const i = intentInput.parse(raw), r = registration(regId), s = scopeOf(r);
    if (i.cases.a.caseId === i.cases.b.caseId) deny('SAME_CASE');
    for (const c of [i.cases.a, i.cases.b]) { const t = tuple(s, { ticket: c.ticket }); if (!t || t.case_id !== c.caseId) deny('UNKNOWN_CASE'); }
    if (!db.prepare('SELECT 1 FROM bot_registrations b JOIN conversations c ON c.id=b.conversation_id WHERE b.conversation_id=? AND b.active=1 AND c.business_team_id=?').get(i.executorConversationId, s.businessId)) deny('EXECUTOR_NOT_REGISTERED');
    const pairKey = [i.cases.a.caseId, i.cases.b.caseId].sort().join('|');
    return db.transaction(() => {
      const byKey = db.prepare('SELECT * FROM merge_intents WHERE source_id=? AND business_team_id=? AND pair_key=?').get(s.sourceId, s.businessId, pairKey) as IntentRow | undefined;
      const byId = db.prepare('SELECT * FROM merge_intents WHERE pair_receipt_id=?').get(i.pairReceiptId) as IntentRow | undefined;
      if (byKey && byKey.pair_receipt_id !== i.pairReceiptId) throw new BotError(409, `PAIR_EXISTS:${byKey.pair_receipt_id}`);
      if (byId && (byId.pair_key !== pairKey || byId.source_id !== s.sourceId || byId.business_team_id !== s.businessId)) deny('PAIR_MISMATCH');
      if (!byId) {
        db.prepare('INSERT INTO merge_intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(i.pairReceiptId, s.sourceId, s.businessId, pairKey, i.cases.a.caseId, i.cases.b.caseId, i.executorConversationId, r.id, r.revision, iso());
        setFence(i.pairReceiptId, s, 'open', null);
      } else if (byId.executor_conversation_id !== i.executorConversationId) deny('EXECUTOR_MISMATCH');
      const requestHash = canonicalSha256(i);
      const replay = db.prepare('SELECT * FROM merge_intent_revisions WHERE pair_receipt_id=? AND request_key=?').get(i.pairReceiptId, i.requestKey) as RevisionRow | undefined;
      if (replay) { if (replay.request_hash !== requestHash) deny('IDEMPOTENCY_CONFLICT'); return respond(replay); }
      const latest = latestRevision(i.pairReceiptId);
      const material = (x: IntentInput, rev: number) => canonicalSha256({ ...intentBase(s.sourceId, s.businessId, x, rev), intentRevision: 0 });
      if (latest && material(intentInput.parse(JSON.parse(latest.intent_json)), latest.intent_revision) === material(i, latest.intent_revision)) return respond(latest);
      const revision = (latest?.intent_revision ?? 0) + 1;
      db.prepare('INSERT INTO merge_intent_revisions VALUES(?,?,?,?,?,?,?,?,?)').run(i.pairReceiptId, revision, i.requestKey, requestHash, JSON.stringify(i), intentBaseHash(s.sourceId, s.businessId, i, revision), r.id, r.revision, iso());
      return respond(revisionRow(i.pairReceiptId, revision)!);
    }).immediate();
    function respond(rev: RevisionRow) { return { execute: false as const, pairReceiptId: rev.pair_receipt_id, intentRevision: rev.intent_revision, intentBaseHash: rev.intent_base_hash, state: fence(rev.pair_receipt_id)?.state ?? 'open' }; }
  }
  function hashesFor(s: Scope, rev: RevisionRow) {
    const i = intentInput.parse(JSON.parse(rev.intent_json));
    return Object.fromEntries(i.offeredDirections.map((d) => [d, intentHashFor(s.sourceId, s.businessId, i, rev.intent_revision, rev.intent_base_hash, d)])) as Record<'a_into_b' | 'b_into_a', string>;
  }

  // ── decision bindings (bot side) ──────────────────────────────────────────
  function decision(id: string): DecisionRow | undefined { return db.prepare('SELECT id,version,state,conversation_id,answer_json,stale_json,proposal_json FROM bot_decisions WHERE id=?').get(id) as DecisionRow | undefined; }
  function answerEventId(d: DecisionRow) { return (db.prepare("SELECT id FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='answered' ORDER BY rowid DESC LIMIT 1").get(d.id, d.version) as { id: string } | undefined)?.id ?? null; }
  /** open|approved|rejected|stale|superseded|withdrawn for one binding. */
  function bindingState(b: Binding) {
    const d = decision(b.decision_id);
    if (!d) return { state: 'withdrawn' as const, answerEventId: null };
    if (d.version !== b.decision_version) return { state: 'superseded' as const, answerEventId: null };
    if (d.state === 'needs_input') return { state: d.stale_json ? 'stale' as const : 'open' as const, answerEventId: null };
    const answer = d.answer_json ? JSON.parse(d.answer_json) as { action: string; answer?: string } : null;
    if (answer?.action === 'approve' && answer.answer === b.intent_hash) return { state: 'approved' as const, answerEventId: answerEventId(d) };
    if (answer?.action === 'reject') return { state: 'rejected' as const, answerEventId: null };
    if (answer?.action === 'withdraw') return { state: 'withdrawn' as const, answerEventId: null };
    return { state: 'open' as const, answerEventId: null };
  }
  function openBindingForPair(pairReceiptId: string, exceptDecision?: string): Binding | undefined {
    for (const b of db.prepare('SELECT b.* FROM merge_intent_bindings b JOIN bot_decisions d ON d.id=b.decision_id AND d.version=b.decision_version WHERE b.pair_receipt_id=? AND d.state=\'needs_input\'').all(pairReceiptId) as Binding[])
      if (b.decision_id !== exceptDecision) return b;
    return undefined;
  }
  /** Validate proposal.merge_intent for a bot's raise/revise and compute the intentHash the approve choice must carry. */
  function prepareBinding(input: { pairReceiptId: string; intentRevision: number; direction: 'a_into_b' | 'b_into_a' }, executorConversationId: string, choices: { action: string; answer?: string }[] | undefined, exceptDecision?: string) {
    const row = db.prepare('SELECT * FROM merge_intents WHERE pair_receipt_id=?').get(input.pairReceiptId) as IntentRow | undefined;
    if (!row) throw new BotError(404, 'Unknown pair: OrderOps must register the intent before the question is raised');
    if (row.executor_conversation_id !== executorConversationId) throw new BotError(403, 'Only the executor named in the registered intent may raise this merge question');
    const rev = revisionRow(input.pairReceiptId, input.intentRevision);
    if (!rev) throw new BotError(409, 'Unknown intent revision');
    const i = intentInput.parse(JSON.parse(rev.intent_json));
    if (!i.offeredDirections.includes(input.direction)) throw new BotError(409, 'Direction not offered by this intent revision');
    const s = { sourceId: row.source_id, businessId: row.business_team_id };
    const intentHash = intentHashFor(s.sourceId, s.businessId, i, rev.intent_revision, rev.intent_base_hash, input.direction);
    const open = openBindingForPair(input.pairReceiptId, exceptDecision);
    if (open) throw new BotError(409, `MERGE_QUESTION_OPEN:${open.decision_id}`);
    const approve = (choices ?? []).filter((c) => c.action === 'approve');
    if (!approve.length || approve.some((c) => c.answer !== intentHash)) throw new BotError(400, `The approve choice's answer must equal the intentHash ${intentHash} for this pair, revision and direction`);
    const from = input.direction === 'a_into_b' ? i.cases.a : i.cases.b, into = input.direction === 'a_into_b' ? i.cases.b : i.cases.a;
    return { intentHash, from, into, pairReceiptId: input.pairReceiptId, intentRevision: rev.intent_revision, direction: input.direction };
  }
  function recordBinding(decisionId: string, version: number, b: { pairReceiptId: string; intentRevision: number; direction: 'a_into_b' | 'b_into_a'; intentHash: string }) {
    db.prepare('INSERT INTO merge_intent_bindings VALUES(?,?,?,?,?,?,?)').run(decisionId, version, b.pairReceiptId, b.intentRevision, b.direction, b.intentHash, iso());
  }
  function bindingByHash(pairReceiptId: string, intentHash: string): Binding | undefined {
    return db.prepare('SELECT * FROM merge_intent_bindings WHERE pair_receipt_id=? AND intent_hash=? ORDER BY decision_version DESC, rowid DESC LIMIT 1').get(pairReceiptId, intentHash) as Binding | undefined;
  }
  /** The approval a reservation pins: current version, approved with this intentHash, not stale/superseded/withdrawn/rejected. */
  function currentApproval(pairReceiptId: string, intentHash: string, pinned?: { decisionId: string; decisionVersion: number; answerEventId: string }) {
    const b = pinned ? (db.prepare('SELECT * FROM merge_intent_bindings WHERE decision_id=? AND decision_version=?').get(pinned.decisionId, pinned.decisionVersion) as Binding | undefined) : bindingByHash(pairReceiptId, intentHash);
    if (!b || b.intent_hash !== intentHash) deny('APPROVAL_NOT_FOUND');
    const st = bindingState(b);
    if (st.state !== 'approved' || !st.answerEventId) deny(`APPROVAL_NOT_CURRENT:${st.state}`);
    if (pinned && st.answerEventId !== pinned.answerEventId) deny('APPROVAL_NOT_CURRENT:answer_changed');
    return { binding: b, answerEventId: st.answerEventId };
  }

  // ── §6 locks and merged-away ──────────────────────────────────────────────
  function caseIds(row: IntentRow) { return [row.case_a, row.case_b].sort(); }
  function overlapCheck(s: Scope, row: IntentRow) {
    for (const c of caseIds(row)) {
      const lock = db.prepare('SELECT pair_receipt_id FROM merge_case_locks WHERE source_id=? AND business_team_id=? AND case_id=?').get(s.sourceId, s.businessId, c) as { pair_receipt_id: string } | undefined;
      if (lock && lock.pair_receipt_id !== row.pair_receipt_id) throw new BotError(409, `CASE_PENDING:${lock.pair_receipt_id}`);
    }
    for (const c of caseIds(row))
      if (db.prepare('SELECT 1 FROM case_merges WHERE source_id=? AND business_team_id=? AND from_case_id=?').get(s.sourceId, s.businessId, c)) throw new BotError(409, `CASE_MERGED_AWAY:${c}`);
  }
  function lock(s: Scope, row: IntentRow, generation: number) {
    for (const c of caseIds(row)) db.prepare('INSERT INTO merge_case_locks VALUES(?,?,?,?,?,?)').run(s.sourceId, s.businessId, c, row.pair_receipt_id, generation, iso());
  }
  function unlock(s: Scope, pairReceiptId: string) { db.prepare('DELETE FROM merge_case_locks WHERE source_id=? AND business_team_id=? AND pair_receipt_id=?').run(s.sourceId, s.businessId, pairReceiptId); }

  // ── §4 reservations ───────────────────────────────────────────────────────
  function reservationRow(id: string): Reservation | undefined { return db.prepare('SELECT * FROM merge_reservations WHERE reservation_id=?').get(id) as Reservation | undefined; }
  function setState(res: Reservation, state: string, extra: Partial<Record<'redeem_request_key' | 'attempt_id' | 'redemption_id' | 'redeemed_at' | 'nonexecution_json', string>> = {}) {
    db.prepare('UPDATE merge_reservations SET state=?,redeem_request_key=COALESCE(?,redeem_request_key),attempt_id=COALESCE(?,attempt_id),redemption_id=COALESCE(?,redemption_id),redeemed_at=COALESCE(?,redeemed_at),nonexecution_json=COALESCE(?,nonexecution_json),updated_at=? WHERE reservation_id=?')
      .run(state, extra.redeem_request_key ?? null, extra.attempt_id ?? null, extra.redemption_id ?? null, extra.redeemed_at ?? null, extra.nonexecution_json ?? null, iso(), res.reservation_id);
  }
  /** §4.3 lazy expiry: issued → expired_unredeemed (fence reopens); redeemed → redeemed_uncertain (fence stays). */
  function settle(res: Reservation): Reservation {
    if (io.now() >= Date.parse(res.expires_at)) {
      const s = { sourceId: res.source_id, businessId: res.business_team_id };
      if (res.state === 'issued') { setState(res, 'expired_unredeemed'); unlock(s, res.pair_receipt_id); setFence(res.pair_receipt_id, s, 'open', null); }
      else if (res.state === 'redeemed') setState(res, 'redeemed_uncertain');
    }
    return reservationRow(res.reservation_id)!;
  }
  function readback(res: Reservation) {
    return { execute: false as const, replay: true as const, reservationId: res.reservation_id, pairReceiptId: res.pair_receipt_id, generation: res.generation, state: res.state, intentHash: res.intent_hash, direction: res.direction,
      decisionId: res.decision_id, decisionVersion: res.decision_version, answerEventId: res.answer_event_id, issuedAt: res.issued_at, expiresAt: res.expires_at, reservationHash: res.reservation_hash,
      attemptId: res.attempt_id, redemptionId: res.redemption_id, redeemedAt: res.redeemed_at, requestKey: res.request_key };
  }
  function scoped(r: Registration, res: Reservation | undefined): Reservation {
    if (!res || res.source_id !== r.sourceId || res.business_team_id !== r.businessId) throw new BotError(404, 'Unknown reservation');
    return res;
  }
  function reserve(regId: string, raw: unknown) {
    const p = reservationInput.parse(raw), r = registration(regId), s = scopeOf(r);
    return db.transaction(() => {
      const row = intentRow(s, p.pairReceiptId);
      const replay = db.prepare('SELECT * FROM merge_reservations WHERE source_id=? AND business_team_id=? AND request_key=?').get(s.sourceId, s.businessId, p.requestKey) as Reservation | undefined;
      if (replay) { if (replay.pair_receipt_id !== p.pairReceiptId || replay.intent_hash !== p.intentHash) deny('IDEMPOTENCY_CONFLICT'); return readback(settle(replay)); }
      for (const g of db.prepare('SELECT * FROM merge_reservations WHERE pair_receipt_id=?').all(p.pairReceiptId) as Reservation[]) settle(g);
      const f = fence(p.pairReceiptId);
      if (f?.state === 'committed') deny('PAIR_COMMITTED');
      if (f?.state === 'fenced') throw new BotError(409, `CASE_PENDING:${p.pairReceiptId}`);
      const approval = currentApproval(p.pairReceiptId, p.intentHash);
      overlapCheck(s, row);
      const generation = ((db.prepare('SELECT max(generation) g FROM merge_reservations WHERE pair_receipt_id=?').get(p.pairReceiptId) as { g: number | null }).g ?? 0) + 1;
      const issuedAt = iso(), expiresAt = new Date(io.now() + RESERVATION_TTL_MS).toISOString(), reservationId = crypto.randomUUID();
      const issuance = { reservationId, pairReceiptId: p.pairReceiptId, generation, intentRevision: approval.binding.intent_revision, intentHash: p.intentHash, decisionId: approval.binding.decision_id, decisionVersion: approval.binding.decision_version, answerEventId: approval.answerEventId, registrationId: r.id, registrationRevision: r.revision, sourceId: s.sourceId, businessId: s.businessId, requestKey: p.requestKey, issuedAt, expiresAt };
      db.prepare('INSERT INTO merge_reservations(reservation_id,pair_receipt_id,generation,source_id,business_team_id,request_key,state,intent_revision,intent_hash,direction,decision_id,decision_version,answer_event_id,registration_id,registration_revision,issued_at,expires_at,reservation_hash,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(reservationId, p.pairReceiptId, generation, s.sourceId, s.businessId, p.requestKey, 'issued', approval.binding.intent_revision, p.intentHash, approval.binding.direction, approval.binding.decision_id, approval.binding.decision_version, approval.answerEventId, r.id, r.revision, issuedAt, expiresAt, mergeHash('merge-reservation/v1', issuance), issuedAt);
      lock(s, row, generation);
      setFence(p.pairReceiptId, s, 'fenced', generation);
      return { ...readback(reservationRow(reservationId)!), replay: false as const };
    }).immediate();
  }
  function redeem(regId: string, id: string, raw: unknown) {
    const p = redeemInput.parse(raw), r = registration(regId), s = scopeOf(r);
    return db.transaction(() => {
      const res = settle(scoped(r, reservationRow(id)));
      if (res.redeem_request_key === p.requestKey && res.state !== 'issued') return readback(res);
      if (res.state !== 'issued') throw new BotError(409, `RESERVATION_${res.state.toUpperCase()}`);
      if (io.now() >= Date.parse(res.expires_at)) deny('RESERVATION_EXPIRED');
      registration(regId);
      currentApproval(res.pair_receipt_id, res.intent_hash, { decisionId: res.decision_id, decisionVersion: res.decision_version, answerEventId: res.answer_event_id });
      const f = fence(res.pair_receipt_id);
      if (f?.state !== 'fenced' || f.live_generation !== res.generation) deny('GENERATION_NOT_LIVE');
      overlapCheck(s, intentRow(s, res.pair_receipt_id));
      const redemptionId = crypto.randomUUID();
      setState(res, 'redeemed', { redeem_request_key: p.requestKey, attempt_id: p.attemptId, redemption_id: redemptionId, redeemed_at: iso() });
      return { execute: true as const, replay: false as const, redemptionId, reservationId: res.reservation_id, generation: res.generation, expiresAt: res.expires_at, redeemedAt: iso() };
    }).immediate();
  }
  function readReservation(regId: string, id: string) { const r = registration(regId); return readback(db.transaction(() => settle(scoped(r, reservationRow(id)))).immediate()); }
  function readByRequestKey(regId: string, key: string) {
    const r = registration(regId);
    const res = db.prepare('SELECT * FROM merge_reservations WHERE source_id=? AND business_team_id=? AND (request_key=? OR redeem_request_key=?)').get(r.sourceId, r.businessId, key, key) as Reservation | undefined;
    if (!res) throw new BotError(404, 'No reservation was persisted for that request key');
    return readback(db.transaction(() => settle(res)).immediate());
  }
  function revoke(a: Actor, id: string, reason: string) {
    return db.transaction(() => {
      const res = reservationRow(id);
      if (!res) throw new BotError(404, 'Unknown reservation');
      const r = registration(res.registration_id);
      if (a.conversationId) { if (a.conversationId !== r.reviewerConversationId || a.user.id !== r.ownerUserId) throw new BotError(403, 'Original enrolled reviewer required'); bots.chat(a, r.reviewerConversationId); }
      else owner(a, r);
      const current = settle(res), s = scopeOf(r);
      if (current.state !== 'issued') deny(['redeemed', 'redeemed_uncertain', 'committed'].includes(current.state) ? 'ALREADY_REDEEMED' : `RESERVATION_${current.state.toUpperCase()}`);
      setState(current, 'revoked', { nonexecution_json: JSON.stringify({ revokedBy: a.user.id, reason, at: iso() }) });
      unlock(s, current.pair_receipt_id);
      setFence(current.pair_receipt_id, s, 'open', null);
      return { execute: false as const, state: 'revoked' as const, reservationId: id };
    }).immediate();
  }
  async function nonexecution(regId: string, id: string, raw: unknown) {
    const p = nonexecutionInput.parse(raw), r = registration(regId), s = scopeOf(r);
    const res = db.transaction(() => settle(scoped(r, reservationRow(id)))).immediate();
    if (!['redeemed', 'redeemed_uncertain'].includes(res.state)) throw new BotError(409, `RESERVATION_${res.state.toUpperCase()}`);
    if (res.attempt_id !== p.attemptId || p.readback.attemptId !== p.attemptId) deny('ATTEMPT_MISMATCH');
    let rb;
    try { rb = attemptReadbackSchema.parse(await io.attemptReadback(r, p.attemptId)); } catch { deny('SOURCE_READBACK_UNAVAILABLE'); }
    if (rb.attemptId !== p.attemptId || rb.reservationId !== res.reservation_id || rb.pairReceiptId !== res.pair_receipt_id || rb.generation !== res.generation || rb.state !== 'not_executed' || !rb.lateCommitFenced || rb.attemptRowHash !== p.readback.attemptRowHash)
      deny('NONEXECUTION_UNPROVEN');
    return db.transaction(() => {
      const again = settle(scoped(r, reservationRow(id)));
      if (!['redeemed', 'redeemed_uncertain'].includes(again.state)) throw new BotError(409, `RESERVATION_${again.state.toUpperCase()}`);
      setState(again, 'nonexecuted', { nonexecution_json: JSON.stringify({ report: p, readback: rb, at: iso() }) });
      unlock(s, again.pair_receipt_id);
      setFence(again.pair_receipt_id, s, 'open', null);
      return { execute: false as const, state: 'nonexecuted' as const, reservationId: id };
    }).immediate();
  }

  // ── read models ───────────────────────────────────────────────────────────
  function readIntent(s: Scope, pairReceiptId: string) {
    const row = intentRow(s, pairReceiptId);
    const revisions = (db.prepare('SELECT * FROM merge_intent_revisions WHERE pair_receipt_id=? ORDER BY intent_revision').all(pairReceiptId) as RevisionRow[]).map((rev) => ({ intentRevision: rev.intent_revision, intentBaseHash: rev.intent_base_hash, intent: JSON.parse(rev.intent_json), intentHashes: hashesFor(s, rev), createdAt: rev.created_at }));
    const bindings = (db.prepare('SELECT * FROM merge_intent_bindings WHERE pair_receipt_id=? ORDER BY rowid').all(pairReceiptId) as Binding[]).map((b) => ({ decisionId: b.decision_id, decisionVersion: b.decision_version, intentRevision: b.intent_revision, direction: b.direction, intentHash: b.intent_hash, ...bindingState(b) }));
    const reservations = (db.prepare('SELECT * FROM merge_reservations WHERE pair_receipt_id=? ORDER BY generation').all(pairReceiptId) as Reservation[]).map((g) => readback(db.transaction(() => settle(g)).immediate()));
    const merge = db.prepare('SELECT * FROM case_merges WHERE pair_receipt_id=?').get(pairReceiptId) as Record<string, unknown> | undefined;
    const candidates = db.prepare('SELECT candidate_id,intent_revision,evidence_revision,state,supersedes,accepted_at FROM duplicate_candidates WHERE pair_receipt_id=? ORDER BY rowid').all(pairReceiptId);
    return { execute: false as const, pairReceiptId, cases: caseIds(row), executorConversationId: row.executor_conversation_id, fence: fence(pairReceiptId)?.state ?? 'open', revisions, bindings, reservations, candidates, merge: merge ? { fromCaseId: merge.from_case_id, intoCaseId: merge.into_case_id, fromTicket: merge.from_ticket, intoTicket: merge.into_ticket, committedAt: merge.committed_at, generation: merge.generation } : null };
  }
  function exportApproval(regId: string, decisionId: string, version: number) {
    const r = registration(regId);
    const b = db.prepare('SELECT * FROM merge_intent_bindings WHERE decision_id=? AND decision_version=?').get(decisionId, version) as Binding | undefined;
    if (!b) throw new BotError(404, 'No merge binding for that decision version');
    const row = intentRow(scopeOf(r), b.pair_receipt_id);
    void row;
    const st = bindingState(b), d = decision(decisionId)!;
    return { execute: false as const, decisionId, decisionVersion: version, currentVersion: d.version, pairReceiptId: b.pair_receipt_id, intentRevision: b.intent_revision, direction: b.direction, intentHash: b.intent_hash, ...st,
      answeredAt: st.answerEventId ? (db.prepare('SELECT created_at FROM bot_decision_events WHERE id=?').get(st.answerEventId) as { created_at: string }).created_at : null };
  }
  function receipt(regId: string, eventId: string) {
    const r = registration(regId);
    const row = db.prepare('SELECT * FROM bot_event_receipts WHERE source_id=? AND business_team_id=? AND event_id=?').get(r.sourceId, r.businessId, eventId) as { event_hash: string; payload_hash: string; response_json: string; accepted_at: string } | undefined;
    if (!row) throw new BotError(404, 'No receipt for that event');
    return { execute: false as const, eventId, eventHash: row.event_hash, payloadHash: row.payload_hash, acceptedAt: row.accepted_at, response: JSON.parse(row.response_json) };
  }

  // ── §5/§7 events (called inside acceptEvent) ──────────────────────────────
  type Effects = { mergeRecorded?: boolean; candidateRecorded?: boolean; staledDecisions: number; wakesEnqueued: number };
  function existingReceipt(sourceId: string, eventId: string, eventHash: string) {
    const row = db.prepare('SELECT event_hash,response_json FROM bot_event_receipts WHERE source_id=? AND event_id=?').get(sourceId, eventId) as { event_hash: string; response_json: string } | undefined;
    if (!row) return null;
    if (row.event_hash !== eventHash) deny('EVENT_CONFLICT');
    return { ...JSON.parse(row.response_json), queued: 0 };
  }
  function accept(sourceId: string, businessId: string, event: MergedEvent | CandidateEvent, eventHash: string, payloadHash: string, effects: Effects) {
    const acceptedAt = iso();
    const acceptance = { sourceId, businessId, eventId: event.id, eventHash, payloadHash, effects, acceptedAt, registrationId: null };
    const response = { ok: true, queued: effects.wakesEnqueued, accepted: { eventId: event.id, eventHash, payloadHash, acceptanceHash: mergeHash('native-accept/v1', acceptance), acceptedAt, effects } };
    db.prepare('INSERT INTO bot_event_receipts VALUES(?,?,?,?,?,?,?,?)').run(sourceId, businessId, event.id, eventHash, payloadHash, JSON.stringify(event), JSON.stringify(response), acceptedAt);
    return response;
  }
  function acceptMerged(sourceId: string, businessId: string, raw: unknown, stale: StaleForCase, wake: (event: MergedEvent) => number) {
    const e = mergedEventSchema.parse(raw), s = { sourceId, businessId }, eventHash = eventHashOf(sourceId, e);
    return db.transaction(() => {
      const prior = existingReceipt(sourceId, e.id, eventHash);
      if (prior) return prior;
      const c = e.commit;
      if (commitHashOf(c) !== c.commitHash) deny('COMMIT_HASH_MISMATCH');
      if (!c.result.sourceRetained) deny('SOURCE_NOT_RETAINED');
      const res0 = db.prepare('SELECT * FROM merge_reservations WHERE pair_receipt_id=? AND generation=? AND source_id=? AND business_team_id=?').get(c.pairReceiptId, c.generation, sourceId, businessId) as Reservation | undefined;
      if (!res0) deny('RESERVATION_UNKNOWN');
      const res = settle(res0);
      if (res.reservation_id !== c.reservationId) deny('RESERVATION_MISMATCH');
      if (res.state === 'issued') deny('NOT_REDEEMED');
      if (!['redeemed', 'redeemed_uncertain'].includes(res.state)) throw new BotError(409, `RESERVATION_${res.state.toUpperCase()}`);
      if (res.redemption_id !== c.redemptionId || res.attempt_id !== c.attemptId) deny('REDEMPTION_MISMATCH');
      if (res.intent_hash !== c.intentHash) deny('INTENT_HASH_MISMATCH');
      const rev = revisionRow(res.pair_receipt_id, res.intent_revision)!, i = intentInput.parse(JSON.parse(rev.intent_json));
      const di = directedIntent(sourceId, businessId, i, rev.intent_revision, rev.intent_base_hash, res.direction);
      if (c.preconditions.fromMaterialRevision !== di.from.materialRevision || c.preconditions.intoMaterialRevision !== di.into.materialRevision) deny('PRECONDITION_MISMATCH');
      if (e.ticket_id !== di.into.ticket) deny('ENVELOPE_TICKET_MISMATCH');
      if (e.assigned_bot && e.assigned_bot !== di.executorConversationId) deny('ENVELOPE_EXECUTOR_MISMATCH');
      const t = Date.parse(e.occurred_at);
      if (t < Date.parse(res.redeemed_at!) || t > Date.parse(res.expires_at)) deny('TIME_ORDER');
      if (db.prepare('SELECT 1 FROM case_merges WHERE pair_receipt_id=?').get(c.pairReceiptId)) deny('DUPLICATE_COMMIT');
      db.prepare('INSERT INTO case_merges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(c.pairReceiptId, res.reservation_id, sourceId, businessId, res.generation, di.from.caseId, di.into.caseId, di.from.ticket, di.into.ticket, JSON.stringify(c), e.occurred_at, res.registration_id, res.registration_revision, iso());
      setState(res, 'committed');
      unlock(s, c.pairReceiptId);
      setFence(c.pairReceiptId, s, 'committed', null);
      db.prepare("UPDATE duplicate_candidates SET state='superseded_by_merge' WHERE pair_receipt_id=?").run(c.pairReceiptId);
      const staled = stale([di.from.ticket, di.into.ticket], { reason: 'ticket_merged', since: e.occurred_at, detail: `ticket ${di.from.ticket} was merged into ${di.into.ticket} after this question was asked`, event_id: `${sourceId}:${e.id}` });
      const wakes = wake(e);
      return accept(sourceId, businessId, e, eventHash, c.commitHash, { mergeRecorded: true, staledDecisions: staled.length, wakesEnqueued: wakes });
    }).immediate();
  }
  function acceptCandidate(sourceId: string, businessId: string, raw: unknown, stale: StaleForCase, wake: (event: CandidateEvent) => number) {
    const e = candidateEventSchema.parse(raw), eventHash = eventHashOf(sourceId, e);
    return db.transaction(() => {
      const prior = existingReceipt(sourceId, e.id, eventHash);
      if (prior) return prior;
      const c = e.candidate;
      if (candidateHashOf(c) !== c.candidateHash) deny('CANDIDATE_HASH_MISMATCH');
      if (evidenceRevisionOf(c.reasons) !== c.evidenceRevision) deny('EVIDENCE_REVISION_MISMATCH');
      const row = db.prepare('SELECT * FROM merge_intents WHERE pair_receipt_id=? AND source_id=? AND business_team_id=?').get(c.pairReceiptId, sourceId, businessId) as IntentRow | undefined;
      const rev = row ? revisionRow(c.pairReceiptId, c.intentRevision) : undefined;
      if (!row || !rev) deny('INTENT_UNKNOWN');
      const i = intentInput.parse(JSON.parse(rev.intent_json));
      if (i.candidateId !== c.candidateId || i.evidenceRevision !== c.evidenceRevision) deny('INTENT_CANDIDATE_MISMATCH');
      if (e.assigned_bot !== row.executor_conversation_id) deny('ENVELOPE_EXECUTOR_MISMATCH');
      if (![i.cases.a.ticket, i.cases.b.ticket].includes(e.ticket_id)) deny('ENVELOPE_TICKET_MISMATCH');
      if (c.supersedes && !db.prepare('SELECT 1 FROM duplicate_candidates WHERE candidate_id=?').get(c.supersedes)) deny('SUPERSEDES_UNKNOWN');
      const merged = fence(c.pairReceiptId)?.state === 'committed';
      db.prepare('INSERT INTO duplicate_candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(c.candidateId, sourceId, businessId, c.pairReceiptId, c.intentRevision, c.evidenceRevision, e.assigned_bot, c.supersedes ?? null, c.candidateHash, merged ? 'superseded_by_merge' : 'recorded', iso(), null, null);
      let staled = 0, wakes = 0;
      if (!merged) {
        const open = openBindingForPair(c.pairReceiptId);
        if (open && open.intent_revision !== c.intentRevision) staled = stale([i.cases.a.ticket, i.cases.b.ticket], { reason: 'duplicate_evidence_changed', since: e.occurred_at, detail: `new duplicate evidence (revision ${c.evidenceRevision.slice(0, 12)}) arrived for tickets ${i.cases.a.ticket} and ${i.cases.b.ticket}`, event_id: `${sourceId}:${e.id}` }).length;
        wakes = wake(e);
      }
      return accept(sourceId, businessId, e, eventHash, c.candidateHash, { candidateRecorded: true, staledDecisions: staled, wakesEnqueued: wakes });
    }).immediate();
  }

  return {
    registration, registerCases, registerIntent, readIntent, prepareBinding, recordBinding, reserve, redeem, readReservation, readByRequestKey, revoke, nonexecution, exportApproval, receipt, acceptMerged, acceptCandidate,
    /** Owner-only enrollment of a registry entry (never a bot, never the reviewer). */
    enroll(a: Actor, registrationId: string) {
      return db.transaction(() => {
        const r = registration(registrationId, false); owner(a, r);
        const h = canonicalSha256(r);
        if (!db.prepare('SELECT 1 FROM merge_authorization_enrollments WHERE registration_id=? AND registration_hash=?').get(r.id, h)) db.prepare('INSERT INTO merge_authorization_enrollments VALUES(?,?,?,?)').run(r.id, h, a.user.id, iso());
        return { execute: false as const, enrolled: true };
      }).immediate();
    },
    /** Owner, reviewer or executor read of one pair. */
    readIntentAs(a: Actor, registrationId: string, pairReceiptId: string) {
      const r = registration(registrationId);
      if (a.conversationId) { if (![r.reviewerConversationId, r.executorConversationId].includes(a.conversationId) || a.user.id !== r.ownerUserId) throw new BotError(403, 'Original participant required'); }
      else owner(a, r);
      return readIntent(scopeOf(r), pairReceiptId);
    },
    readIntentFor: (regId: string, pairReceiptId: string) => readIntent(scopeOf(registration(regId)), pairReceiptId),
    /** Alias resolution for staling: every ticket that was merged into, or from, any of these tickets. */
    aliases(ticketIds: string[]): string[] {
      const out = new Set(ticketIds);
      let grew = true;
      while (grew) {
        grew = false;
        for (const t of [...out]) for (const row of db.prepare('SELECT from_ticket,into_ticket FROM case_merges WHERE from_ticket=? OR into_ticket=?').all(t, t) as { from_ticket: string; into_ticket: string }[])
          for (const x of [row.from_ticket, row.into_ticket]) if (!out.has(x)) { out.add(x); grew = true; }
      }
      return [...out];
    },
    /** Direction/case detail a bot needs when raising the question. */
    directionDetail(pairReceiptId: string, intentRevision: number, direction: z.infer<typeof directionSchema>) {
      const row = db.prepare('SELECT * FROM merge_intents WHERE pair_receipt_id=?').get(pairReceiptId) as IntentRow | undefined, rev = revisionRow(pairReceiptId, intentRevision);
      if (!row || !rev) return null;
      const i = intentInput.parse(JSON.parse(rev.intent_json));
      return directedIntent(row.source_id, row.business_team_id, i, rev.intent_revision, rev.intent_base_hash, direction);
    },
  };
}
import type { z } from 'zod';
