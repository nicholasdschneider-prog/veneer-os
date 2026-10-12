import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { NextFunction, Request, Response } from 'express';

/**
 * Idempotency-Key on James's POSTs. The first request with a key runs and its
 * response is stored; a retry with the same key and body gets that stored
 * response and posts nothing. The same key with a different body is a 409.
 * Server errors (5xx) are not stored, so the retry runs again.
 */

export const IDEMPOTENCY_RETENTION_DAYS = 30;
const KEY = /^[\x21-\x7e]{8,200}$/;

export function idempotency(db: Database.Database) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST') { next(); return; }
    const key = req.get('idempotency-key')?.trim();
    if (!key) { next(); return; }
    if (!KEY.test(key)) { res.status(400).json({ ok: false, error: 'Idempotency-Key must be 8-200 printable characters' }); return; }
    const route = `${req.method} ${req.baseUrl}${req.path}`;
    const hash = crypto.createHash('sha256').update(`${route}\n${JSON.stringify(req.body ?? null)}`).digest('hex');
    const inserted = db.prepare('INSERT OR IGNORE INTO james_idempotency (key, route, request_hash) VALUES (?, ?, ?)').run(key, route, hash).changes > 0;
    if (!inserted) {
      const row = db.prepare('SELECT request_hash, status, response_json FROM james_idempotency WHERE key = ?').get(key) as
        { request_hash: string; status: number; response_json: string | null };
      if (row.request_hash !== hash) { res.status(409).json({ ok: false, error: 'idempotency_conflict', detail: 'This Idempotency-Key was used with a different request.' }); return; }
      if (!row.status || row.response_json === null) { res.status(409).json({ ok: false, error: 'idempotency_in_progress' }); return; }
      res.set('Idempotent-Replay', 'true').status(row.status).type('application/json').send(row.response_json);
      return;
    }
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 500) db.prepare('DELETE FROM james_idempotency WHERE key = ?').run(key);
      else db.prepare('UPDATE james_idempotency SET status = ?, response_json = ? WHERE key = ?').run(res.statusCode, JSON.stringify(body), key);
      return json(body);
    };
    // A response that never went through res.json (a crash) must not leave the key stuck as in progress.
    res.on('finish', () => {
      db.prepare('DELETE FROM james_idempotency WHERE key = ? AND status = 0').run(key);
    });
    next();
  };
}

export function pruneIdempotency(db: Database.Database, nowMs = Date.now()) {
  db.prepare('DELETE FROM james_idempotency WHERE created_at < ?')
    .run(new Date(nowMs - IDEMPOTENCY_RETENTION_DAYS * 86_400_000).toISOString());
}
