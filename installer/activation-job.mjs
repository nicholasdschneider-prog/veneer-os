#!/usr/bin/env node
// Armed one-shot release activation: the zero-pending executor path.
//
// A guarded activation run from a Veneer turn always refuses, because that
// turn is itself a pending row and nothing may exclude it. Instead, the
// executor's turn ARMS a one-shot launchd job bound to the approval reference,
// an exact existing release, the source it was built from and the job list,
// with an absolute deadline, and then ends its turn. The job:
//   - waits until pending_turns == 0 and no Veneer Browser copy is running for
//     N consecutive reads (so the arming turn has ended too);
//   - refuses, without acting, if the source, the checkout dist or the release
//     changed since arming (a content check, not HEAD: report-only commits do
//     not trip it);
//   - at the deadline exits WITHOUT acting and records that;
//   - otherwise records `running` (the point after which nothing is retried)
//     and runs the same guarded installer, whose helper re-checks before the
//     whole plan and before each job;
//   - leaves an exact status in the arm file for the executor's next turn.
// It never forces, never retries after a start and never passes
// --allow-active-turns.
//
//   node installer/activation-job.mjs arm --maintenance-approved --approval-ref TEXT \
//        --release ID --source-sha SHA --jobs a,b,c --deadline ISO --backup-receipt FILE [--consecutive 5] [--interval-ms 2000]
//   node installer/activation-job.mjs status
//   node installer/activation-job.mjs disarm      # only while still waiting
//   node installer/activation-job.mjs run --arm FILE   (what launchd runs)

import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserOccupancy, pendingTurnCount, RELEASE_JOB_LABELS } from './activation-guard.mjs';
import { contentManifest, readRelease, releasesDir, verifyRelease } from '../scripts/releases.mjs';
import { readEnvFile } from './env.mjs';
import { assertFreshBackup, bindReceipt } from './backup-receipt.mjs';

export const ACTIVATION_LABEL = 'com.veneer.pro.activation';
export const SHIPPED_PATHS = ['server', 'web', 'browser-manager', 'installer', 'scripts', 'deploy', 'package.json', 'package-lock.json', 'provider-runtimes.json'];
const LIVE_STATES = new Set(['armed', 'running']);
const MAX_DEADLINE_MS = 12 * 60 * 60 * 1000;

export const armDir = (dataDir) => path.join(releasesDir(dataDir), 'arm');
export const armFile = (dataDir) => path.join(armDir(dataDir), 'activation.json');

