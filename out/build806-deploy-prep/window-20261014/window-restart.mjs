#!/usr/bin/env node
// BUILD806 approved window, 2026-10-14 (Nick 07:05 ET via James link t731u, "Yes run it now"):
// scope 1b8561a..9b6424e, fresh backup, restart web then runner, read-only postcheck.
// One-shot launchd job so the executor's own turn can end. Acts at most once:
// waits for N consecutive quiet reads (0 pending turns, 0 running browser copies),
// re-checks the source/dist pins and the window, takes a fresh read-only online
// backup with a verified receipt, records the before-pin, runs restart.mjs once
// (which itself refuses per service while turns are pending), then records the
// health check and the after-pin. Never retries, never forces, never passes
// --allow-active-turns. At the deadline it exits without acting.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const [codeDir, outDir, deadlineIso, wantServerManifest] = process.argv.slice(2);
const deadline = Date.parse(deadlineIso);
const home = os.homedir();
const dataDir = path.join(home, '.local', 'share', 'veneer-pro');
const db = path.join(dataDir, 'veneer-pro.db');
const predeploy = path.join(home, '.local', 'share', 'veneer-pro-predeploy', 'build806-20261013');
const statusFile = path.join(outDir, 'status.json');
const SHIPPED = ['server', 'web', 'browser-manager', 'package.json', 'package-lock.json', 'provider-runtimes.json', 'installer/provider-runtimes.mjs'];
const { browserOccupancy } = await import(path.join(codeDir, 'installer', 'activation-guard.mjs'));
const { createReceipt } = await import(path.join(codeDir, 'installer', 'backup-receipt.mjs'));

const status = { schema: 'build806-window/v1', approval: 'Nick 2026-10-14 07:05 ET, Grok Bot msg t731u, relayed verbatim by James (thread a6e39d6e turn 19): "Yes run it now"', scope: '1b8561a..9b6424e', deadline: new Date(deadline).toISOString(), state: 'waiting', started_at: new Date().toISOString(), steps: [] };
const save = () => { fs.writeFileSync(`${statusFile}.tmp`, JSON.stringify(status, null, 2) + '\n'); fs.renameSync(`${statusFile}.tmp`, statusFile); };
const step = (name, detail) => { status.steps.push({ at: new Date().toISOString(), name, ...detail }); save(); console.log(`[window] ${name} ${JSON.stringify(detail)}`); };
const end = (state, detail) => { status.state = state; status.ended_at = new Date().toISOString(); step(state, detail); process.exit(state === 'completed' ? 0 : 1); };
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const pending = () => Number(sh('/usr/bin/sqlite3', ['-readonly', db, "select count(*) from pending_turns where status='pending'"]).trim());
const occupancy = () => browserOccupancy({ browserEnvFile: path.join(home, '.config', 'veneer-pro', 'browser.env'), port: 7300 });
const inWindow = () => Date.now() < deadline;
const serverManifest = () => sh('/bin/sh', ['-c', 'cd "$1" && find server/dist -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64', 'sh', codeDir]).trim();
const pinsHold = () => {
  try { sh('/usr/bin/git', ['-C', codeDir, 'diff', '--quiet', '9b6424e', '--', ...SHIPPED]); } catch { return 'shipped source differs from 9b6424e'; }
  if (serverManifest() !== wantServerManifest) return 'server/dist differs from the pinned 9b6424e build';
  return null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

save();
step('armed', { pending: pending(), consecutive: 5, interval_ms: 3000 });

// 1. Wait for 5 consecutive quiet reads inside the window.
let streak = 0;
for (;;) {
  if (!inWindow()) end('refused_deadline', { detail: 'no 5 consecutive quiet reads before the deadline; nothing was done' });
  const p = pending();
  const o = await occupancy();
  const idle = o.installed ? !o.error && o.active === 0 && o.waiting === 0 : true;
  streak = p === 0 && idle ? streak + 1 : 0;
  if (streak >= 5) break;
  await sleep(3000);
}
step('quiet', { reads: 5 });

// 2. Pins and window, re-checked after the wait.
const pinProblem = pinsHold();
if (pinProblem) end('refused_changed', { detail: `${pinProblem}; nothing was done` });
if (!inWindow()) end('refused_deadline', { detail: 'window ended after the quiet reads; nothing was done' });

// 3. Fresh read-only online backup and verified receipt.
const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const backup = path.join(predeploy, `veneer-pro-online-${ts}.db`);
try {
  const Database = createRequire(path.join(codeDir, 'server', 'package.json'))('better-sqlite3');
  const src = new Database(db, { readonly: true, fileMustExist: true });
  try { await src.backup(backup); } finally { src.close(); }
  fs.chmodSync(backup, 0o600);
  const receipt = createReceipt(backup);
  fs.writeFileSync(`${backup}.receipt.json`, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  if (receipt.integrity_check !== 'ok' || receipt.foreign_key_violations !== 0) end('backup_failed', { detail: 'backup did not verify; no restart', receipt });
  step('backup', { file: backup, sha256: receipt.sha256, size: receipt.size, integrity_check: receipt.integrity_check, foreign_key_violations: receipt.foreign_key_violations, taken_at: receipt.taken_at });
} catch (error) {
  end('backup_failed', { detail: `${error.message}; no restart` });
}

// 4. Read-only before-pin of the live DB.
const pin = (label) => {
  const raw = sh(path.join(outDir, '..', 'postcheck.sh'), [db]);
  fs.writeFileSync(path.join(predeploy, `pin-window-${label}-${ts}.txt`), raw, { mode: 0o600 });
  const hashes = raw.split('\n').filter((l) => l.startsWith('## ')).join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, `pin-${label}.hashes.txt`), hashes);
  return hashes;
};
const before = pin('before');
step('before-pin', { lines: before.trim().split('\n').length });

