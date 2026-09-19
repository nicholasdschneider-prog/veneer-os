#!/usr/bin/env node
// Restart Veneer Pro services on any platform.
//
// Each service writes DATA_DIR/run/<service>.pid at boot and drains on SIGTERM:
// it stops accepting connections, lets in-flight requests finish, releases its
// agent children and SQLite handle, then exits 0. Its supervisor — systemd
// `Restart=always` on Linux, launchd `KeepAlive` on macOS — respawns it.
//
// Signalling the pid is what makes this identical on both platforms; `systemctl`
// is Linux-only. Nothing here is GNU- or shell-specific.
//
// The browser manager is the exception: it keeps no pid file, so it is bounced
// through its own supervisor (launchd) and skipped where it is not installed.
//
//   node scripts/restart.mjs                  # all services
//   node scripts/restart.mjs veneer-pro-runner
//   npm run restart -- veneer-pro-runner

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICES = ['veneer-pro', 'veneer-pro-runner', 'veneer-pro-app-runner', 'veneer-pro-term'];
// Supervisor-restarted services: no pid file, no drain contract, so `launchctl
// kickstart -k` does the whole job. A host without the job loaded is fine.
const LAUNCHD_SERVICES = { 'veneer-browser-manager': 'com.veneer.browser-manager' };
const ALL_SERVICES = [...SERVICES, ...Object.keys(LAUNCHD_SERVICES)];
const REQUIRED_NODE_MAJOR = 24;
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '..');
const serverPackage = path.join(appRoot, 'server', 'package.json');
// How long to wait for the old process to exit, then for the supervisor to
// bring a new one up. The drain itself is bounded at 10s inside the service.
const EXIT_TIMEOUT_MS = 20_000;
const RESPAWN_TIMEOUT_MS = 30_000;

const envFile = process.env.VP_ENV_FILE || path.join(os.homedir(), '.config', 'veneer-pro', 'env');

