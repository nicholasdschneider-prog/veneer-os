import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluate, nextSwapCount, notify, runAutopilot } from './disk-autopilot.mjs';

const GIB = 1024 ** 3;
const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 10, 17, 15);
const iso = (ms) => new Date(ms).toISOString();
const healthy = {
  freeBytes: 60 * GIB,
  swapBytes: 2 * GIB,
  externalMounted: true,
  newestBackupAt: iso(NOW - 6 * HOUR),
  offsiteConfigured: true,
  offsite: { lastUploadedAt: iso(NOW - 5 * HOUR), lastError: null },
};
const keys = (snapshot, previous = {}) => evaluate(snapshot, NOW, previous).map((c) => c.key);

test('a healthy snapshot raises nothing', () => {
  assert.deepEqual(keys(healthy), []);
});

test('disk-low below 25 GiB free', () => {
  assert.deepEqual(keys({ ...healthy, freeBytes: 24.9 * GIB }), ['disk-low']);
  assert.deepEqual(keys({ ...healthy, freeBytes: 25 * GIB }), []);
});

test('swap-high needs three high samples in a row', () => {
  const high = { ...healthy, swapBytes: 10 * GIB };
  assert.deepEqual(keys(high, { swapHighCount: 0 }), []);
  assert.deepEqual(keys(high, { swapHighCount: 1 }), []);
  assert.deepEqual(keys(high, { swapHighCount: 2 }), ['swap-high']);
  assert.equal(nextSwapCount(high, { swapHighCount: 2 }), 3);
  assert.equal(nextSwapCount(healthy, { swapHighCount: 5 }), 0);
});

test('external-unmounted suppresses backup-stale; backup-stale after 26 h or with no backup', () => {
  assert.deepEqual(keys({ ...healthy, externalMounted: false, newestBackupAt: null }), ['external-unmounted']);
  assert.deepEqual(keys({ ...healthy, newestBackupAt: iso(NOW - 27 * HOUR) }), ['backup-stale']);
  assert.deepEqual(keys({ ...healthy, newestBackupAt: null }), ['backup-stale']);
  assert.deepEqual(keys({ ...healthy, newestBackupAt: iso(NOW - 25 * HOUR) }), []);
});

test('offsite-stale only when configured and the last upload is missing or older than 50 h', () => {
  assert.deepEqual(keys({ ...healthy, offsite: null }), ['offsite-stale']);
  assert.deepEqual(keys({ ...healthy, offsite: { lastUploadedAt: iso(NOW - 51 * HOUR), lastError: 'x' } }), ['offsite-stale']);
  assert.deepEqual(keys({ ...healthy, offsiteConfigured: false, offsite: null }), []);
});

test('notify writes one wake per run, none again the same day, and wakes for a new key', () => {
  const wakes = [];
  const insertWake = (key, reason) => { wakes.push({ key, reason }); return true; };
  const conditions = [{ key: 'disk-low', summary: 'low' }, { key: 'backup-stale', summary: 'stale' }];
  const base = { snapshot: healthy, sweepText: 'did not run: test', now: NOW, insertWake, log: () => {} };
  let notified = notify({ ...base, conditions, state: { notified: { 'disk-low': '2026-11-16' } } });
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].key, 'disk-autopilot:backup-stale+disk-low:2026-11-17');
  assert.match(wakes[0].reason, /^Mac disk autopilot: low; stale\. Measured /);
  assert.deepEqual(notified, { 'disk-low': '2026-11-17', 'backup-stale': '2026-11-17' });
  notified = notify({ ...base, conditions, state: { notified } });
  assert.equal(wakes.length, 1);
  notify({ ...base, conditions: [...conditions, { key: 'swap-high', summary: 'swap' }], state: { notified } });
  assert.equal(wakes.length, 2);
  assert.equal(wakes[1].key, 'disk-autopilot:swap-high:2026-11-17');
});

test('a failed or skipped insert leaves notified untouched', () => {
  const base = { conditions: [{ key: 'disk-low', summary: 'low' }], state: { notified: {} }, snapshot: healthy, sweepText: 'x', now: NOW, log: () => {} };
  assert.deepEqual(notify({ ...base, insertWake: () => { throw new Error('SQLITE_BUSY'); } }), {});
  assert.deepEqual(notify({ ...base, insertWake: () => false }), {});
});

test('a low disk runs the sweep at most once an hour; check-only writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-autopilot-test-'));
  try {
    const settings = { statePath: path.join(dir, 'run', 'disk-autopilot.json') };
    let free = 10 * GIB;
    const sweeps = [];
    const wakes = [];
    const run = (now, extra = {}) => runAutopilot({
      settings, now, log: () => {},
      snapshot: () => ({ ...healthy, freeBytes: free }),
      sweep: () => { sweeps.push(now); free = 12 * GIB; return { moved: 1, bytes: 2 * GIB, busy: 0, failed: 0 }; },
      insertWake: (key, reason) => { wakes.push(reason); return true; },
      ...extra,
    });
    run(NOW, { checkOnly: true });
    assert.equal(fs.existsSync(settings.statePath), false);
    assert.equal(sweeps.length, 0);
    run(NOW);
    assert.equal(sweeps.length, 1);
    assert.match(wakes[0], /Automatic sweep ran and moved 2\.0 GiB/);
    run(NOW + 30 * 60 * 1000);
    assert.equal(sweeps.length, 1);
    assert.equal(wakes.length, 1);
    run(NOW + 61 * 60 * 1000);
    assert.equal(sweeps.length, 2);
    free = 40 * GIB;
    const healed = run(NOW + 200 * 60 * 1000, { sweep: () => { throw new Error('should not sweep'); } });
    assert.deepEqual(healed.conditions, []);
    assert.equal((fs.statSync(settings.statePath).mode & 0o777), 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the database writer inserts one pending wake for an existing chat and skips an unknown one', async () => {
  const { createRequire } = await import('node:module');
  const { dbWakeWriter } = await import('./disk-autopilot.mjs');
  const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-autopilot-db-'));
  try {
    const file = path.join(dir, 'veneer-pro.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
      CREATE TABLE conversation_wakeups(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, actor_user_id TEXT, wake_key TEXT NOT NULL,
        reason TEXT NOT NULL, scheduled_for TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
      CREATE UNIQUE INDEX pending_key ON conversation_wakeups(conversation_id, wake_key) WHERE status = 'pending';
      INSERT INTO conversations VALUES ('chat-1', 'owner-1');`);
    db.close();
    assert.equal(dbWakeWriter(file, 'chat-1', () => {})('disk-autopilot:disk-low:2026-11-17', 'why'), true);
    assert.equal(dbWakeWriter(file, 'chat-1', () => {})('disk-autopilot:disk-low:2026-11-17', 'why'), true);
    assert.equal(dbWakeWriter(file, 'missing', () => {})('disk-autopilot:disk-low:2026-11-17', 'why'), false);
    const check = new Database(file, { readonly: true });
    assert.deepEqual(check.prepare('SELECT conversation_id, actor_user_id, wake_key FROM conversation_wakeups').all(),
      [{ conversation_id: 'chat-1', actor_user_id: 'owner-1', wake_key: 'disk-autopilot:disk-low:2026-11-17' }]);
    check.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