// 5. Last checks, then the restart, exactly once.
const pendingNow = pending();
if (!inWindow()) end('refused_deadline', { detail: 'window ended before the restart; backup and before-pin were taken, nothing was restarted' });
if (pendingNow !== 0) end('refused_busy', { detail: `${pendingNow} pending turns appeared before the restart; nothing was restarted` });
const pids = () => ['veneer-pro', 'veneer-pro-runner'].map((s) => { try { return `${s}=${fs.readFileSync(path.join(dataDir, 'run', `${s}.pid`), 'utf8').trim()}`; } catch { return `${s}=none`; } }).join(' ');
step('restarting', { pids_before: pids(), command: 'node scripts/restart.mjs --maintenance-approved veneer-pro veneer-pro-runner' });
const restart = spawnSync(process.execPath, [path.join(codeDir, 'scripts', 'restart.mjs'), '--maintenance-approved', 'veneer-pro', 'veneer-pro-runner'], { cwd: codeDir, encoding: 'utf8', env: { ...process.env, HOME: home } });
fs.writeFileSync(path.join(outDir, 'restart.log'), `${restart.stdout ?? ''}${restart.stderr ?? ''}`);
step('restart-exit', { exit_code: restart.status, pids_after: pids() });

// 6. Read-only health and after-pin (recorded whatever the restart outcome).
const fetchText = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); return `${r.status} ${await r.text()}`; } catch (e) { return `ERR ${e.message}`; } };
step('health', {
  web_healthz: await fetchText('http://127.0.0.1:3100/healthz'),
  web_runner_rpc: await fetchText('http://127.0.0.1:3100/healthz/runner-rpc'),
  runner_healthz: await fetchText('http://127.0.0.1:3101/healthz'),
});
const hc = spawnSync(process.execPath, [path.join(codeDir, 'scripts', 'restart.mjs'), '--health-check'], { cwd: codeDir, encoding: 'utf8' });
fs.writeFileSync(path.join(outDir, 'health-check.log'), `${hc.stdout ?? ''}${hc.stderr ?? ''}`);
const after = pin('after');
step('after-pin', { exit_code_health_check: hc.status, identical_to_before: after === before });
end(restart.status === 0 ? 'completed' : 'restart_failed_or_refused', { detail: restart.status === 0 ? 'web then runner restarted and healthy' : 'read restart.log before anything else; never re-run blindly' });
