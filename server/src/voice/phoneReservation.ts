import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

/** All phone entry points share a durable destination/user lock. No stale lease reaper. */
export function phoneBusy(db: Database.Database, userId: number, phone?: string) {
  return !!db.prepare('SELECT 1 FROM phone_call_locks WHERE user_id=? OR phone=?').get(userId, phone ?? '')
    || !!db.prepare('SELECT 1 FROM calendar_phone_lock').get();
}
export function reservePhone(db: Database.Database, userId: number, to: string, decisionId: string | null, now = Date.now(), calendarAttemptId?: string) {
  return db.transaction(() => {
    const ownCalendar = calendarAttemptId && db.prepare('SELECT 1 FROM calendar_phone_lock l JOIN calendar_phone_attempts a ON a.id=l.attempt_id WHERE a.id=? AND a.user_id=?').get(calendarAttemptId,userId);
    if (db.prepare('SELECT 1 FROM phone_call_locks WHERE user_id=? OR phone=?').get(userId,to) || (!ownCalendar && db.prepare('SELECT 1 FROM calendar_phone_lock').get())) throw new Error('A phone call is already reserved or its outcome is unknown.');
    // Legacy in-flight calls have no retained destination. Do not guess one or erase them.
    if (db.prepare('SELECT 1 FROM bot_phone_calls WHERE ended_ms IS NULL AND to_phone IS NULL').get()) throw new Error('An earlier phone call needs read-only reconciliation.');
    const id = randomUUID();
    db.prepare('INSERT INTO bot_phone_calls(id,user_id,decision_id,started_ms,to_phone) VALUES(?,?,?,?,?)').run(id,userId,decisionId,now,to);
    db.prepare("INSERT INTO phone_call_locks VALUES(?,?,?,'RESERVED')").run(to,userId,id);
    return id;
  }).immediate();
}
/** Internal LiveVoice start validates an existing reservation, never a caller-supplied destination. */
export function ensurePhoneReservation(db: Database.Database, userId: number, to: string, logId: string) {
  db.transaction(() => {
    const row = db.prepare('SELECT user_id,to_phone,provider_sid,ended_ms FROM bot_phone_calls WHERE id=?').get(logId) as {user_id:number;to_phone:string|null;provider_sid:string|null;ended_ms:number|null}|undefined;
    if (!row || row.user_id !== userId || row.ended_ms !== null || row.provider_sid || (row.to_phone !== null && row.to_phone !== to)) throw new Error('Phone reservation scope changed.');
    const lock = db.prepare('SELECT log_id,phase FROM phone_call_locks WHERE user_id=? OR phone=?').get(userId,to) as {log_id:string;phase:string}|undefined;
    if (lock && (lock.log_id !== logId || lock.phase !== 'RESERVED')) throw new Error('Phone attempt is already reserved or consumed.');
    if (!lock) {
      if (db.prepare('SELECT 1 FROM calendar_phone_lock').get()) throw new Error('A calendar phone attempt needs reconciliation.');
      db.prepare("INSERT INTO phone_call_locks VALUES(?,?,?,'RESERVED')").run(to,userId,logId);
      db.prepare('UPDATE bot_phone_calls SET to_phone=? WHERE id=?').run(to,logId);
    }
  }).immediate();
}
/** Safe release only when provider entry was never reached. */
export function releaseUnstartedPhone(db: Database.Database, logId: string) {
  db.prepare("DELETE FROM phone_call_locks WHERE log_id=? AND phase='RESERVED'").run(logId);
}
export function markPhoneDispatch(db: Database.Database, logId: string) {
  if (!db.prepare("UPDATE phone_call_locks SET phase='UNKNOWN' WHERE log_id=? AND phase='RESERVED'").run(logId).changes) throw new Error('Phone reservation was already consumed.');
}
export function markPhoneAccepted(db: Database.Database, logId: string) {
  db.prepare("UPDATE phone_call_locks SET phase='ACCEPTED' WHERE log_id=? AND phase='UNKNOWN'").run(logId);
}
/** Called only after authenticated status readback for this exact original provider SID. */
export function releaseEndedPhone(db: Database.Database, logId: string, providerId: string) {
  db.prepare('DELETE FROM phone_call_locks WHERE log_id=? AND EXISTS(SELECT 1 FROM bot_phone_calls WHERE id=? AND provider_sid=?)').run(logId,logId,providerId);
}
