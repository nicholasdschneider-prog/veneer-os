import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertFreshBackup, bindReceipt, createReceipt, MAX_BACKUP_AGE_MS } from './backup-receipt.mjs';
import { reloadLaunchdServices } from './launchd-reload.mjs';

const serverPackage = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'server', 'package.json');
const Database = createRequire(serverPackage)('better-sqlite3');

function backup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-receipt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'b.db');
  const db = new Database(file); db.exec('create table t(x)'); db.close();
  const receipt = createReceipt(file);
  const receiptPath = `${file}.receipt.json`;
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  return { file, receipt, receiptPath, at: (ms) => new Date(Date.parse(receipt.taken_at) + ms) };
}


/** launchd stand-in: bootout unloads, bootstrap loads, print fails only for unloaded jobs. */
function fakeLaunchctl() {
  const loaded = new Set();
  return ([command, target, plist]) => {
    if (command === 'bootout') { loaded.delete(target); return ''; }
    if (command === 'bootstrap') { loaded.add(`${target}/${path.basename(plist, '.plist')}`); return ''; }
    if (command === 'print') { if (!loaded.has(target)) throw new Error('not loaded'); return ''; }
    return '';
  };
}

test('a verified receipt records the immutable read-only checks and binds exactly', (t) => {
  const b = backup(t);
  assert.equal(b.receipt.integrity_check, 'ok');
  assert.equal(b.receipt.foreign_key_violations, 0);
  assert.equal(fs.existsSync(`${b.file}-wal`), false); // the check wrote nothing beside it
  assertFreshBackup(bindReceipt(b.receiptPath), { now: b.at(60_000) });
});

test('stale, mismatched, unverified or missing backups refuse with refused_stale_backup', (t) => {
  const b = backup(t);
  const bound = bindReceipt(b.receiptPath);
  const refuses = (fn, pattern) => assert.throws(fn, (error) => error.code === 'refused_stale_backup' && pattern.test(error.message));
  refuses(() => assertFreshBackup(bound, { now: b.at(MAX_BACKUP_AGE_MS + 1) }), /min old/);
  refuses(() => assertFreshBackup(bound, { now: b.at(-60_000) }), /min old/); // a backup from the future is not fresh
  fs.appendFileSync(b.file, 'x');
  refuses(() => assertFreshBackup(bound, { now: b.at(1000) }), /size differs/);
  fs.truncateSync(b.file, b.receipt.size);
  fs.writeFileSync(b.file, Buffer.alloc(b.receipt.size, 1));
  refuses(() => assertFreshBackup(bound, { now: b.at(1000) }), /hash differs/);
  refuses(() => bindReceipt(path.join(path.dirname(b.file), 'none.json')), /missing/);
  refuses(() => assertFreshBackup(null), /no backup receipt/);
  fs.writeFileSync(b.receiptPath, JSON.stringify({ ...b.receipt, integrity_check: 'corrupt' }));
  refuses(() => assertFreshBackup(bound, { now: b.at(1000) }), /receipt changed/);
  refuses(() => assertFreshBackup(bindReceipt(b.receiptPath), { now: b.at(1000) }), /did not verify/);
});

test('the installer checks the backup and the window before any write, and passes the window to the helper', () => {
  const source = fs.readFileSync(new URL('./install-darwin.mjs', import.meta.url), 'utf8');
  const guard = source.slice(source.indexOf('const guard = async (phase) => {'));
  assert.ok(guard.indexOf('windowCheck(phase)') < guard.indexOf('assertReloadSafe'));
  assert.ok(guard.indexOf('backupCheck(phase)') < guard.indexOf('assertReloadSafe'));
  assert.match(source, /--activate-release needs --deadline <approved window end, ISO> and --backup-receipt <file>/);
  assert.match(source, /deadline: deadline === null \? null : new Date\(deadline\)\.toISOString\(\)/);
  const pre = source.indexOf("await guard('pre-check')");
  for (const write of ['upsertEnvValues(envFile', 'snapshotRelease(', 'await guardedReload(']) assert.ok(source.indexOf(write, pre) > pre, write);
});

test('the helper never boots out a job after the approved window ends', async () => {
  let clock = Date.parse('2026-10-14T05:59:58Z');
  const calls = [];
  const restored = [];
  const services = ['com.veneer.pro', 'com.veneer.web-watchdog', 'com.veneer.pro.app-runner', 'com.veneer.pro.runner'].map((label) => ({ label, plist: `/a/${label}.plist` }));
  const result = await reloadLaunchdServices({
    uid: 501, services, deadline: '2026-10-14T06:00:00Z', now: () => clock,
    launchctl: ((inner) => (args) => { calls.push([args[0], args[1]]); if (args[0] === 'bootstrap') clock += 1000; return inner(args); })(fakeLaunchctl()),
    restore: { dataDir: '/d', plists: services.map((s) => ({ target: s.plist, bytes: null, mode: null })), pointers: [], labelService: {} },
    restoreOptions: { restorePlists: (p) => restored.push(...p.map((x) => path.basename(x.target, '.plist'))), restoreLinks: () => {} },
    wait: async () => {}, log: () => {},
  });
  assert.equal(result.refused, true);
  assert.deepEqual(result.jobs.map((j) => j.outcome), ['reloaded', 'reloaded', 'refused', 'not_started']);
  assert.match(result.errors[0], /before com.veneer.pro.app-runner: the approved window ended at 2026-10-14T06:00:00Z/);
  assert.deepEqual(calls.filter(([c]) => c === 'bootout').map(([, t]) => t.split('/').pop()), ['com.veneer.pro', 'com.veneer.web-watchdog']);
  assert.deepEqual(restored, ['com.veneer.pro.app-runner', 'com.veneer.pro.runner']);
});
