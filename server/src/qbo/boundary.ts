import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { BotError } from '../bots/service.js';
import { canonicalSha256 } from '../bots/canonical.js';
import { H, authorityScope, requestSchema, factsSchema, lookupSchema, effectDigest, sourceReceiptSchema, reservationSchema, type Request, type Caller, type Facts } from './contract.js';

// Server-owned adapter only. Never take facts, permission booleans or receipts
// from HTTP bodies. No production authority source has yet been accepted.
export interface QboFactResolver {
  current(caller: Caller, request: Request): unknown; // synchronous atomic native snapshot
  receipt(caller: Caller, reservation: ReturnType<typeof reservationSchema.parse>): Promise<unknown>;
}
export const unavailableFacts: QboFactResolver = {
  current() { throw new BotError(503, 'QBO_ASSIGNMENT_AND_ACCOUNTING_BINDING_UNAVAILABLE'); },
  async receipt() { throw new BotError(503, 'QBO_AUTHENTICATED_HELPER_RECEIPT_UNAVAILABLE'); },
};
type Row = { id: string; executor_id: string; actor_user_id: number; request_hash: string; reservation_json: string };
function deny(code: string): never { throw new BotError(409, code); }
export function qboBoundary(db: Database.Database, resolver: QboFactResolver = unavailableFacts, now = Date.now) {
  function same(a: unknown, b: unknown) { return canonicalSha256(a) === canonicalSha256(b); }
  function facts(caller: Caller, p: Request): Facts {
    const f = factsSchema.parse(resolver.current(caller, p));
    if (f.bindingRef !== p.bindingRef || f.executorConversationId !== caller.conversationId || f.ownerUserId !== caller.userId) deny('QBO_FOREIGN_BINDING');
    if (f.assignmentState !== 'assigned' || f.authorityState !== 'current') deny('QBO_ASSIGNMENT_OR_AUTHORITY_REVOKED');
    if (f.assignmentRevision !== p.assignmentRevision || f.authorityRevision !== p.authorityRevision) deny('QBO_REVISION_CHANGED');
    if (f.integration.audience !== p.audience || Math.min(Date.parse(f.expiresAt), Date.parse(f.integration.expiresAt)) <= now()) deny('QBO_SCOPE_EXPIRED');
    if (!same(f.operation, p.operation) || f.authorityScopeHash !== authorityScope(f)) deny('QBO_OPERATION_SCOPE_MISMATCH');
    // A registered native bot and current native business membership are necessary,
    // never sufficient for accounting permission (the independent resolver above).
    const row = db.prepare(`SELECT c.id FROM conversations c JOIN users u ON u.id=c.user_id
      JOIN bot_registrations b ON b.conversation_id=c.id
      JOIN business_bot_members m ON m.conversation_id=c.id AND m.team_id=c.business_team_id
      JOIN business_teams t ON t.id=c.business_team_id
      WHERE c.id=? AND c.user_id=? AND c.business_team_id=? AND c.archived=0 AND b.active=1
      AND u.status='active' AND t.owner_id=u.id`).get(caller.conversationId, caller.userId, f.businessId);
    if (!row) deny('QBO_EXECUTOR_ACCESS_REVOKED');
    return f;
  }
  function existing(c: Caller, key: string) {
    return db.prepare('SELECT * FROM qbo_operation_reservations WHERE executor_id=? AND request_key=?').get(c.conversationId, key) as Row | undefined;
  }
  function response(row: Row, first = false) {
    return { execute: false as const, refreshEntitlement: first, operationEntitlement: first, retryAllowed: false as const, reservation: reservationSchema.parse(JSON.parse(row.reservation_json)) };
  }
  function own(c: Caller, row: Row) {
    if (row.executor_id !== c.conversationId || row.actor_user_id !== c.userId) deny('QBO_ORIGINAL_CALLER_REQUIRED');
  }
  return {
    inspect(authenticate: () => Caller, raw: unknown) {
      const p = requestSchema.parse(raw), c = authenticate(), f = facts(c, p);
      return { execute: false, refreshEntitlement: false, operationEntitlement: false, retryAllowed: false,
        authenticatedCaller: c, factsHash: canonicalSha256(f), scopeHash: H('qbo/operation/v1', p.operation),
        assignmentRevision: f.assignmentRevision, authorityRevision: f.authorityRevision };
    },
    admit(authenticate: () => Caller, raw: unknown) {
      const p = requestSchema.parse(raw), requestHash = H('qbo/request/v1', p);
      return db.transaction(() => {
        const c = authenticate(), old = existing(c, p.requestKey);
        if (old) { own(c, old); if (old.request_hash !== requestHash) deny('QBO_REQUEST_CONFLICT'); return response(old); }
        const f = facts(c, p), digest = effectDigest(f), scopeHash = H('qbo/operation/v1', p.operation);
        if (db.prepare('SELECT 1 FROM qbo_operation_reservations WHERE effect_digest=?').get(digest)) deny('QBO_OPERATION_PERMANENTLY_RESERVED');
        const observed = now(), id = crypto.randomUUID();
        const reservation = reservationSchema.parse({ schemaVersion: 'qbo-admission/v1', reservationId: id, requestKey: p.requestKey,
          authenticatedCaller: c, originalExecutor: f.executorConversationId, jobId: f.jobId,
          assignmentRevision: f.assignmentRevision, authorityRef: f.authorityRef, authorityRevision: f.authorityRevision,
          businessId: f.businessId, accountRef: f.accountRef, existingGrantRef: f.existingGrantRef, companyRealm: f.companyRealm,
          effectDigest: digest, scopeHash, factsHash: canonicalSha256(f), audience: p.audience,
          reservedAt: new Date(observed).toISOString(), expiresAt: new Date(Math.min(observed + 15000, Date.parse(c.sessionExpiresAt), Date.parse(f.expiresAt), Date.parse(f.integration.expiresAt))).toISOString() });
        if (Date.parse(reservation.expiresAt) <= observed) deny('QBO_SCOPE_EXPIRED');
        db.prepare('INSERT INTO qbo_operation_reservations VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, digest, c.userId, c.conversationId, p.requestKey, requestHash, f.jobId, scopeHash, canonicalSha256(f), JSON.stringify(reservation));
        return response(existing(c, p.requestKey)!, true);
      }).immediate();
    },
    read(authenticate: () => Caller, raw: unknown) {
      const p = lookupSchema.parse(raw), c = authenticate(), row = existing(c, p.requestKey);
      if (!row) return { execute: false, refreshEntitlement: false, operationEntitlement: false, retryAllowed: false, status: 'ABSENT' };
      own(c, row);
      const receipts = db.prepare('SELECT receipt_json FROM qbo_operation_receipts WHERE reservation_id=? ORDER BY rowid LIMIT 101').all(row.id) as { receipt_json: string }[];
      if (receipts.length > 100) deny('QBO_RECEIPT_HISTORY_EXCEEDS_BOUND');
      return { ...response(row), status: 'RESERVED', receipts: receipts.map(x => JSON.parse(x.receipt_json)) };
    },
    async reconcile(authenticate: () => Caller, raw: unknown) {
      const p = lookupSchema.parse(raw), c = authenticate(), row = existing(c, p.requestKey);
      if (!row) deny('QBO_RESERVATION_NOT_FOUND');
      own(c, row);
      const reservation = reservationSchema.parse(JSON.parse(row.reservation_json));
      const receipt = sourceReceiptSchema.parse(await resolver.receipt(c, reservation));
      if (receipt.reservationId !== row.id || receipt.scopeHash !== reservation.scopeHash || receipt.effectDigest !== reservation.effectDigest || Date.parse(receipt.recordedAt) < Date.parse(reservation.reservedAt) || Date.parse(receipt.recordedAt) > now()) deny('QBO_RECEIPT_SCOPE_MISMATCH');
      return db.transaction(() => {
        if (!same(authenticate(), c)) deny('QBO_CALLER_CHANGED');
        const receiptHash = H('qbo/receipt/v1', receipt), old = db.prepare('SELECT receipt_hash FROM qbo_operation_receipts WHERE id=?').get(receipt.receiptId) as { receipt_hash: string } | undefined;
        if (old && old.receipt_hash !== receiptHash) deny('QBO_RECEIPT_CONFLICT');
        // An immutable receipt replay acknowledges history, not a new outcome.
        // Authentication and exact reservation correlation still precede this return.
        if (old) return { ...response(row), receipt };
        const history = db.prepare('SELECT receipt_json FROM qbo_operation_receipts WHERE reservation_id=? ORDER BY rowid LIMIT 101').all(row.id) as {receipt_json:string}[];
        if (!old && history.length >= 100) deny('QBO_RECEIPT_HISTORY_EXCEEDS_BOUND');
        for (const previous of history) {
          const value = sourceReceiptSchema.parse(JSON.parse(previous.receipt_json));
          if (value.outcome !== 'UNKNOWN' && (value.outcome !== receipt.outcome || value.evidenceHash !== receipt.evidenceHash || !same(value.providerEvidence,receipt.providerEvidence))) deny('QBO_TERMINAL_RECEIPT_CONFLICT');
        }
        db.prepare('INSERT OR IGNORE INTO qbo_operation_receipts VALUES(?,?,?,?)').run(receipt.receiptId, row.id, receiptHash, JSON.stringify(receipt));
        return { ...response(row), receipt };
      }).immediate();
    },
  };
}
