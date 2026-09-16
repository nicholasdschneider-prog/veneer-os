#!/usr/bin/env node
// Install (or re-install) Veneer OS as launchd user agents on macOS.
//
// What this script arranges:
//   - launchd agents, KeepAlive instead of Restart
//   - no EnvironmentFile, so the env file path is passed and the service loads it
//   - Chrome lives in an app bundle (resolved via server/src/platform.ts)
//
// Node, not shell, so the same checkout installs identically everywhere.
//
//   node installer/install-darwin.mjs [--code-dir DIR] [--dry-run]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_BROWSER_VERSION, provisionAgentBrowser } from './agent-browser.mjs';
import { browserManagerPaths, provisionLocalBrowserManager } from './browser-manager.mjs';
import { loadEnvFile, readEnvFile, upsertEnvValues, validateInstallEnv } from './env.mjs';
import { renderReloadJobPlist, waitForReloadStatus } from './launchd-reload.mjs';
import { provisionNodeShellProfile } from './node-shell-profile.mjs';

const SERVICES = [
  { label: 'com.veneer.pro', plist: 'com.veneer.pro.plist' },
  { label: 'com.veneer.pro.app-runner', plist: 'com.veneer.pro.app-runner.plist' },
  { label: 'com.veneer.pro.term', plist: 'com.veneer.pro.term.plist' },
  { label: 'com.veneer.supermemory', plist: 'com.veneer.supermemory.plist', optional: true, secret: true },
  { label: 'com.veneer.chrome', plist: 'com.veneer.chrome.plist', needsChrome: true },
  // The browser manager is local on Veneer OS: same Mac, native Chrome, both
  // listeners on loopback. Not optional — Veneer Browser is part of the product
  // — but it cannot run without a Chrome binary, which preflight also demands.
  { label: 'com.veneer.browser-manager', plist: 'com.veneer.browser-manager.plist', needsChrome: true },
  { label: 'com.veneer.pro.cloudflared', plist: 'com.veneer.pro.cloudflared.plist', needsTunnel: true },
  { label: 'com.veneer.pro.backup', plist: 'com.veneer.pro.backup.plist' },
  // Reload the runner after every other persistent service. The actual reload
  // runs in a launchd-owned helper, so an install started by a Pro agent cannot
  // kill itself between bootout and bootstrap.
  { label: 'com.veneer.pro.runner', plist: 'com.veneer.pro.runner.plist' },
  // One shot per boot, last so it is bootstrapped after everything it checks.
  { label: 'com.veneer.boot-probe', plist: 'com.veneer.boot-probe.plist' },
];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dryRun = args.includes('--dry-run');
const skipProviderRuntimes = args.includes('--skip-provider-runtimes');