function valueFromEnvFile(name) {
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const match = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`).exec(line);
      if (match) return match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    /* no env file: fall through to the default */
  }
  return null;
}

const rawDataDir =
  process.env.DATA_DIR || valueFromEnvFile('DATA_DIR') || path.join(os.homedir(), '.local', 'share', 'veneer-pro');
const dataDir = rawDataDir.startsWith('~') ? path.join(os.homedir(), rawDataDir.slice(1)) : rawDataDir;

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const requested = args.filter((arg) => arg !== '--check');
const unknown = requested.filter((name) => !ALL_SERVICES.includes(name));
if (unknown.length) {
  console.error(`unknown service(s): ${unknown.join(', ')}`);
  console.error(`known services: ${ALL_SERVICES.join(', ')}`);
  process.exit(2);
}
const targets = requested.length ? requested : ALL_SERVICES;

const pidFile = (service) => path.join(dataDir, 'run', `${service}.pid`);

function launchdNodePath() {
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.veneer.pro.plist');
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', 'ProgramArguments.0', 'raw', '-o', '-', plist], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function systemdNodePath() {
  const unitFiles = [
    path.join(os.homedir(), '.config', 'systemd', 'user', 'veneer-pro.service'),
    path.join(appRoot, 'deploy', 'systemd', 'veneer-pro.service'),
  ];
  for (const file of unitFiles) {
    try {
      const match = /^ExecStart=(?:"([^"]+)"|(\S+))/m.exec(fs.readFileSync(file, 'utf8'));
      if (match) return match[1] || match[2];
    } catch {
      /* try the next unit file */
    }
  }
  return null;
}

function serviceNodePath() {
  if (process.env.VP_SERVICE_NODE?.trim()) return process.env.VP_SERVICE_NODE.trim();
  if (process.platform === 'darwin') return launchdNodePath() || process.execPath;
  if (process.platform === 'linux') return systemdNodePath() || process.execPath;
  return process.execPath;
}

function checkServiceRuntime() {
  const node = serviceNodePath();
  const code = `
    const { createRequire } = require('node:module');
    const major = Number(process.versions.node.split('.')[0]);
    if (major !== ${REQUIRED_NODE_MAJOR}) {
      throw new Error('Node ${REQUIRED_NODE_MAJOR} is required; found ' + process.version);
    }
    const load = createRequire(${JSON.stringify(serverPackage)});
    const Database = load('better-sqlite3');
    const db = new Database(':memory:');
    db.prepare('select 1').get();
    db.close();
    load('node-pty');
    process.stdout.write(process.version + ' ABI ' + process.versions.modules);
  `;
  try {
    const version = execFileSync(node, ['-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    console.log(`[restart] preflight: ${node} ${version}; native modules load`);
    return true;
  } catch (error) {
    const detail = String(error.stderr || error.message || error).trim().split('\n').slice(0, 8).join('\n');
    console.error(`[restart] blocked: the configured service runtime failed its preflight (${node})`);
    if (detail) console.error(detail);
    return false;
  }
}

function readPid(service) {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile(service), 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Absolute entry script per service, used to verify that a pid actually IS the
// service before signalling it. A pid file can go stale while the real process
// lives on (seen 2026-08-13: a doomed manual start overwrote run/veneer-pro.pid,
// so ship restarts signalled nothing and the old web kept serving old code).
const serviceEntries = {
  'veneer-pro': path.join(appRoot, 'server', 'dist', 'index.js'),
  'veneer-pro-runner': path.join(appRoot, 'server', 'dist', 'runner', 'index.js'),
  'veneer-pro-app-runner': path.join(appRoot, 'server', 'dist', 'appRunner', 'index.js'),
  'veneer-pro-term': path.join(appRoot, 'server', 'dist', 'terminalService', 'index.js'),
};

function pidCommand(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function findServicePid(service) {
  const entry = serviceEntries[service];
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
    for (const row of rows) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(row);
      if (!match) continue;
      const pid = Number(match[1]);
      // Require a node invocation of the entry script, so a stray editor or
      // tail holding the path in its arguments is never signalled.
      if (pid === process.pid || !match[2].includes(entry) || !/\bnode(\d*|\.exe)?\b/.test(match[2])) continue;
      return pid;
    }
  } catch {
    /* ps unavailable: caller falls back to the pid file alone */
  }
  return null;
}

/**
 * The pid to signal: the pid file when it points at a live process running this
 * service's entry script, otherwise the live process found by command line.
 * Returns null only when no live instance exists at all.
 */
function livePid(service) {
  const filed = readPid(service);
  if (filed !== null && isRunning(filed)) {
    const command = pidCommand(filed);
    // A pid we cannot inspect is assumed valid — EPERM etc. should not turn a
    // working restart into a manual hunt.
    if (command === null || command.includes(serviceEntries[service])) return filed;
    console.error(`[restart] ${service}: pid file ${filed} is a different program (${command}); ignoring it`);
  }
  const discovered = findServicePid(service);
  if (discovered !== null && discovered !== filed) {
    console.log(`[restart] ${service}: found live process ${discovered} by command line (pid file said ${filed ?? 'nothing'})`);
  }
  return discovered;
}

function startMissingLinuxService(service) {
  if (process.platform !== 'linux') return false;
  const unit = `${service}.service`;
  const unitFile = path.join(os.homedir(), '.config', 'systemd', 'user', unit);
  if (!fs.existsSync(unitFile)) return false;
  try {
    // An update can introduce a service before the installed unit set knows
    // about it. Enable that new unit before the normal restart.
    execFileSync('systemctl', ['--user', 'enable', '--now', unit], { stdio: 'inherit' });
    return true;
  } catch (err) {
    console.error(`[restart] ${service}: could not enable its new service unit: ${err.message}`);
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(200);
  }
  return predicate();
}

const ports = {
  'veneer-pro': Number(process.env.PORT || valueFromEnvFile('PORT') || 3100),
  'veneer-pro-runner': Number(process.env.VP_RUNNER_PORT || valueFromEnvFile('VP_RUNNER_PORT') || 3101),
  'veneer-pro-app-runner': Number(process.env.VP_APP_RUNNER_PORT || valueFromEnvFile('VP_APP_RUNNER_PORT') || 3102),
  'veneer-pro-term': Number(process.env.VP_TERM_PORT || valueFromEnvFile('VP_TERM_PORT') || 3103),
  'veneer-browser-manager': Number(
    process.env.VENEER_BROWSER_MANAGER_PORT || valueFromEnvFile('VENEER_BROWSER_MANAGER_PORT') || 7300,
  ),
};

async function isHealthy(service) {
  const port = ports[service];
  const appRunner = service === 'veneer-pro-app-runner';
  if (service in LAUNCHD_SERVICES) {
    try {
      // The manager keeps a plain loopback listener beside the TLS one purely so
      // local callers like this have something to ask without pinning a root.
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
      return response.ok;
    } catch {
      return false;
    }
  }
  try {
    const response = await fetch(
      appRunner ? `http://127.0.0.1:${port}/rpc/statuses` : `http://127.0.0.1:${port}/healthz`,
      {
        method: appRunner ? 'POST' : 'GET',
        headers: appRunner ? { 'content-type': 'application/json' } : undefined,
        body: appRunner
          ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'statuses', params: {} })
          : undefined,
        signal: AbortSignal.timeout(1_000),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

// launchd owns this one end to end: there is no pid file to drain and no port
// to signal, so the kick is the restart. Not being installed is not a failure —
// a checkout without the browser manager set up still restarts everything else.
async function restartLaunchdService(service) {
  const label = LAUNCHD_SERVICES[service];
  if (process.platform !== 'darwin') {
    console.log(`[restart] ${service}: only launchd runs this service; nothing to do here`);
    return true;
  }
  const target = `gui/${process.getuid()}/${label}`;
  try {
    execFileSync('/bin/launchctl', ['print', target], { stdio: 'ignore' });
  } catch {
    console.log(`[restart] ${service}: ${label} is not loaded; skipping`);
    return true;
  }
  try {
    execFileSync('/bin/launchctl', ['kickstart', '-k', target], { stdio: 'inherit' });
  } catch (err) {
    console.error(`[restart] ${service}: could not kickstart ${label}: ${err.message}`);
    return false;
  }
  if (!(await waitFor(() => isHealthy(service), RESPAWN_TIMEOUT_MS))) {
    console.error(`[restart] ${service}: did not answer /health within ${RESPAWN_TIMEOUT_MS}ms`);
    return false;
  }
  console.log(`[restart] ${service}: healthy`);
  return true;
}

