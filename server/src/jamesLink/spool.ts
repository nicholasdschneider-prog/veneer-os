import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';

/**
 * The ERVP side of the daily digest (contract out/build823/digest-contract.md,
 * revision 4). ERVP hard-links items into $DATA_DIR/james-digest/inbox; this
 * module validates them, stores them in james_digest_items, writes a receipt
 * ERVP reads back, and moves the file to ingested/ or rejected/. Every step is
 * repeatable, so a crash at any point causes neither a duplicate nor a loss.
 * Files other than <64 hex>.json (ERVP's .pending-* staging names) and the
 * directories ERVP owns (originals/, urgent/, tmp/) are never touched.
 */

export const SPOOL_SUBDIRS = ['inbox', 'tmp', 'ingested', 'rejected', 'receipts'] as const;
export const CONTRACT_CHECK_SOURCE = 'ervp/contract-check';
const ITEM_FILE = /^[0-9a-f]{64}\.json$/;
const MAX_PER_TICK = 500;
const ET_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ReceiptState = 'ingested' | 'digested' | 'digest_unknown' | 'rejected';

export const spoolKey = (source: string, idempotencyKey: string) =>
  crypto.createHash('sha256').update(`${source}\n${idempotencyKey}`).digest('hex');

const Immediate = z.object({
  status: z.enum(['sent', 'fallback', 'failed', 'unknown']),
  to: z.string().min(1).max(320),
  message_id: z.string().min(1).max(500).nullable(),
});

const Evidence = z.union([
  z.string().trim().min(1),
  z.array(z.union([z.string(), z.number()])).min(1),
]).refine((value) => JSON.stringify(value).length <= 2000, 'evidence is longer than 2000 characters');

const Item = z.object({
  version: z.literal(1),
  source: z.string().regex(/^ervp\/[A-Za-z0-9._-]{1,100}$/, 'source must be ervp/<workflow>'),
  idempotency_key: z.string().regex(/^[\x21-\x7e]{8,200}$/, 'idempotency_key must be 8-200 printable characters'),
  created_at: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'created_at must be an ISO time'),
  category: z.enum(['change_alert', 'build_completion', 'heartbeat', 'other']),
  subject: z.string().trim().min(1).max(200),
  body: z.string().max(4000),
  urgent: z.enum(['money', 'customer']).nullable(),
  needs_nick_today: z.boolean(),
  needed_on: z.string().regex(ET_DATE, 'needed_on must be an ET date YYYY-MM-DD').nullable(),
  reason: z.string().trim().min(1).max(500).nullable(),
  evidence: Evidence.nullable(),
  immediate: Immediate.nullable(),
}).superRefine((item, ctx) => {
  const fields = ['needed_on', 'reason', 'evidence', 'immediate'] as const;
  if (item.urgent) {
    if (!item.needs_nick_today) ctx.addIssue({ code: 'custom', message: 'urgent requires needs_nick_today true' });
    for (const f of fields) if (item[f] === null) ctx.addIssue({ code: 'custom', message: `urgent requires ${f}` });
  } else {
    if (item.needs_nick_today) ctx.addIssue({ code: 'custom', message: 'needs_nick_today must be false when urgent is null' });
    for (const f of fields) if (item[f] !== null) ctx.addIssue({ code: 'custom', message: `${f} must be null when urgent is null` });
  }
});
export type SpoolItem = z.infer<typeof Item>;

