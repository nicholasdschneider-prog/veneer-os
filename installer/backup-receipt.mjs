#!/usr/bin/env node
// Verified receipt for an online DB backup, and the freshness check that binds
// it to a release activation. This never takes, retries or restores a backup:
// the operator takes one (REPORT section 5 method) and then records a receipt.
//
//   node installer/backup-receipt.mjs <backup.db>     # writes <backup.db>.receipt.json
//
// An activation refuses (`refused_stale_backup`) when the receipt is missing,
// does not match the file it describes, did not verify, or the backup is older
// than 15 minutes at the moment of committing to activate.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_BACKUP_AGE_MS = 15 * 60 * 1000;
const SCHEMA = 'veneer-backup-receipt/v1';

export class StaleBackupError extends Error {
  constructor(message) { super(message); this.code = 'refused_stale_backup'; }
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/**
 * Verifies a backup read-only (immutable open: integrity_check and
 * foreign_key_check) and records it. taken_at is the file's birth time, the
 * start of the backup, so its age is never understated.
 */
export function createReceipt(backupPath, { now = new Date(), sqliteBin = '/usr/bin/sqlite3' } = {}) {
  const file = path.resolve(backupPath);
  const stat = fs.statSync(file);
  // The system sqlite3 opens the copy immutable: no -wal/-shm beside it, no writes.
  const sql = (query) => execFileSync(sqliteBin, ['-readonly', `file:${file}?immutable=1`, query], { encoding: 'utf8' }).trim();
  const integrity = sql('pragma integrity_check;').split('\n')[0];
  const fk = Number(sql('select count(*) from pragma_foreign_key_check;'));
  return {
    schema: SCHEMA,
    path: file,
    size: stat.size,
    sha256: sha256File(file),
    taken_at: new Date(Math.min(stat.birthtimeMs || stat.mtimeMs, stat.mtimeMs)).toISOString(),
    integrity_check: integrity,
    foreign_key_violations: fk,
    verified_at: now.toISOString(),
  };
}

/** Reads and binds a receipt: what an arm records and later re-verifies. */
export function bindReceipt(receiptPath) {
  let text;
  try { text = fs.readFileSync(receiptPath, 'utf8'); } catch { throw new StaleBackupError(`backup receipt ${receiptPath} is missing`); }
  const receipt = JSON.parse(text);
  if (receipt.schema !== SCHEMA) throw new StaleBackupError('backup receipt has an unknown format');
  return { receipt_path: path.resolve(receiptPath), receipt_sha256: crypto.createHash('sha256').update(text).digest('hex'), backup_path: receipt.path, backup_sha256: receipt.sha256, taken_at: receipt.taken_at };
}

/**
 * Throws StaleBackupError unless the bound receipt is unchanged, verified ok,
 * still describes the file on disk byte-for-byte, and is at most 15 min old.
 * `rehash:false` skips re-hashing a large file when it was just verified.
 */
export function assertFreshBackup(bound, { now = new Date(), rehash = true, hashFile = sha256File } = {}) {
  if (!bound) throw new StaleBackupError('no backup receipt is bound');
  const current = bindReceipt(bound.receipt_path);
  if (current.receipt_sha256 !== bound.receipt_sha256) throw new StaleBackupError('the backup receipt changed since it was bound');
  const receipt = JSON.parse(fs.readFileSync(bound.receipt_path, 'utf8'));
  if (receipt.integrity_check !== 'ok' || receipt.foreign_key_violations !== 0) throw new StaleBackupError(`the backup did not verify (integrity ${receipt.integrity_check}, FK ${receipt.foreign_key_violations})`);
  if (!fs.existsSync(receipt.path)) throw new StaleBackupError(`backup file ${receipt.path} is missing`);
  if (fs.statSync(receipt.path).size !== receipt.size) throw new StaleBackupError('the backup file size differs from its receipt');
  if (rehash && hashFile(receipt.path) !== receipt.sha256) throw new StaleBackupError('the backup file hash differs from its receipt');
  const age = now.getTime() - Date.parse(receipt.taken_at);
  if (!(age >= 0) || age > MAX_BACKUP_AGE_MS) throw new StaleBackupError(`the backup taken at ${receipt.taken_at} is ${Math.round(age / 60000)} min old; at most 15 min is allowed. Take a fresh backup and re-arm.`);
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const backup = process.argv[2];
  if (!backup) { console.error('usage: backup-receipt.mjs <backup.db>'); process.exit(2); }
  const receipt = createReceipt(backup);
  const out = `${path.resolve(backup)}.receipt.json`;
  fs.writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`[backup] receipt ${out}: integrity ${receipt.integrity_check}, FK ${receipt.foreign_key_violations}, sha256 ${receipt.sha256}, taken ${receipt.taken_at}`);
  if (receipt.integrity_check !== 'ok' || receipt.foreign_key_violations !== 0) process.exit(1);
}