if (process.platform !== 'darwin') {
  console.error('install-darwin.mjs is for macOS. Veneer OS runs on a single Mac and has no other installer.');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const codeDir = path.resolve(flag('code-dir', appRoot));
const home = os.homedir();
const agentsDir = path.join(home, 'Library', 'LaunchAgents');
const logDir = path.join(home, 'Library', 'Logs', 'veneer-pro');
const envFile = process.env.VP_ENV_FILE || path.join(home, '.config', 'veneer-pro', 'env');
loadEnvFile(envFile);
// The services run with their own HOME so Pro's agent state (~/.claude,
// ~/.codex) never mixes with the login user's — what the dedicated `veneer`
// account gave us on the Linux host.
const serviceHome = path.resolve(flag('home', path.join(home, 'veneer-pro-home')));
// Installed per-host by https://supermemory.ai/install (the binary is
// platform-specific). Without it the memory features stay off; chats are fine.
const supermemoryBin = path.join(home, '.supermemory', 'bin', 'supermemory-server');
const cloudflaredBin = [
  path.join(home, '.local', 'bin', 'cloudflared'),
  '/opt/homebrew/bin/cloudflared',
  '/usr/local/bin/cloudflared',
].find((candidate) => fs.existsSync(candidate)) ?? null;
const tunnelTokenFile = path.join(home, '.config', 'veneer-pro', 'cloudflared-token');
// The shared browser the desktop viewer streams. Same discovery order as
// server/src/platform.ts resolveChrome().
const chromeBin = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((candidate) => fs.existsSync(candidate)) ?? null;
const cdpPort = process.env.VP_DESKTOP_CDP_PORT || '9223';
// The loopback certificate the local browser manager serves. Computed from the
// service home rather than read back from the TLS script so --dry-run can
// render the real plists without writing anything.
const browserPaths = browserManagerPaths(serviceHome, envFile);
let browserCertFile = browserPaths.certFile;
const supermemoryEnvFile = process.env.VP_SUPERMEMORY_ENV_FILE
  || path.join(home, '.config', 'veneer-pro', 'supermemory.env');

// Supermemory is a compiled binary, so unlike our own services it cannot read
// an env file itself, and launchd has no EnvironmentFile. Its variables are
// rendered into the plist instead — which is why that plist is written 0600.
function supermemoryEnvXml() {
  let contents;
  try {
    contents = fs.readFileSync(supermemoryEnvFile, 'utf8');
  } catch {
    return '';
  }
  const lines = [];
  for (const line of contents.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!match || line.trim().startsWith('#')) continue;
    const value = match[2].replace(/^(['"])([\s\S]*)\1$/, '$2');
    lines.push(`    <key>${match[1]}</key>\n    <string>${escapeXml(value)}</string>`);
  }
  return lines.join('\n');
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// launchd agents start with a minimal PATH that has neither Homebrew nor a
// version-manager shim, so node's own directory has to be on it explicitly.
// process.execPath is the real binary, which for Homebrew is a versioned Cellar
// path — a `brew upgrade node` would leave the agent pointing at a directory
// that no longer exists. Prefer a stable symlink that resolves to this same
// Node, so the service survives routine upgrades.
function stableNodePath() {
  const real = fs.realpathSync(process.execPath);
  for (const candidate of [
    '/opt/homebrew/opt/node@24/bin/node',
    '/usr/local/opt/node@24/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ]) {
    try {
      if (fs.realpathSync(candidate) === real) return candidate;
    } catch {
      /* not present */
    }
  }
  return process.execPath;
}

const nodeBin = stableNodePath();
const dopplerBins = [
  path.join(home, '.local', 'bin', 'doppler'),
  '/opt/homebrew/bin/doppler',
  '/usr/local/bin/doppler',
];
// ~/.local/bin is where the agent CLIs install themselves (`claude`, `codex`),
// and config.ts defaults VP_CLAUDE_BIN/VP_CODEX_BIN to those bare names — so
// without this entry the runner resolves neither and every turn dies with
// "spawn codex ENOENT". Setting PATH in the env file does not rescue it: the
// plist's EnvironmentVariables win, because envFile.ts never overwrites a
// variable that is already set. Fleet hosts install the CLIs in the service
// home; keep the login path too for older Mac installs.
//
// /usr/sbin matters: macOS reads the hardware id via ioreg there, and
// Supermemory derives its at-rest encryption key from it. Without it the
// service starts, fails to derive the key, and crash-loops.
const execPath = [
  path.dirname(nodeBin),
  path.join(serviceHome, '.local', 'bin'),
  path.join(home, '.local', 'bin'),
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
]
  .filter((entry, index, all) => all.indexOf(entry) === index)
  .join(':');

let envWarnings = [];

function preflight() {
  const problems = [];
  const [nodeMajor] = process.versions.node.split('.').map(Number);
  if (nodeMajor !== 24) {
    problems.push(`Node 24 is required for Veneer Pro (found ${process.versions.node}).`);
  }
  if (!fs.existsSync(path.join(codeDir, 'server', 'dist', 'index.js'))) {
    problems.push(`${codeDir}/server/dist is missing — run \`npm run build\` first.`);
  }
  if (!fs.existsSync(envFile)) {
    problems.push(`env file not found at ${envFile} — create it before installing (DATA_DIR, PORT, VP_IDENTITY, …).`);
  } else {
    // Read the file rather than process.env: loadEnvFile() does not override
    // variables already exported in this shell, so process.env can disagree
    // with what the services will actually load from disk.
    const env = validateInstallEnv(readEnvFile(envFile));
    for (const problem of env.problems) problems.push(`${envFile}: ${problem}`);
    envWarnings = env.warnings;
  }
  if (!chromeBin) {
    problems.push('Google Chrome or Chromium is missing; the shared desktop and Agent Browser cannot run.');
  }
  // better-sqlite3 and node-pty are native. If a prebuild did not match this
  // Node/arch, npm falls back to compiling, which needs the Xcode CLT.
  try {
    execFileSync('xcode-select', ['-p'], { stdio: 'ignore' });
  } catch {
    problems.push('Xcode Command Line Tools are missing (`xcode-select --install`); native modules cannot build.');
  }
  // A present native module is not enough: some node-pty packages have shipped
  // without the matching spawn-helper, so require() succeeds but pty.spawn()
  // fails. Exercise the installed package through the service's Node runtime.
  try {
    const serverPackage = path.join(codeDir, 'server', 'package.json');
    const probe = `
      const { createRequire } = require('node:module');
      const load = createRequire(${JSON.stringify(serverPackage)});
      const pty = load('node-pty');
      const term = pty.spawn('/bin/sh', ['-lc', 'printf veneer-node-pty-ok'], {
        name: 'xterm-color', cols: 80, rows: 24,
        cwd: ${JSON.stringify(os.tmpdir())}, env: process.env,
      });
      let output = '';
      const timer = setTimeout(() => { term.kill(); process.exit(1); }, 3000);
      term.onData((data) => { output += data; });
      term.onExit(() => {
        clearTimeout(timer);
        process.exit(output.includes('veneer-node-pty-ok') ? 0 : 1);
      });
    `;
    execFileSync(nodeBin, ['-e', probe], { stdio: 'ignore', timeout: 5000 });
  } catch {
    problems.push('node-pty cannot spawn a real PTY — run: npm rebuild node-pty --build-from-source');
  }
  return problems;
}

// Doppler is optional on Veneer OS: without it the secret vault features stay
// off and everything else works, so this only ever warns.
function ensureDopplerCli() {
  if (dopplerBins.some((candidate) => fs.existsSync(candidate))) return;
  const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((candidate) => fs.existsSync(candidate));
  if (!brew) {
    console.warn('[install] Doppler CLI is missing and Homebrew is unavailable — secret storage stays off.');
    return;
  }
  console.log('[install] installing Doppler CLI');
  try {
    execFileSync(brew, ['install', 'dopplerhq/cli/doppler'], { stdio: 'inherit' });
  } catch {
    console.warn('[install] Doppler CLI install failed — secret storage stays off.');
  }
}

// Best effort by design: this runs after the services are already loaded, so it
// must never be able to fail an otherwise good install.
function warnAboutUnreachableProjectRoots() {
  try {
    const env = fs.readFileSync(envFile, 'utf8');
    const dataDir = /^\s*(?:export\s+)?DATA_DIR\s*=\s*(.+)$/m.exec(env)?.[1]?.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (!dataDir) return;
    const db = path.join(dataDir, 'veneer-pro.db');
    if (!fs.existsSync(db)) return; // fresh install, no history to migrate
    const rows = execFileSync('sqlite3', ['-readonly', '-json', db, 'select slug, root_dir from projects'], {
      encoding: 'utf8',
    });
    const unreachable = JSON.parse(rows || '[]').filter((row) => row.root_dir && !fs.existsSync(row.root_dir));
    if (!unreachable.length) return;
    console.warn('\n[install] WARNING — these projects point at directories that do not exist on this host:');
    for (const row of unreachable) console.warn(`  ${row.slug}: ${row.root_dir}`);
    console.warn('  Every turn in those projects will fail until they are remapped, and their');
    console.warn('  existing transcripts will not be found. Fix both in one step with:');
    console.warn('    node scripts/migrate-host-paths.mjs \\');
    console.warn('      --old-prefix <old home> --new-prefix <new home> --old-source-dir <old VP_SOURCE_DIR>');
    console.warn('  It is a dry run unless you pass --apply; see the script header for --map.');
  } catch {
    /* never block an install on this */
  }
}

function render(templateFile) {
  return fs
    .readFileSync(path.join(appRoot, 'deploy', 'launchd', templateFile), 'utf8')
    .replaceAll('__NODE__', nodeBin)
    .replaceAll('__CODE_DIR__', codeDir)
    .replaceAll('__LOG_DIR__', logDir)
    .replaceAll('__ENV_FILE__', envFile)
    .replaceAll('__HOME__', serviceHome)
    // The boot probe reports to a human, so it runs as the login user: its
    // report lands where that human looks, and it can read ~/.doppler.
    .replaceAll('__USER_HOME__', home)
    .replaceAll('__SUPERMEMORY_BIN__', supermemoryBin)
    .replaceAll('__SUPERMEMORY_ENV__', supermemoryEnvXml())
    .replaceAll('__CHROME__', chromeBin ?? '')
    // Node reads NODE_EXTRA_CA_CERTS at process start, so the env file the
    // services load themselves is too late: without this the web and runner
    // processes reject the manager's self-signed loopback certificate.
    .replaceAll('__EXTRA_CA__', browserCertFile)
    .replaceAll('__CDP_PORT__', cdpPort)
    .replaceAll('__CLOUDFLARED__', cloudflaredBin ?? '')
    .replaceAll('__TUNNEL_TOKEN_FILE__', tunnelTokenFile)
    .replaceAll('__PATH__', execPath);
}

const problems = preflight();
// Warnings first: they are still worth seeing on a run that is about to abort
// for an unrelated reason, so the operator can fix everything in one pass.
for (const warning of envWarnings) console.warn(`[install] WARNING — ${warning}`);
if (problems.length) {
  console.error('Cannot install:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`[install] code   ${codeDir}`);
console.log(`[install] node   ${nodeBin}`);
console.log(`[install] env    ${envFile}`);
console.log(`[install] logs   ${logDir}`);
console.log(`[install] home   ${serviceHome}`);
console.log(`[install] browser agent-browser ${AGENT_BROWSER_VERSION}`);

if (dryRun) {
  for (const service of SERVICES) {
    console.log(`\n----- ${service.label} -----\n${render(service.plist)}`);
  }
  process.exit(0);
}

if (!skipProviderRuntimes) {
  const serviceNpm = path.join(path.dirname(nodeBin), 'npm');
  try {
    execFileSync(nodeBin, [
      path.join(here, 'provider-runtimes.mjs'),
      '--service-home', serviceHome,
      '--npm-bin', fs.existsSync(serviceNpm) ? serviceNpm : 'npm',
    ], { stdio: 'inherit' });
  } catch (error) {
    console.error(`[install] provider runtimes could not be provisioned: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

upsertEnvValues(envFile, {
  VP_CLAUDE_BIN: path.join(serviceHome, '.local', 'bin', 'claude'),
  VP_CODEX_BIN: path.join(serviceHome, '.local', 'bin', 'codex'),
  VP_GROK_BIN: path.join(serviceHome, '.local', 'bin', 'grok'),
  // Veneer owns the provider runtimes so a CLI cannot self-update out from
  // under an install.
  DISABLE_UPDATES: '1',
});

ensureDopplerCli();

fs.mkdirSync(agentsDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
try {
  const shellProfile = provisionNodeShellProfile({ serviceHome, nodeBin });
  console.log(`[install] shell  ${shellProfile}`);
} catch (err) {
  console.error(`Cannot install: ${err?.message ?? err}`);
  process.exit(1);
}
try {
  const browser = provisionLocalBrowserManager({ codeDir, serviceHome, envFile, nodeBin });
  browserCertFile = browser.certFile;
  console.log(`[install] browser manager tls ${browser.certFile}`);
  console.log(`[install] browser manager identity ${browser.browserEnvFile}`);
} catch (err) {
  console.error(`Cannot install: ${err?.message ?? err}`);
  process.exit(1);
}
try {
  const serviceNpm = path.join(path.dirname(nodeBin), 'npm');
  provisionAgentBrowser({
    serviceHome,
    chromeBin,
    npmBin: fs.existsSync(serviceNpm) ? serviceNpm : 'npm',
  });
} catch (err) {
  console.error(`Cannot install: ${err?.message ?? err}`);
  process.exit(1);
}

const uid = process.getuid();
// Git tags are updated only by the manual Studio command. Remove the former
// launchd poller on every install so an old archive client cannot overwrite a
// manual Git checkout.
try {
  execFileSync('launchctl', ['bootout', `gui/${uid}/com.veneer.pro.update`], { stdio: 'ignore' });
} catch {
  /* not loaded */
}
fs.rmSync(path.join(agentsDir, 'com.veneer.pro.update.plist'), { force: true });

const renderedServices = [];
for (const service of SERVICES) {
  if (service.optional && !fs.existsSync(supermemoryBin)) {
    console.log(`[install] skipped ${service.label} (supermemory-server not installed)`);
    continue;
  }
  if (service.needsChrome && !chromeBin) {
    console.log(`[install] skipped ${service.label} (no Chrome or Chromium found)`);
    continue;
  }
  if (service.needsTunnel && (!cloudflaredBin || !fs.existsSync(tunnelTokenFile))) {
    console.log(`[install] skipped ${service.label} (cloudflared or its token file is missing)`);
    continue;
  }
  const target = path.join(agentsDir, `${service.label}.plist`);
  // The Supermemory plist carries its model-provider key, so it is not world
  // readable like the others.
  const mode = service.secret ? 0o600 : 0o644;
  fs.writeFileSync(target, render(service.plist), { mode });
  // writeFileSync only applies mode when it creates the file, so a re-install
  // over an existing plist would silently keep the old, wider permissions.
  fs.chmodSync(target, mode);
  renderedServices.push({ label: service.label, plist: target });
}

// Never reload these jobs inline. This installer is commonly run by a Veneer
// Pro Platform Dev agent, and booting out the runner kills that entire process
// tree. A separate one-shot launchd job survives the runner restart, reloads
// every remaining service even if one fails, and records a durable result.
const reloadLabel = 'com.veneer.pro.installer-reload';
const reloadTarget = `gui/${uid}/${reloadLabel}`;
const reloadDir = path.join(logDir, '.launchd-install');
const manifestPath = path.join(reloadDir, 'manifest.json');
const statusPath = path.join(reloadDir, 'status.json');
const helperPlist = path.join(reloadDir, `${reloadLabel}.plist`);
const helperLog = path.join(logDir, 'veneer-install.log');
const helperPath = path.join(here, 'launchd-reload.mjs');
const runId = `${Date.now()}-${process.pid}`;
fs.mkdirSync(reloadDir, { recursive: true, mode: 0o700 });

// An install started inside Pro may have been killed after the helper finished,
// leaving its inactive one-shot job registered. Refuse to interrupt a genuinely
// active concurrent install, but clean up a completed predecessor.
try {
  const existing = execFileSync('launchctl', ['print', reloadTarget], { encoding: 'utf8' });
  if (/\bstate = running\b/.test(existing)) {
    console.error('Cannot install: another macOS service reload is still running.');
    process.exit(1);
  }
  execFileSync('launchctl', ['bootout', reloadTarget], { stdio: 'ignore' });
} catch {
  /* no prior helper is loaded */
}

fs.rmSync(statusPath, { force: true });
fs.writeFileSync(manifestPath, `${JSON.stringify({
  runId,
  uid,
  services: renderedServices,
  healthChecks: [{
    name: 'Veneer Pro web and runner',
    url: `http://127.0.0.1:${process.env.PORT || 3100}/healthz`,
    attempts: 150,
    intervalMs: 200,
  }],
}, null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(helperPlist, renderReloadJobPlist({
  label: reloadLabel,
  nodeBin,
  helperPath,
  manifestPath,
  statusPath,
  logPath: helperLog,
}), { mode: 0o600 });

execFileSync('launchctl', ['bootstrap', `gui/${uid}`, helperPlist], { stdio: 'inherit' });
const reloadStatus = await waitForReloadStatus(statusPath, runId);
if (!reloadStatus) {
  console.error(`Cannot install: launchd reload did not finish; check ${helperLog}`);
  process.exit(1);
}
try {
  execFileSync('launchctl', ['bootout', reloadTarget], { stdio: 'ignore' });
} catch {
  /* the one-shot helper is already gone */
}
fs.rmSync(reloadDir, { recursive: true, force: true });
if (!reloadStatus.ok) {
  console.error('Cannot install: one or more macOS services failed to reload:');
  for (const error of reloadStatus.errors) console.error(`  - ${error}`);
  console.error(`See ${helperLog}`);
  process.exit(1);
}

// A host migration carries the DB across verbatim, so `projects.root_dir` still
// holds the *previous* host's absolute paths. That is not cosmetic:
// createWorkspaceResolver does mkdirSync(root_dir) before every turn, and on
// macOS /home is an autofs mount that cannot be written — so a Linux-era
// /home/<user>/… root_dir makes every project-scoped turn throw. Warn loudly;
// fixing it needs the old paths, which only the operator knows.
warnAboutUnreachableProjectRoots();

console.log('\nInstalled. Check status with:');
console.log(`  launchctl print gui/${uid}/com.veneer.pro | head`);
console.log('  curl -fsS http://127.0.0.1:${PORT:-3100}/healthz');
console.log('Restart with:');
console.log('  npm run restart');
