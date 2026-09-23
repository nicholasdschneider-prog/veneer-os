import type Database from 'better-sqlite3';
export function finishVoiceSession(
  db: Database.Database,
  id: string,
  now: number,
  outcome = 'ended',
) {
  db.prepare(
    'UPDATE voice_sessions SET ended_ms=?,outcome=? WHERE id=? AND ended_ms IS NULL',
  ).run(now, outcome, id);
}
export function listVoiceSessions(
  db: Database.Database,
  userId: number,
  conversationId: string,
  before?: { time: number; id: string },
) {
  return db
    .prepare(
      `SELECT id,started_ms,connected_ms,ended_ms,outcome,
    CASE WHEN connected_ms IS NULL THEN 0 ELSE max(0,ended_ms-connected_ms) END AS duration_ms
    FROM voice_sessions WHERE user_id=? AND conversation_id=? AND ended_ms IS NOT NULL
    AND (? IS NULL OR started_ms<? OR (started_ms=? AND id<?))
    ORDER BY started_ms DESC,id DESC LIMIT 50`,
    )
    .all(
      userId,
      conversationId,
      before?.time ?? null,
      before?.time ?? null,
      before?.time ?? null,
      before?.id ?? null,
    );
}
