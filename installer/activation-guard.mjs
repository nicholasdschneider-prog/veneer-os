// Guards for installer runs that reload launchd jobs and so change what the
// services load. Same refusal as scripts/restart.mjs (shared module, not a
// copy): an approved maintenance window and no pending turns, checked over the
// whole plan before anything is written and again right before the reload.
// Also refuses while any Veneer Browser working copy is running (occupied,
// held with keep_open, or not yet paused): the reload restarts the runner and,
// in a full install, Chrome and the browser manager. Refusals are loud, exit
// non-zero and are never retried; there is no delayed or forced fallback.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { assertRunnerRestartSafe } from '../scripts/restart-safety.mjs';
import { readEnvFile } from './env.mjs';

/** Jobs that start release bytes. A bounded reload touches only these. */
export const RELEASE_JOB_LABELS = ['com.veneer.pro', 'com.veneer.pro.runner', 'com.veneer.pro.app-runner', 'com.veneer.pro.term', 'com.veneer.web-watchdog'];
export const LABEL_SERVICE = {
  'com.veneer.pro': 'veneer-pro',
  'com.veneer.pro.runner': 'veneer-pro-runner',
  'com.veneer.pro.app-runner': 'veneer-pro-app-runner',
  'com.veneer.pro.term': 'veneer-pro-term',
  'com.veneer.web-watchdog': 'web-watchdog',
};

/**
 * Which jobs to reload. Full mode keeps the installer's historical behavior
 * (every rendered job). Bounded mode reloads only release jobs whose plist text
 * changed or whose release pointer will move; every other job stays loaded and
 * untouched, and any of them whose rendered plist differs is reported.
 */
export function planReload({ rendered, bounded, pointerMoves = new Set() }) {
  const changed = (job) => job.current !== job.text;
  const reason = (job) => [changed(job) ? 'plist changed' : null, pointerMoves.has(job.label) ? 'release pointer moves' : null].filter(Boolean).join(', ');
  if (!bounded) return { reload: rendered.map((job) => ({ label: job.label, reason: reason(job) || 'full install reload' })), untouchedChanged: [] };
  const reload = rendered.filter((job) => RELEASE_JOB_LABELS.includes(job.label) && (changed(job) || pointerMoves.has(job.label)));
  const untouchedChanged = rendered.filter((job) => !RELEASE_JOB_LABELS.includes(job.label) && changed(job)).map((job) => job.label);
  return { reload: reload.map((job) => ({ label: job.label, reason: reason(job) })), untouchedChanged };
}

/** Pending turns, read-only. null when there is no database yet (fresh install). */
export function pendingTurnCount({ dataDir, serverPackage }) {
  const file = path.join(dataDir, 'veneer-pro.db');
  if (!fs.existsSync(file)) return null;
  const Database = createRequire(serverPackage)('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return db.prepare("SELECT COUNT(*) n FROM pending_turns WHERE status='pending'").get().n; }
  finally { db.close(); }
}

/**
 * Running working copies, from the manager's authenticated read-only capacity
 * endpoint on loopback. Warm pool copies are not counted. The bearer token is
 * read at use time and goes only to that request; it is never returned or logged.
 */
export async function browserOccupancy({ browserEnvFile, port = 7300, fetchImpl = fetch }) {
  if (!fs.existsSync(browserEnvFile)) return { installed: false, active: 0, waiting: 0 };
  const token = readEnvFile(browserEnvFile).VP_VENEER_BROWSER_TOKEN;
  if (!token) return { installed: true, error: 'browser identity has no token' };
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/v1/capacity`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return { installed: true, error: `capacity check returned HTTP ${response.status}` };
    const body = await response.json();
    if (!Number.isInteger(body.active) || !Number.isInteger(body.waiting)) return { installed: true, error: 'capacity check returned no counts' };
    return { installed: true, active: body.active, waiting: body.waiting };
  } catch (error) {
    return { installed: true, error: `browser manager unreachable (${error.message})` };
  }
}

export function describeOccupancy(o) {
  if (!o.installed) return 'Veneer Browser not installed';
  if (o.error) return `UNKNOWN: ${o.error}`;
  return `${o.active} running working cop${o.active === 1 ? 'y' : 'ies'}, ${o.waiting} waiting`;
}

/**
 * Throws a clear refusal when the plan may not run now. An unknown browser
 * state refuses too: the reload must never stop a browser someone is using.
 */
export async function assertReloadSafe({ phase, jobs, dataDir, serverPackage, maintenanceApproved, allowActive = false, occupancy }) {
  if (!jobs.length) return;
  try {
    assertRunnerRestartSafe({ targets: jobs, dataDir, serverPackage, allowActive, maintenanceApproved });
  } catch (error) {
    throw new Error(`${phase}: ${error.message}`);
  }
  const o = await occupancy();
  if (o.installed && (o.error || o.active > 0 || o.waiting > 0)) {
    throw new Error(`${phase}: Veneer Browser is in use or its state is unknown (${describeOccupancy(o)}). Reload refused; it would stop occupied or held browsers. Wait until every working copy has paused.`);
  }
}

/**
 * The write phase, in a fixed order: final guard, write plists, move pointers,
 * guard again, bootstrap the reload helper. Nothing changes what a respawn
 * loads before the final guard passes. Any refusal or failure before the
 * helper is bootstrapped restores the plist files and pointers exactly.
 */
export async function guardedReload({ finalCheck, writePlists, restorePlists, activate, restorePointers, bootstrapHelper, log = console }) {
  await finalCheck('final check');
  const plistUndo = writePlists();
  let pointerUndo = null;
  try {
    pointerUndo = activate();
    await finalCheck('pre-reload check');
    bootstrapHelper();
  } catch (error) {
    if (pointerUndo) restorePointers(pointerUndo);
    restorePlists(plistUndo);
    log.error(`[install] restored the previous plists${pointerUndo ? ' and release pointers' : ''}; no job was reloaded`);
    throw error;
  }
}

/** The plan lines every run prints first, including --dry-run. */
export function describePlan({ bounded, releaseId, releaseServices, plan, pending, occupancy, allowActive }) {
  const lines = [`[install] mode   ${bounded ? 'bounded: release services only, no provisioning' : 'full install: provisioning and every job'}`];
  if (releaseId) lines.push(`[install] release ${releaseId} would be snapshotted and activated for ${releaseServices.join(', ')}`);
  lines.push(`[install] reload ${plan.reload.length ? plan.reload.map((job) => `${job.label} (${job.reason})`).join('; ') : 'none'}`);
  if (plan.untouchedChanged.length) lines.push(`[install] NOT reloaded although their rendered plists differ (needs a separately approved full install): ${plan.untouchedChanged.join(', ')}`);
  lines.push(`[install] pending turns ${pending ?? 'no database yet'}`);
  lines.push(`[install] browsers ${describeOccupancy(occupancy)}`);
  if (allowActive) lines.push('[install] --allow-active-turns: pending turns will be interrupted. Use only for a human-authorized interruption.');
  return lines;
}
