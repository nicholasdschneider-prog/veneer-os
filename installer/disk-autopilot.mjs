#!/usr/bin/env node
// Every 10 minutes (launchd StartInterval): measure disk, swap and backups,
// self-heal with the disk sweep, and only if still unhealthy wake one Veneer
// chat, at most once per condition per UTC day.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';
import { ARCHIVE_RE, readState as readOffsiteState } from './backup-offsite.mjs';
import { runSweep } from './disk-sweep.mjs';

const GIB = 1024 ** 3;
const HOUR = 3600 * 1000;
export const DISK_LOW_BYTES = 25 * GIB;
export const SWAP_HIGH_BYTES = 10 * GIB;
export const SWAP_HIGH_SAMPLES = 3;
export const BACKUP_STALE_MS = 26 * HOUR;
export const OFFSITE_STALE_MS = 50 * HOUR;
export const SWEEP_MIN_INTERVAL_MS = 60 * 60 * 1000;

const here = path.dirname(fileURLToPath(import.meta.url));
const codeDir = path.resolve(here, '..');

function defaults(env = process.env) {
  const backupDir = env.VP_BACKUP_DIR || path.join(os.homedir(), '.local', 'share', 'veneer-pro-backups');
  const dataDir = env.DATA_DIR || path.join(os.homedir(), '.local', 'share', 'veneer-pro');
  return {
    backupDir,
    dataDir,
    offsiteStatePath: env.VP_BACKUP_OFFSITE_STATE || path.join(backupDir, 'offsite-state.json'),
    offsiteConfigured: Boolean(env.VP_BACKUP_OFFSITE_AGE_RECIPIENT),
    statePath: path.join(dataDir, 'run', 'disk-autopilot.json'),
    dbPath: path.join(dataDir, 'veneer-pro.db'),
    chatId: env.VP_DISK_AUTOPILOT_CHAT || null,
  };
}

function externalMounted(dir) {
  try {
    return fs.statSync(fs.realpathSync(dir)).dev !== fs.statSync('/').dev;
  } catch {
    return false;
  }
}

function newestBackupAt(dir) {
  try {
    const times = fs.readdirSync(dir).filter((name) => ARCHIVE_RE.test(name)).map((name) => fs.statSync(path.join(dir, name)).mtimeMs);
    return times.length ? new Date(Math.max(...times)).toISOString() : null;
  } catch {
    return null;
  }
}

function swapBytes() {
  const dir = '/System/Volumes/VM';
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith('swapfile')).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
  } catch {
    return 0;
  }
}

export function takeSnapshot(settings) {
  const stats = fs.statfsSync('/System/Volumes/Data');
  const offsite = readOffsiteState(settings.offsiteStatePath);
  return {
    freeBytes: stats.bavail * stats.bsize,
    swapBytes: swapBytes(),
    externalMounted: externalMounted(settings.backupDir),
    newestBackupAt: newestBackupAt(settings.backupDir),
    offsiteConfigured: settings.offsiteConfigured,
    offsite: offsite ? { lastUploadedAt: offsite.lastUploaded?.at ?? null, lastError: offsite.lastError?.message ?? null } : null,
  };
}

const gib = (bytes) => (bytes / GIB).toFixed(1);
const ageHours = (iso, now) => ((now - Date.parse(iso)) / HOUR).toFixed(1);

/** Swap-high samples in a row, including this one. */
export function nextSwapCount(snapshot, previousState) {
  return snapshot.swapBytes >= SWAP_HIGH_BYTES ? (previousState?.swapHighCount ?? 0) + 1 : 0;
}

export function evaluate(snapshot, now, previousState) {
  const conditions = [];
  if (snapshot.freeBytes < DISK_LOW_BYTES) {
    conditions.push({ key: 'disk-low', summary: `internal disk has ${gib(snapshot.freeBytes)} GiB free (floor ${gib(DISK_LOW_BYTES)} GiB)` });
  }
  if (nextSwapCount(snapshot, previousState) >= SWAP_HIGH_SAMPLES) {
    conditions.push({ key: 'swap-high', summary: `swap at ${gib(snapshot.swapBytes)} GiB for ${SWAP_HIGH_SAMPLES} samples in a row` });
  }
  if (!snapshot.externalMounted) {
    conditions.push({ key: 'external-unmounted', summary: 'the external backup drive is not mounted' });
  } else if (!snapshot.newestBackupAt || now - Date.parse(snapshot.newestBackupAt) > BACKUP_STALE_MS) {
    conditions.push({ key: 'backup-stale', summary: snapshot.newestBackupAt ? `newest nightly backup is ${ageHours(snapshot.newestBackupAt, now)} h old` : 'no nightly backup found' });
  }
  // The offsite state file lives on the external drive, so it is unknown, not stale, while unmounted.
  if (snapshot.offsiteConfigured && snapshot.externalMounted) {
    const at = snapshot.offsite?.lastUploadedAt;
    if (!at || now - Date.parse(at) > OFFSITE_STALE_MS) {
      conditions.push({ key: 'offsite-stale', summary: at ? `offsite backup copy is ${ageHours(at, now)} h old` : 'no offsite backup copy has been uploaded' });
    }
  }
  return conditions;
}