function git(codeDir, args) {
  return execFileSync('git', ['-C', codeDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}

/** Content of every shipped source path (index blobs, worktree edits, untracked files). HEAD is not part of it. */
export function sourceFingerprint(codeDir) {
  const parts = [
    git(codeDir, ['ls-files', '-s', '--', ...SHIPPED_PATHS]),
    git(codeDir, ['diff', '--no-ext-diff', '--binary', '--', ...SHIPPED_PATHS]),
    git(codeDir, ['ls-files', '--others', '--exclude-standard', '--', ...SHIPPED_PATHS]),
  ];
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
}

/** True when the shipped paths in the working tree are exactly the given commit's. */
export function matchesCommit(codeDir, sha) {
  try {
    git(codeDir, ['diff', '--quiet', sha, '--', ...SHIPPED_PATHS]);
    return git(codeDir, ['ls-files', '--others', '--exclude-standard', '--', ...SHIPPED_PATHS]).trim() === '';
  } catch {
    return false;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readArm(dataDir) {
  try { return JSON.parse(fs.readFileSync(armFile(dataDir), 'utf8')); } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * Serializes every read-modify-write of the arm file (arm, commit, finish,
 * disarm). A lock left by a dead process is taken over; a live holder means
 * the caller loses, never waits or forces.
 */
export function withArmLock(dataDir, fn) {
  const lock = path.join(armDir(dataDir), 'arm.lock');
  fs.mkdirSync(armDir(dataDir), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt += 1) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')); } catch { /* being created */ }
      if (attempt === 0 && owner && !alive(owner)) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      throw new Error(`the arm file is locked by pid ${owner ?? 'unknown'}; nothing was changed`);
    }
  }
  try {
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Compare-and-set on (arm_id, state): applies `mutate` only when the arm is
 * still exactly the expected one in the expected state. Returns
 * { ok:false, current } when something else (a disarm, a re-arm) won.
 */
export function casArm(dataDir, { armId, state }, mutate) {
  return withArmLock(dataDir, () => {
    const current = readArm(dataDir);
    if (!current || current.arm_id !== armId || current.state !== state) return { ok: false, current };
    const next = mutate(current);
    if (next === null) return { ok: false, current };
    writeJson(armFile(dataDir), next);
    return { ok: true, arm: next };
  });
}

/** What must not have changed between arming and acting. */
export function bindingNow({ dataDir, codeDir, releaseId }) {
  const meta = verifyRelease(dataDir, releaseId);
  return { release_manifest: meta.manifest_sha256, dist_manifest: contentManifest(codeDir).sha256, source_fingerprint: sourceFingerprint(codeDir) };
}

/**
 * Arms the job. Refuses without the approval flag, with a second different
 * arm, or when the release/source/dist do not match. Re-arming the identical
 * request is a no-op that reports the existing arm.
 */
export function armActivation({
  dataDir, codeDir, approvalRef, releaseId, sourceSha, jobs, deadline, consecutive = 5, intervalMs = 2000,
  maintenanceApproved, now = new Date(), binding = bindingNow, matches = matchesCommit, bootstrap,
  backupReceipt, backupCheck = assertFreshBackup,
}) {
  if (!maintenanceApproved) throw new Error('Arming refused: it schedules a deployment, so it needs --maintenance-approved inside an approved window.');
  if (!approvalRef?.trim()) throw new Error('Arming refused: --approval-ref naming the human approval is required.');
  const due = Date.parse(deadline);
  if (!Number.isFinite(due) || due <= now.getTime() || due - now.getTime() > MAX_DEADLINE_MS) throw new Error('Arming refused: --deadline must be an absolute time in the future, at most 12 hours away.');
  if (!jobs.length || jobs.some((job) => !RELEASE_JOB_LABELS.includes(job))) throw new Error(`Arming refused: jobs must be release jobs (${RELEASE_JOB_LABELS.join(', ')}).`);
  if (!Number.isInteger(consecutive) || consecutive < 3 || !Number.isInteger(intervalMs) || intervalMs < 500) throw new Error('Arming refused: at least 3 consecutive reads, at least 500 ms apart.');
  const key = crypto.createHash('sha256').update(JSON.stringify([approvalRef, releaseId, sourceSha, [...jobs].sort(), deadline, consecutive, intervalMs, backupReceipt ? path.resolve(backupReceipt) : null])).digest('hex');
  return withArmLock(dataDir, () => armLocked());
  function armLocked() {
  const existing = readArm(dataDir);
  if (existing && LIVE_STATES.has(existing.state)) {
    if (existing.key === key) return { ...existing, reused: true };
    throw new Error(`Arming refused: another activation is ${existing.state} (${existing.arm_id}, release ${existing.release_id}). Disarm it first; never run two.`);
  }
  const { meta } = readRelease(dataDir, releaseId);
  if (!sourceSha || !meta.git_sha?.startsWith(sourceSha) || meta.git_dirty) throw new Error(`Arming refused: release ${releaseId} was not built from a clean ${sourceSha}.`);
  if (!matches(codeDir, sourceSha)) throw new Error(`Arming refused: the shipped source differs from ${sourceSha}.`);
  const bound = binding({ dataDir, codeDir, releaseId });
  if (bound.release_manifest !== bound.dist_manifest) throw new Error('Arming refused: the checkout dist is not the build this release snapshotted.');
  // The verified backup the activation will depend on. A stale or unverified one refuses now.
  let backup;
  try { backup = bindReceipt(backupReceipt); backupCheck(backup, { now }); }
  catch (error) { throw new Error(`Arming refused (${error.code ?? 'backup'}): ${error.message}`); }
  if (existing) writeJson(path.join(armDir(dataDir), 'history', `${existing.arm_id}.json`), existing);
  const arm = {
    schema: 'veneer-activation-arm/v1', arm_id: crypto.randomUUID(), key, state: 'armed', armed_at: now.toISOString(),
    approval_ref: approvalRef, release_id: releaseId, source_sha: sourceSha, jobs, deadline: new Date(due).toISOString(),
    consecutive, interval_ms: intervalMs, binding: bound, backup, observations: [],
  };
  writeJson(armFile(dataDir), arm);
  try {
    bootstrap?.(arm);
  } catch (error) {
    writeJson(armFile(dataDir), { ...arm, state: 'arm_failed', ended_at: new Date().toISOString(), detail: error.message });
    throw new Error(`Arming failed; nothing will run: ${error.message}`);
  }
  return arm;
  }
}

/**
 * The armed job's body. Acts at most once; every exit leaves an exact state.
 * Every check is repeated, under the arm lock, immediately before committing
 * `running` with a compare-and-set, so a deadline, disarm, re-arm, binding
 * change or stale backup that lands during the last read always wins.
 * Returns the process exit code.
 */
export async function runArmedActivation({
  dataDir, codeDir, now = () => new Date(), sleep, readPending, readOccupancy, binding = bindingNow, backupCheck = assertFreshBackup,
  runInstaller, beforeCommit, log = console.log,
}) {
  const arm = readArm(dataDir);
  if (!arm || arm.state !== 'armed') { log(`[activation] nothing armed (state ${arm?.state ?? 'none'}); no action`); return 0; }
  const expect = { armId: arm.arm_id, state: 'armed' };
  // Terminal states are compare-and-set too: a concurrent disarm is never overwritten.
  const finish = (from, state, extra) => {
    const result = casArm(dataDir, { armId: arm.arm_id, state: from }, (current) => ({ ...current, state, ended_at: now().toISOString(), ...extra }));
    log(result.ok ? `[activation] ${state}${extra.detail ? `: ${extra.detail}` : ''}` : `[activation] ${state} not recorded: the arm is now ${result.current?.state ?? 'gone'}`);
  };
  /** Everything that must still hold to act. Returns [state, detail] for a refusal, or null. */
  const refusal = (current) => {
    if (!current || current.arm_id !== arm.arm_id || current.state !== 'armed') return ['lost', `the arm is now ${current?.state ?? 'gone'}${current && current.arm_id !== arm.arm_id ? ` (${current.arm_id})` : ''}`];
    if (now().getTime() >= Date.parse(arm.deadline)) return ['refused_deadline', `zero pending and idle browsers were not seen ${arm.consecutive} times in a row before ${arm.deadline}; nothing was activated`];
    let latest;
    try { latest = binding({ dataDir, codeDir, releaseId: arm.release_id }); }
    catch (error) { return ['refused_changed', `release no longer verifies: ${error.message}; nothing was activated`]; }
    const changed = Object.keys(arm.binding).filter((field) => arm.binding[field] !== latest[field]);
    if (changed.length) return ['refused_changed', `${changed.join(', ')} changed since arming; nothing was activated`];
    return null;
  };
  const stopFor = ([state, detail]) => {
    if (state === 'lost') { log(`[activation] no action: ${detail}`); return 0; }
    finish('armed', state, { detail });
    return 1;
  };
  let streak = 0;
  for (;;) {
    const before = refusal(readArm(dataDir));
    if (before) return stopFor(before);
    const pending = readPending();
    const browsers = await readOccupancy();
    const idle = browsers.installed ? !browsers.error && browsers.active === 0 && browsers.waiting === 0 : true;
    streak = pending === 0 && idle ? streak + 1 : 0;
    if (streak >= arm.consecutive) break;
    await sleep(arm.interval_ms);
  }
  await beforeCommit?.();
  // Commit point. Re-validated under the lock; from here on nothing is retried.
  let refused = null;
  const commit = casArm(dataDir, expect, (current) => {
    refused = refusal(current);
    if (!refused) {
      try { backupCheck(current.backup, { now: now() }); }
      catch (error) { refused = [error.code === 'refused_stale_backup' ? 'refused_stale_backup' : 'refused_changed', `${error.message}; nothing was activated`]; }
    }
    return refused ? null : { ...current, state: 'running', started_at: now().toISOString() };
  });
  if (!commit.ok) return stopFor(refused ?? ['lost', `the arm is now ${commit.current?.state ?? 'gone'}`]);
  log(`[activation] starting guarded activation of ${arm.release_id} for ${arm.jobs.join(', ')}`);
  let exitCode;
  try {
    exitCode = runInstaller([
      '--activate-release', '--release-services-only', '--maintenance-approved',
      '--release', arm.release_id, '--source-sha', arm.source_sha, '--expect-manifest', arm.binding.release_manifest,
      '--expect-jobs', arm.jobs.join(','), '--deadline', arm.deadline, '--backup-receipt', arm.backup.receipt_path,
    ]);
  } catch (error) { finish('running', 'failed', { detail: `installer could not be started: ${error.message}` }); return 1; }
  if (exitCode === 0) { finish('running', 'completed', { exit_code: 0 }); return 0; }
  finish('running', 'failed', { exit_code: exitCode, detail: 'the guarded installer refused or failed; read its log and the reload status before anything else' });
  return 1;
}

export function renderActivationPlist({ nodeBin, scriptPath, armPath, logPath, codeDir, home }) {
  const x = (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${ACTIVATION_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${x(nodeBin)}</string><string>${x(scriptPath)}</string><string>run</string><string>--arm</string><string>${x(armPath)}</string></array>
  <key>WorkingDirectory</key><string>${x(codeDir)}</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>${x(home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${x(logPath)}</string>
  <key>StandardErrorPath</key><string>${x(logPath)}</string>
</dict>
</plist>
`;
}

function defaultDataDir() {
  const envFile = process.env.VP_ENV_FILE || path.join(os.homedir(), '.config', 'veneer-pro', 'env');
  const raw = process.env.DATA_DIR || readEnvFile(envFile).DATA_DIR || path.join(os.homedir(), '.local', 'share', 'veneer-pro');
  return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = defaultDataDir();
  const logDir = path.join(os.homedir(), 'Library', 'Logs', 'veneer-pro');
  const target = `gui/${process.getuid()}/${ACTIVATION_LABEL}`;
  const plistPath = path.join(armDir(dataDir), `${ACTIVATION_LABEL}.plist`);
  try {
    if (args[0] === 'arm') {
      const arm = armActivation({
        dataDir, codeDir, approvalRef: opt('approval-ref'), releaseId: opt('release'), sourceSha: opt('source-sha'),
        jobs: (opt('jobs') ?? '').split(',').filter(Boolean), deadline: opt('deadline'),
        consecutive: opt('consecutive') ? Number(opt('consecutive')) : undefined, intervalMs: opt('interval-ms') ? Number(opt('interval-ms')) : undefined,
        maintenanceApproved: args.includes('--maintenance-approved'),
        backupReceipt: opt('backup-receipt'),
        bootstrap: () => {
          try { if (/\bstate = running\b/.test(execFileSync('launchctl', ['print', target], { encoding: 'utf8' }))) throw new Error('an activation job is already running'); execFileSync('launchctl', ['bootout', target], { stdio: 'ignore' }); }
          catch (error) { if (/already running/.test(error.message)) throw error; }
          fs.writeFileSync(plistPath, renderActivationPlist({ nodeBin: process.execPath, scriptPath: fileURLToPath(import.meta.url), armPath: armFile(dataDir), logPath: path.join(logDir, 'veneer-activation.log'), codeDir, home: os.homedir() }), { mode: 0o600 });
          execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath], { stdio: 'inherit' });
        },
      });
      console.log(`[activation] ${arm.reused ? 'already armed' : 'armed'} ${arm.arm_id}: release ${arm.release_id}, jobs ${arm.jobs.join(', ')}, deadline ${arm.deadline}. End this turn; read 'activation-job.mjs status' next turn.`);
    } else if (args[0] === 'status') {
      console.log(JSON.stringify(readArm(dataDir) ?? { state: 'none' }, null, 2));
    } else if (args[0] === 'disarm') {
      const arm = readArm(dataDir);
      if (arm?.state === 'running') throw new Error('Disarm refused: the activation already started; read its status instead.');
      const result = arm?.state === 'armed' ? casArm(dataDir, { armId: arm.arm_id, state: 'armed' }, (current) => ({ ...current, state: 'disarmed', ended_at: new Date().toISOString() })) : { ok: false, current: arm };
      try { execFileSync('launchctl', ['bootout', target], { stdio: 'ignore' }); } catch { /* not loaded */ }
      console.log(`[activation] ${result.ok ? 'disarmed' : `nothing to disarm (state ${result.current?.state ?? 'none'})`}`);
    } else if (args[0] === 'run') {
      const serverPackage = path.join(codeDir, 'server', 'package.json');
      // Same location the installer provisions: beside the env file.
      const browserEnvFile = path.join(path.dirname(process.env.VP_ENV_FILE || path.join(os.homedir(), '.config', 'veneer-pro', 'env')), 'browser.env');
      process.exitCode = await runArmedActivation({
        dataDir, codeDir,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        readPending: () => pendingTurnCount({ dataDir, serverPackage }) ?? 0,
        readOccupancy: () => browserOccupancy({ browserEnvFile, port: Number(process.env.VENEER_BROWSER_MANAGER_PORT || 7300) }),
        runInstaller: (installerArgs) => spawnSync(process.execPath, [path.join(codeDir, 'installer', 'install-darwin.mjs'), ...installerArgs], { stdio: 'inherit' }).status ?? 1,
      });
    } else {
      console.error('usage: activation-job.mjs arm|status|disarm|run');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`[activation] REFUSED — ${error.message}`);
    process.exitCode = 1;
  }
}
