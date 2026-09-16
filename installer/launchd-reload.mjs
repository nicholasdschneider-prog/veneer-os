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

export async function reloadLaunchdServices({
  uid,
  services,
  healthChecks = [],
  launchctl = defaultLaunchctl,
  fetchImpl = globalThis.fetch,
  wait = sleep,
  log = console.log,
}) {
  const errors = [];

  // The runner is deliberately reloaded after the other persistent services.
  // This is not required for this launchd-owned helper to survive, but it keeps
  // the initiating Pro turn alive for as long as possible. The boot probe stays
  // last because it validates the completed install.
  const ordered = [
    ...services.filter((service) => service.label !== 'com.veneer.pro.runner' && service.label !== 'com.veneer.boot-probe'),
    ...services.filter((service) => service.label === 'com.veneer.pro.runner'),
    ...services.filter((service) => service.label === 'com.veneer.boot-probe'),
  ];

  for (const service of ordered) {
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
      log(`[install] loaded ${service.label}`);
    } catch (error) {
      const detail = errorDetail(error);
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

  return { ok: errors.length === 0, errors };
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