export function validateItem(raw: string, fileKey: string): { ok: true; item: SpoolItem } | { ok: false; reason: string } {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { ok: false, reason: 'not valid JSON' }; }
  const parsed = Item.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join('.') || 'item'}: ${i.message}`).join('; ').slice(0, 1000) };
  }
  const expected = spoolKey(parsed.data.source, parsed.data.idempotency_key);
  if (expected !== fileKey) return { ok: false, reason: `file name ${fileKey} is not sha256(source + "\\n" + idempotency_key) ${expected}` };
  return { ok: true, item: parsed.data };
}

/** Atomic small-file write: a temp file in the same directory, then rename. */
function writeAtomic(file: string, content: string, flag: 'w' | 'wx' = 'w') {
  if (flag === 'wx') { fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 }); return; }
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function writeReceipt(dir: string, key: string, receipt: { state: ReceiptState; reason?: string | null; digest_date?: string | null; message_id?: string | null }, nowIso: string) {
  writeAtomic(path.join(dir, 'receipts', `${key}.json`), `${JSON.stringify({
    key, state: receipt.state, reason: receipt.reason ?? null, digest_date: receipt.digest_date ?? null, message_id: receipt.message_id ?? null, updated_at: nowIso,
  })}\n`);
}

export function ensureSpoolDirs(dir: string) {
  for (const sub of SPOOL_SUBDIRS) fs.mkdirSync(path.join(dir, sub), { recursive: true });
}

export interface ImportResult { ingested: number; duplicate: number; rejected: number }

/** One pass over inbox/: store, receipt, then move each item. Synchronous so it can run inside a transaction. */
export function importSpool(db: Database.Database, dir: string, nowIso: string): ImportResult {
  const result: ImportResult = { ingested: 0, duplicate: 0, rejected: 0 };
  const inbox = path.join(dir, 'inbox');
  let names: string[];
  try { names = fs.readdirSync(inbox).filter((n) => ITEM_FILE.test(n)).sort().slice(0, MAX_PER_TICK); } catch { return result; }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO james_digest_items
       (key, source, idempotency_key, created_at, category, subject, body, urgent, needs_nick_today, needed_on, reason, evidence_json, immediate_json, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const stored = db.prepare('SELECT state, digest_date, message_id FROM james_digest_items WHERE key = ?');
  for (const name of names) {
    const key = name.slice(0, -'.json'.length);
    const file = path.join(inbox, name);
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const checked = validateItem(raw, key);
    if (!checked.ok) {
      fs.writeFileSync(path.join(dir, 'rejected', `${key}.err`), `${checked.reason}\n`, { mode: 0o600 });
      db.prepare('INSERT OR IGNORE INTO james_digest_rejections (key, reason, rejected_at) VALUES (?, ?, ?)').run(key, checked.reason, nowIso);
      writeReceipt(dir, key, { state: 'rejected', reason: checked.reason }, nowIso);
      fs.renameSync(file, path.join(dir, 'rejected', name));
      result.rejected += 1;
      continue;
    }
    const i = checked.item;
    const changes = insert.run(
      key, i.source, i.idempotency_key, i.created_at, i.category, i.subject, i.body, i.urgent, i.needs_nick_today ? 1 : 0, i.needed_on, i.reason,
      i.evidence === null ? null : JSON.stringify(i.evidence), i.immediate === null ? null : JSON.stringify(i.immediate), nowIso,
    ).changes;
    if (changes) result.ingested += 1; else result.duplicate += 1;
    // A re-ingested item keeps whatever state it already reached.
    const row = stored.get(key) as { state: 'ingested' | 'digested' | 'digest_unknown'; digest_date: string | null; message_id: string | null };
    writeReceipt(dir, key, { state: row.state, digest_date: row.state === 'ingested' ? null : row.digest_date, message_id: row.message_id }, nowIso);
    fs.renameSync(file, path.join(dir, 'ingested', name));
  }
  return result;
}

class SelfCheckRollback extends Error {}

/**
 * Startup self-check before NATIVE_READY: in a throwaway spool, one valid item
 * must be ingested and receipted, and one invalid item rejected with a reason.
 * The database writes are rolled back.
 */
export function spoolSelfCheck(db: Database.Database, nowIso: string): { ok: true } | { ok: false; error: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'james-digest-selfcheck-'));
  try {
    ensureSpoolDirs(dir);
    const good = { version: 1, source: CONTRACT_CHECK_SOURCE, idempotency_key: `native-self-check-${crypto.randomUUID()}`, created_at: nowIso,
      category: 'other', subject: 'self-check', body: 'self-check', urgent: null, needs_nick_today: false, needed_on: null, reason: null, evidence: null, immediate: null };
    const goodKey = spoolKey(good.source, good.idempotency_key);
    const badKey = spoolKey(CONTRACT_CHECK_SOURCE, 'native-self-check-bad');
    fs.writeFileSync(path.join(dir, 'inbox', `${goodKey}.json`), JSON.stringify(good));
    fs.writeFileSync(path.join(dir, 'inbox', `${badKey}.json`), JSON.stringify({ ...good, urgent: 'money' }));
    let outcome: { ok: true } | { ok: false; error: string } = { ok: false, error: 'self-check did not run' };
    try {
      db.transaction(() => {
        const counts = importSpool(db, dir, nowIso);
        const receipt = (key: string) => JSON.parse(fs.readFileSync(path.join(dir, 'receipts', `${key}.json`), 'utf8')) as { state: string; reason: string | null };
        const ok = counts.ingested === 1 && counts.rejected === 1
          && receipt(goodKey).state === 'ingested' && fs.existsSync(path.join(dir, 'ingested', `${goodKey}.json`))
          && receipt(badKey).state === 'rejected' && !!receipt(badKey).reason && fs.existsSync(path.join(dir, 'rejected', `${badKey}.err`))
          && fs.readdirSync(path.join(dir, 'inbox')).length === 0;
        outcome = ok ? { ok: true } : { ok: false, error: `unexpected self-check result ${JSON.stringify(counts)}` };
        throw new SelfCheckRollback();
      })();
    } catch (err) {
      if (!(err instanceof SelfCheckRollback)) outcome = { ok: false, error: (err as Error).message };
    }
    return outcome;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function writeNativeReady(dir: string, commit: string | null, nowIso: string) {
  writeAtomic(path.join(dir, 'NATIVE_READY'), `${JSON.stringify({ version: 1, build: 827, commit, at: nowIso })}\n`);
}

/** ACTIVE as written by native; null when absent or unreadable (then the pre-cutover behavior applies). */
export function readActive(dir: string): { first_digest_date: string } | null {
  const active = readJsonFile(path.join(dir, 'ACTIVE'));
  return active && active.version === 1 && typeof active.first_digest_date === 'string' && ET_DATE.test(active.first_digest_date)
    ? { first_digest_date: active.first_digest_date } : null;
}

/**
 * The cutover gate. Native writes ACTIVE only when its own self-check passed
 * (NATIVE_READY), ERVP_ADAPTER_READY says the ERVP heartbeat is buffer-only
 * with its email disabled, and CUTOVER_ACCEPTED exists. CUTOVER_ACCEPTED is
 * created by the human-approved cutover step after both owners record
 * acceptance in the coordination thread; native never creates it. It is
 * consumed (renamed to CUTOVER_ACCEPTED.applied-<time>) when ACTIVE is
 * written, so deleting ACTIVE is a complete rollback.
 */
export function maybeActivate(dir: string, nativeReady: boolean, firstDigestDate: string, nowIso: string): { activated: boolean; waiting?: string } {
  if (fs.existsSync(path.join(dir, 'ACTIVE'))) return { activated: false, waiting: 'already_active' };
  if (!nativeReady || !fs.existsSync(path.join(dir, 'NATIVE_READY'))) return { activated: false, waiting: 'native_ready' };
  const adapter = readJsonFile(path.join(dir, 'ERVP_ADAPTER_READY'));
  if (!adapter || adapter.version !== 1 || adapter.heartbeat_email_disabled !== true || adapter.heartbeat_task_mode !== 'buffer_only') {
    return { activated: false, waiting: 'ervp_adapter_ready' };
  }
  const accepted = readJsonFile(path.join(dir, 'CUTOVER_ACCEPTED'));
  if (!accepted || accepted.version !== 1 || typeof accepted.coordination_thread !== 'string' || !accepted.coordination_thread) {
    return { activated: false, waiting: 'cutover_accepted' };
  }
  try {
    writeAtomic(path.join(dir, 'ACTIVE'), `${JSON.stringify({ version: 1, first_digest_date: firstDigestDate, at: nowIso, accepted })}\n`, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { activated: false, waiting: 'already_active' };
    throw err;
  }
  fs.renameSync(path.join(dir, 'CUTOVER_ACCEPTED'), path.join(dir, `CUTOVER_ACCEPTED.applied-${nowIso.replace(/[:.]/g, '')}`));
  return { activated: true };
}
