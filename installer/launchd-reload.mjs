#!/usr/bin/env node
// Reload a set of launchd services from a launchd-owned helper process.
//
// The macOS installer can itself be launched by a Veneer Pro agent. Directly
// booting out com.veneer.pro.runner from that process tree kills the installer
// before it can bootstrap the runner again. The installer therefore starts
// this file as a separate one-shot launchd job and waits for its status file.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReloadSafe, browserOccupancy, restorePlistFiles } from './activation-guard.mjs';
import { restorePointers } from '../scripts/releases.mjs';
import { assertWithinWindow } from './window.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultLaunchctl(args, options = {}) {
  return execFileSync('launchctl', args, {
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

function errorDetail(error) {
  return String(error?.stderr || error?.stdout || error?.message || error).trim();
}

async function waitFor(predicate, { attempts, intervalMs, wait = sleep }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return true;
    await wait(intervalMs);
  }
  return predicate();
}

function serviceTarget(uid, label) {
  return `gui/${uid}/${label}`;
}

/**
 * The order jobs are reloaded in. The runner is deliberately reloaded after the
 * other persistent services: this is not required for the launchd-owned helper
 * to survive, but it keeps the initiating Pro turn alive for as long as
 * possible. The web watchdog follows web's release pointer, so it reloads right
 * after web. The boot probe stays last because it validates the install.
 */
export function reloadOrder(services) {
  const watchdog = (service) => service.label === 'com.veneer.web-watchdog';
  const rest = services.filter((service) => !watchdog(service) && service.label !== 'com.veneer.pro.runner' && service.label !== 'com.veneer.boot-probe');
  const webAt = rest.findIndex((service) => service.label === 'com.veneer.pro');
  return [
    ...rest.slice(0, webAt + 1),
    ...services.filter(watchdog),
    ...rest.slice(webAt + 1),
    ...services.filter((service) => service.label === 'com.veneer.pro.runner'),
    ...services.filter((service) => service.label === 'com.veneer.boot-probe'),
  ];
}

/** The idle gate the helper applies, built from the installer's manifest. Never adds an override. */
export function gateFromManifest(gate) {
  if (!gate) return null;
  const occupancy = () => browserOccupancy({ browserEnvFile: gate.browserEnvFile, port: gate.browserPort });
  return (phase, jobs) => assertReloadSafe({
    phase, jobs, dataDir: gate.dataDir, serverPackage: gate.serverPackage,
    maintenanceApproved: gate.maintenanceApproved === true, allowActive: gate.allowActive === true, occupancy,
  });
}

/**
 * Puts the plists and release pointers of jobs that were never reloaded back
 * to their pre-install state, so no loaded-but-not-reloaded job respawns (or
 * reboots) onto bytes it is not running. Jobs already reloaded keep their new
 * state: they run it. The web watchdog has no pointer of its own; it follows web.
 */
export function restoreNotReloaded(restore, services, { restorePlists = restorePlistFiles, restoreLinks = restorePointers } = {}) {
  if (!restore) return [];
  const targets = new Set(services.map((service) => service.plist));
  const owners = new Set(services.map((service) => restore.labelService?.[service.label]).filter(Boolean));
  const problems = [];
  try { restorePlists(restore.plists.filter((entry) => targets.has(entry.target))); } catch (error) { problems.push(error.message); }
  const pointers = (restore.pointers ?? []).filter((entry) => owners.has(entry.service));
  if (pointers.length) {
    try { restoreLinks(restore.dataDir, pointers, { reason: 'reload helper stopped before these jobs' }); } catch (error) { problems.push(error.message); }
  }
  return problems;
}

export async function reloadLaunchdServices({
  uid,
  services,
  healthChecks = [],
  gate = null,
  restore = null,
  deadline = null,
  now = () => Date.now(),
  check: idleCheck = gateFromManifest(gate),
  launchctl = defaultLaunchctl,
  fetchImpl = globalThis.fetch,
  wait = sleep,
  log = console.log,
  restoreOptions,
}) {
  const errors = [];

  const ordered = reloadOrder(services);
  // The approved window bounds every bootout, alongside the idle gate.
  const check = deadline || idleCheck ? async (phase, labels) => {
    assertWithinWindow(deadline, now, phase);
    if (idleCheck) await idleCheck(phase, labels);
    // A late idle answer must not carry a bootout past the window.
    assertWithinWindow(deadline, now, phase);
  } : null;
  const jobs = ordered.map((service) => ({ label: service.label, outcome: 'not_started' }));

  // Stop at the first refusal: nothing after it is booted out, nothing is
  // retried or forced, and jobs never reached go back to their prior state.
  const stop = (index, phase, error) => {
    const code = error.code === 'refused_deadline' ? 'refused_deadline' : 'refused_idle';
    jobs[index] = { ...jobs[index], outcome: 'refused', code, detail: error.message };
    const untouched = ordered.slice(index);
    const problems = restoreNotReloaded(restore, untouched, restoreOptions);
    for (const job of jobs.slice(index)) job.restored = problems.length === 0 && Boolean(restore);
    errors.push(`${phase}: ${error.message}`);
    for (const problem of problems) errors.push(problem);
    log(`[install] REFUSED ${phase}; stopped. Reloaded: ${jobs.filter((job) => job.outcome === 'reloaded').map((job) => job.label).join(', ') || 'none'}. Restored and not reloaded: ${untouched.map((service) => service.label).join(', ')}${problems.length ? ' (RESTORE INCOMPLETE)' : ''}`);
    return { ok: false, refused: true, refusal: code, errors, jobs };
  };

  if (check) {
    try { await check('helper start', ordered.map((service) => service.label)); }
    catch (error) { return stop(0, 'helper start', error); }
  }

  for (const [index, service] of ordered.entries()) {
    if (check) {
      try { await check(`before ${service.label}`, [service.label]); }
      catch (error) { return stop(index, `before ${service.label}`, error); }
    }
    // Immediately before the irreversible bootout, with a fresh clock read; an
    // expiry here stops and restores exactly like any other refusal.
    try { assertWithinWindow(deadline, now, `bootout ${service.label}`); }
    catch (error) { return stop(index, `bootout ${service.label}`, error); }
    const target = serviceTarget(uid, service.label);
    try {
      try {
        launchctl(['bootout', target]);
      } catch {
        // A fresh Mac has no existing job to unload.
      }

      const disappeared = await waitFor(() => {
        try {
          launchctl(['print', target]);
          return false;
        } catch {
          return true;
        }
      }, { attempts: 100, intervalMs: 100, wait });
      if (!disappeared) throw new Error('launchd still knew the job 10s after bootout');

      launchctl(['bootstrap', `gui/${uid}`, service.plist]);
      launchctl(['enable', target]);
      launchctl(['print', target]);
      jobs[index].outcome = 'reloaded';
      log(`[install] loaded ${service.label}`);
    } catch (error) {
      const detail = errorDetail(error);
      jobs[index] = { ...jobs[index], outcome: 'failed', detail: detail || 'launchctl reload failed' };
      errors.push(`${service.label}: ${detail || 'launchctl reload failed'}`);
      // Continue so one bad optional/ancillary job cannot strand a later core
      // service the way the former inline installer did.
    }
  }

  for (const check of healthChecks) {
    const healthy = await waitFor(async () => {
      try {
        const response = await fetchImpl(check.url, {
          method: check.method ?? 'GET',
          headers: check.headers,
          body: check.body,
          signal: AbortSignal.timeout(check.timeoutMs ?? 1_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    }, { attempts: check.attempts ?? 100, intervalMs: check.intervalMs ?? 200, wait });
    if (!healthy) errors.push(`${check.name}: did not become healthy at ${check.url}`);
    else log(`[install] healthy ${check.name}`);
  }

  return { ok: errors.length === 0, errors, jobs };
}

export function renderReloadJobPlist({ label, nodeBin, helperPath, manifestPath, statusPath, logPath }) {
  const escapeXml = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  const args = [nodeBin, helperPath, '--manifest', manifestPath, '--status', statusPath];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

export async function waitForReloadStatus(statusPath, runId, { attempts = 900, intervalMs = 200, wait = sleep } = {}) {
  let status = null;
  const found = await waitFor(() => {
    try {
      const candidate = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      if (candidate.runId !== runId) return false;
      status = candidate;
      return true;
    } catch {
      return false;
    }
  }, { attempts, intervalMs, wait });
  return found ? status : null;
}

function writeJsonAtomic(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const manifestPath = value('--manifest');
  const statusPath = value('--status');
  if (!manifestPath || !statusPath) throw new Error('usage: launchd-reload.mjs --manifest FILE --status FILE');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let result;
  try {
    result = await reloadLaunchdServices(manifest);
  } catch (error) {
    result = { ok: false, errors: [errorDetail(error) || 'unexpected reload failure'] };
  }
  writeJsonAtomic(statusPath, {
    runId: manifest.runId,
    completedAt: new Date().toISOString(),
    ...result,
  });
  process.exitCode = result.ok ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
