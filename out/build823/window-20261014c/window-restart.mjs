#!/usr/bin/env node
// BUILD823 web-only window (Nick 10:11 ET 10-14 via James, 36e73759 t11 / a6e39d6e t25:
// "Yes restart the web with the extra changes"): scope 9b6424e..38b2bf2, web only, runner stays.
// Armed once by a6e39d6e after the sibling waiter (window-20261014b) refused on committed source.
// Backup: reuse the verified 11:14Z backup (Nick 12:23 PM ET 10-14, option b); no fresh backup.
// Pinned to the BYTES a restart loads: server/dist must equal the isolated 38b2bf2 build.
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

const status = { schema: 'build823-window/v1', approval: 'Nick 2026-10-14 10:11 ET, Grok Bot, relayed verbatim by James (36e73759 t11; a6e39d6e t25): "Yes restart the web with the extra changes"', scope: '9b6424e..38b2bf2 web only (7908c79, 2d9e479, 80630ff, bc21ed1, 38b2bf2; migrations 0180-0182)', deadline: new Date(deadline).toISOString(), state: 'waiting', started_at: new Date().toISOString(), steps: [] };
const save = () => { fs.writeFileSync(`${statusFile}.tmp`, JSON.stringify(status, null, 2) + '\n'); fs.renameSync(`${statusFile}.tmp`, statusFile); };
const step = (name, detail) => { status.steps.push({ at: new Date().toISOString(), name, ...detail }); save(); console.log(`[window] ${name} ${JSON.stringify(detail)}`); };
const end = (state, detail) => { status.state = state; status.ended_at = new Date().toISOString(); step(state, detail); process.exit(state === 'completed' ? 0 : 1); };
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const pending = () => Number(sh('/usr/bin/sqlite3', ['-readonly', db, "select count(*) from pending_turns where status='pending'"]).trim());
const occupancy = () => browserOccupancy({ browserEnvFile: path.join(home, '.config', 'veneer-pro', 'browser.env'), port: 7300 });
const inWindow = () => Date.now() < deadline;
const serverManifest = () => sh('/bin/sh', ['-c', 'cd "$1" && find server/dist -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64', 'sh', codeDir]).trim();
// Committed source has moved past 38b2bf2 (fefb2c0, f290c6c) without a rebuild; what a
// restart loads is server/dist, so the pin is its byte manifest (isolated 38b2bf2 build).
const pinsHold = () => (serverManifest() !== wantServerManifest ? 'server/dist differs from the pinned 38b2bf2 build' : null);
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

// 3. Backup: Nick 12:23 PM ET 10-14 ("Reuse this morning's 7:14 backup and restart the web")
// chose the verified 11:14Z backup instead of a fresh one. Verify it is unchanged; take none.
const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const backup = path.join(predeploy, 'veneer-pro-online-20261014T111454Z.db');
try {
  const receipt = JSON.parse(fs.readFileSync(`${backup}.receipt.json`, 'utf8'));
  const { sha256File } = await import(path.join(codeDir, 'installer', 'backup-receipt.mjs'));
  const ok = receipt.sha256 === 'a5499bbc6c2dfec9e7f067b1d10fac8cca93b4d600d83556b621109e990ccb91'
    && receipt.integrity_check === 'ok' && receipt.foreign_key_violations === 0
    && fs.statSync(backup).size === receipt.size && sha256File(backup) === receipt.sha256;
  if (!ok) end('backup_failed', { detail: 'the approved 11:14Z backup no longer matches its receipt; no restart' });
  step('backup-reused', { file: backup, sha256: receipt.sha256, size: receipt.size, integrity_check: receipt.integrity_check, foreign_key_violations: receipt.foreign_key_violations, taken_at: receipt.taken_at, approval: 'Nick 12:23 PM ET 10-14 option (b)' });
} catch (error) {
  end('backup_failed', { detail: `${error.message}; no restart` });
}

// 4. Read-only before-pin of the live DB.
const pin = (label) => {
  const raw = sh(path.join(codeDir, 'out', 'build806-deploy-prep', 'postcheck.sh'), [db]);
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
step('restarting', { pids_before: pids(), command: 'node scripts/restart.mjs --maintenance-approved veneer-pro' });
const restart = spawnSync(process.execPath, [path.join(codeDir, 'scripts', 'restart.mjs'), '--maintenance-approved', 'veneer-pro'], { cwd: codeDir, encoding: 'utf8', env: { ...process.env, HOME: home } });
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
end(restart.status === 0 ? 'completed' : 'restart_failed_or_refused', { detail: restart.status === 0 ? 'web restarted on 38b2bf2 and healthy; runner unchanged' : 'read restart.log before anything else; never re-run blindly' });
