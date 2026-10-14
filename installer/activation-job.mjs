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
//        --release ID --source-sha SHA --jobs a,b,c --deadline ISO [--consecutive 5] [--interval-ms 2000]
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
}) {
  if (!maintenanceApproved) throw new Error('Arming refused: it schedules a deployment, so it needs --maintenance-approved inside an approved window.');
  if (!approvalRef?.trim()) throw new Error('Arming refused: --approval-ref naming the human approval is required.');
  const due = Date.parse(deadline);
  if (!Number.isFinite(due) || due <= now.getTime() || due - now.getTime() > MAX_DEADLINE_MS) throw new Error('Arming refused: --deadline must be an absolute time in the future, at most 12 hours away.');
  if (!jobs.length || jobs.some((job) => !RELEASE_JOB_LABELS.includes(job))) throw new Error(`Arming refused: jobs must be release jobs (${RELEASE_JOB_LABELS.join(', ')}).`);
  if (!Number.isInteger(consecutive) || consecutive < 3 || !Number.isInteger(intervalMs) || intervalMs < 500) throw new Error('Arming refused: at least 3 consecutive reads, at least 500 ms apart.');
  const key = crypto.createHash('sha256').update(JSON.stringify([approvalRef, releaseId, sourceSha, [...jobs].sort(), deadline, consecutive, intervalMs])).digest('hex');
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
  if (existing) writeJson(path.join(armDir(dataDir), 'history', `${existing.arm_id}.json`), existing);
  const arm = {
    schema: 'veneer-activation-arm/v1', arm_id: crypto.randomUUID(), key, state: 'armed', armed_at: now.toISOString(),
    approval_ref: approvalRef, release_id: releaseId, source_sha: sourceSha, jobs, deadline: new Date(due).toISOString(),
    consecutive, interval_ms: intervalMs, binding: bound, observations: [],
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

/**
 * The armed job's body. Acts at most once; every exit leaves an exact state.
 * Returns the process exit code.
 */
export async function runArmedActivation({ dataDir, codeDir, now = () => new Date(), sleep, readPending, readOccupancy, binding = bindingNow, runInstaller, log = console.log }) {
  const arm = readArm(dataDir);
  if (!arm || arm.state !== 'armed') { log(`[activation] nothing armed (state ${arm?.state ?? 'none'}); no action`); return 0; }
  const finish = (state, extra) => { writeJson(armFile(dataDir), { ...readArm(dataDir), state, ended_at: now().toISOString(), ...extra }); log(`[activation] ${state}${extra.detail ? `: ${extra.detail}` : ''}`); };
  let streak = 0;
  for (;;) {
    if (readArm(dataDir)?.state !== 'armed') { log('[activation] disarmed while waiting; no action'); return 0; }
    if (now().getTime() >= Date.parse(arm.deadline)) { finish('refused_deadline', { detail: `zero pending and idle browsers were not seen ${arm.consecutive} times in a row before ${arm.deadline}; nothing was activated` }); return 1; }
    let current;
    try { current = binding({ dataDir, codeDir, releaseId: arm.release_id }); }
    catch (error) { finish('refused_changed', { detail: `release no longer verifies: ${error.message}; nothing was activated` }); return 1; }
    const changed = Object.keys(arm.binding).filter((field) => arm.binding[field] !== current[field]);
    if (changed.length) { finish('refused_changed', { detail: `${changed.join(', ')} changed since arming; nothing was activated` }); return 1; }
    const pending = readPending();
    const browsers = await readOccupancy();
    const idle = browsers.installed ? !browsers.error && browsers.active === 0 && browsers.waiting === 0 : true;
    streak = pending === 0 && idle ? streak + 1 : 0;
    if (streak >= arm.consecutive) break;
    await sleep(arm.interval_ms);
  }
  // From here on nothing is retried: a failure is reported, never re-attempted.
  writeJson(armFile(dataDir), { ...readArm(dataDir), state: 'running', started_at: now().toISOString() });
  log(`[activation] starting guarded activation of ${arm.release_id} for ${arm.jobs.join(', ')}`);
  let exitCode;
  try { exitCode = runInstaller(['--activate-release', '--release-services-only', '--maintenance-approved', '--release', arm.release_id, '--expect-jobs', arm.jobs.join(',')]); }
  catch (error) { finish('failed', { detail: `installer could not be started: ${error.message}` }); return 1; }
  if (exitCode === 0) { finish('completed', { exit_code: 0 }); return 0; }
  finish('failed', { exit_code: exitCode, detail: 'the guarded installer refused or failed; read its log and the reload status before anything else' });
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
      if (arm?.state === 'armed') writeJson(armFile(dataDir), { ...arm, state: 'disarmed', ended_at: new Date().toISOString() });
      try { execFileSync('launchctl', ['bootout', target], { stdio: 'ignore' }); } catch { /* not loaded */ }
      console.log(`[activation] ${arm?.state === 'armed' ? 'disarmed' : `nothing to disarm (state ${arm?.state ?? 'none'})`}`);
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