async function restart(service) {
  if (service in LAUNCHD_SERVICES) return restartLaunchdService(service);
  const oldPid = livePid(service);
  if (oldPid === null) {
    if (startMissingLinuxService(service)) {
      const started = await waitFor(() => {
        const pid = readPid(service);
        return pid !== null && isRunning(pid);
      }, RESPAWN_TIMEOUT_MS);
      if (!started) {
        console.error(`[restart] ${service}: new service unit did not create a pid file`);
        return false;
      }
      if (!(await waitFor(() => isHealthy(service), RESPAWN_TIMEOUT_MS))) {
        console.error(`[restart] ${service}: new service unit did not become healthy`);
        return false;
      }
      console.log(`[restart] ${service}: enabled and healthy as pid ${readPid(service)}`);
      return true;
    }
    const filed = readPid(service);
    if (filed !== null) {
      console.error(`[restart] ${service}: stale pid ${filed} and no live process; waiting for the supervisor instead`);
    } else {
      console.error(`[restart] ${service}: no pid file at ${pidFile(service)} and no live process — is it running?`);
      return false;
    }
  } else {
    console.log(`[restart] ${service}: draining pid ${oldPid}`);
    try {
      process.kill(oldPid, 'SIGTERM');
    } catch (err) {
      console.error(`[restart] ${service}: could not signal ${oldPid}: ${err.message}`);
      return false;
    }
    if (!(await waitFor(() => !isRunning(oldPid), EXIT_TIMEOUT_MS))) {
      console.error(`[restart] ${service}: pid ${oldPid} still alive after ${EXIT_TIMEOUT_MS}ms`);
      return false;
    }
  }

  // The supervisor rewrites the pid file when the replacement boots.
  const respawned = await waitFor(() => {
    const pid = readPid(service);
    return pid !== null && pid !== oldPid && isRunning(pid);
  }, RESPAWN_TIMEOUT_MS);
  if (!respawned) {
    console.error(
      `[restart] ${service}: no replacement within ${RESPAWN_TIMEOUT_MS}ms — check the supervisor ` +
        '(systemd Restart=always / launchd KeepAlive) and the service logs',
    );
    return false;
  }
  if (!(await waitFor(() => isHealthy(service), RESPAWN_TIMEOUT_MS))) {
    console.error(`[restart] ${service}: replacement did not become healthy within ${RESPAWN_TIMEOUT_MS}ms`);
    return false;
  }
  console.log(`[restart] ${service}: healthy as pid ${readPid(service)}`);
  return true;
}

/**
 * Codex holds a per-thread writer lock in whichever process loaded the thread and
 * rewrites config.toml in its CODEX_HOME. A desktop Codex (the ChatGPT app) that
 * was launched from an agent shell inherits Veneer's CODEX_HOME — `open` forwards
 * the caller's environment — and then locks Veneer's threads and injects its
 * desktop plugins and MCP servers into every Veneer turn. Warn, do not block:
 * the adapter forks a locked thread, but the user should relaunch the app.
 */
function warnForeignCodexHome() {
  if (process.platform !== 'darwin') return;
  const serviceHome = process.env.VP_SERVICE_HOME || path.join(os.homedir(), 'veneer-pro-home');
  let listing = '';
  try {
    listing = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  } catch {
    return;
  }
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*ChatGPT\.app\/Contents\/MacOS\/ChatGPT.*)$/.exec(line);
    if (!match) continue;
    let env = '';
    try {
      env = execFileSync('ps', ['eww', '-o', 'command=', '-p', match[1]], { encoding: 'utf8' });
    } catch {
      continue;
    }
    const home = /(?:^|\s)CODEX_HOME=(\S+)/.exec(env)?.[1];
    if (home && home.startsWith(serviceHome)) {
      console.warn(`[restart] warning: ChatGPT.app (pid ${match[1]}) is running with Veneer's CODEX_HOME (${home}).`);
      console.warn('[restart]   It will hold writer locks on Veneer\'s Codex threads and rewrite the shared config.toml.');
      console.warn('[restart]   Quit it and reopen it from the Dock or Finder, never from an agent shell.');
    }
  }
}

if (!checkServiceRuntime()) process.exit(1);
warnForeignCodexHome();
if (checkOnly) process.exit(0);

let failed = false;
for (const service of targets) {
  if (!(await restart(service))) failed = true;
}
process.exit(failed ? 1 : 0);