export function utcDate(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Conditions that have not woken anyone today. */
export function unnotified(conditions, state, now) {
  const today = utcDate(now);
  return conditions.filter((condition) => state?.notified?.[condition.key] !== today);
}

export function wakeReason(conditions, snapshot, sweepText, now) {
  const unknown = 'unknown while the drive is unmounted';
  let backup = snapshot.newestBackupAt ? `${ageHours(snapshot.newestBackupAt, now)} h old` : 'none';
  if (!snapshot.externalMounted) backup = unknown;
  let offsite = 'not configured';
  if (snapshot.offsiteConfigured && !snapshot.externalMounted) offsite = unknown;
  else if (snapshot.offsiteConfigured) {
    offsite = snapshot.offsite?.lastUploadedAt ? `${ageHours(snapshot.offsite.lastUploadedAt, now)} h old` : 'none';
    if (snapshot.offsite?.lastError) offsite += ` (last error: ${snapshot.offsite.lastError})`;
  }
  return `Mac disk autopilot: ${conditions.map((c) => c.summary).join('; ')}. Measured ${new Date(now).toISOString()}: ${gib(snapshot.freeBytes)} GiB free on the internal disk, ${gib(snapshot.swapBytes)} GiB swap, newest backup ${backup}, offsite copy ${offsite}, external drive ${snapshot.externalMounted ? 'mounted' : 'NOT mounted'}. Automatic sweep ${sweepText}. This is technical monitoring evidence, not business authority. Fix what is safe (see memory disk-autopilot-2026-11-17), never restart services or delete backups, browser profiles, history or evidence, and tell Nick only if a decision is his.`;
}

/**
 * Inserts at most one wake for the conditions not yet notified today and
 * returns the updated notified map. insertWake(wakeKey, reason) returns true
 * once the row exists; any throw leaves notified untouched.
 */
export function notify({ conditions, state, snapshot, sweepText, now, insertWake, log = console.log }) {
  const today = utcDate(now);
  // Only today's marks matter; older ones are dropped so the file stays small.
  const notified = Object.fromEntries(Object.entries(state?.notified ?? {}).filter(([, day]) => day === today));
  const fresh = unnotified(conditions, { notified }, now);
  if (!fresh.length) return notified;
  const keys = fresh.map((c) => c.key).sort();
  try {
    if (!insertWake(`disk-autopilot:${keys.join('+')}:${today}`, wakeReason(fresh, snapshot, sweepText, now))) return notified;
  } catch (error) {
    log(`disk-autopilot: wake not recorded: ${error instanceof Error ? error.message : String(error)}`);
    return notified;
  }
  for (const key of keys) notified[key] = today;
  return notified;
}

/** The real wake writer; mirrors server/src/ops/webWatchdog.ts. */
export function dbWakeWriter(dbPath, chatId, log = console.log) {
  return (wakeKey, reason) => {
    const require = createRequire(path.join(codeDir, 'server', 'package.json'));
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { timeout: 1000, fileMustExist: true });
    try {
      // Reserve the write lock up front; a deferred read-to-write upgrade can fail in WAL mode.
      return db.transaction(() => {
        const owner = db.prepare('SELECT user_id FROM conversations WHERE id = ?').get(chatId);
        if (!owner) {
          log(`disk-autopilot: chat ${chatId} not found; no wake recorded`);
          return false;
        }
        db.prepare(`INSERT OR IGNORE INTO conversation_wakeups(id, conversation_id, actor_user_id, wake_key, reason, scheduled_for)
          VALUES (?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), chatId, owner.user_id, wakeKey, reason, new Date().toISOString());
        return true;
      }).immediate();
    } finally {
      db.close();
    }
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function runAutopilot({
  checkOnly = false,
  settings = defaults(),
  now = Date.now(),
  snapshot: snap = takeSnapshot,
  sweep = runSweep,
  insertWake = settings.chatId ? dbWakeWriter(settings.dbPath, settings.chatId) : null,
  log = console.log,
} = {}) {
  const previous = readJson(settings.statePath) ?? {};
  let snapshot = snap(settings);
  let conditions = evaluate(snapshot, now, previous);
  const state = { lastSweepAt: previous.lastSweepAt ?? null, swapHighCount: nextSwapCount(snapshot, previous), notified: previous.notified ?? {} };

  let sweepText = 'did not run: disk not low';
  if (conditions.some((c) => c.key === 'disk-low')) {
    const since = state.lastSweepAt ? now - Date.parse(state.lastSweepAt) : Infinity;
    if (checkOnly) sweepText = 'did not run: check-only';
    else if (!snapshot.externalMounted) sweepText = 'did not run: external drive not mounted';
    else if (since <= SWEEP_MIN_INTERVAL_MS) sweepText = `did not run: last attempt ${Math.round(since / 60000)} min ago`;
    else {
      state.lastSweepAt = new Date(now).toISOString();
      // Record the attempt first so a crash mid-sweep cannot retrigger it every 10 minutes.
      writeJson(settings.statePath, state);
      try {
        const result = sweep({ apply: true, log });
        sweepText = `ran and moved ${gib(result.bytes)} GiB in ${result.moved} folders (${result.busy} busy, ${result.failed} failed)`;
      } catch (error) {
        sweepText = `did not run: ${error instanceof Error ? error.message : String(error)}`;
      }
      snapshot = snap(settings);
      conditions = evaluate(snapshot, now, previous);
    }
  }

  log(JSON.stringify({ at: new Date(now).toISOString(), ...snapshot, conditions: conditions.map((c) => c.key), sweep: sweepText }));
  if (checkOnly) return { snapshot, conditions, state };
  if (insertWake) state.notified = notify({ conditions, state, snapshot, sweepText, now, insertWake, log });
  writeJson(settings.statePath, state);
  return { snapshot, conditions, state };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFile(process.env.VP_ENV_FILE || path.join(os.homedir(), '.config', 'veneer-pro', 'env'));
  try {
    runAutopilot({ checkOnly: process.argv.includes('--check-only') });
  } catch (error) {
    console.error(`disk-autopilot: ${error instanceof Error ? error.message : String(error)}`);
  }
}
