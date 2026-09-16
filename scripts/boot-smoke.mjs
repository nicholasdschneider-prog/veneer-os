#!/usr/bin/env node
// Boots the real web + runner processes against a throwaway DATA_DIR and free
// ports, then exercises the handful of things a unit test can't: a live
// SQLite write, a real node-pty spawn, a CDP attach to a headless Chrome, and
// two commands serializing through the Phase 1a shared-browser queue.
//
// This is NOT feature coverage — the unit suite (`npm test`) already owns
// that. Its only job is proving the BOOTED server's wiring is sound on this
// OS/arch/Node combination, the exact thing a cross-platform port can get
// wrong without any single unit test catching it (e.g. a native module whose
// prebuilt binary doesn't run on this platform). Keep it fast: a few seconds,
// not minutes.
//
// Runs standalone: `node scripts/boot-smoke.mjs`, after
// `npm run build` has produced server/dist.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as ptySpawn } from 'node-pty';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptsDir, '..');
const serverDist = path.join(appRoot, 'server', 'dist');

const BOOT_TIMEOUT_MS = 30_000;
const CHROME_TIMEOUT_MS = 15_000;
const PTY_TIMEOUT_MS = 10_000;

function ok(label) {
  console.log(`  ok  ${label}`);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return res;
      lastErr = new Error(`${url} -> HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastErr ?? new Error(`timed out waiting for ${url}`);
}

async function assertOk(label, res) {
  if (!res.ok) throw new Error(`${label} -> HTTP ${res.status}: ${await res.text()}`);
  return res;
}

function spawnService(entry, env) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => chunks.push(chunk));
  child.dump = () => Buffer.concat(chunks).toString('utf8');
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function main() {
  if (!fs.existsSync(serverDist)) {
    throw new Error(`${serverDist} is missing — run "npm run build" first.`);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-pro-smoke-'));
  const chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-pro-smoke-chrome-'));
  const [port, runnerPort, appRunnerPort, termPort, lanViewerPort, chromePort] = await Promise.all([
    getFreePort(),
    getFreePort(),
    getFreePort(),
    getFreePort(),
    getFreePort(),
    getFreePort(),
  ]);

  const { resolveChrome } = await import(path.join(serverDist, 'platform.js'));
  const chromeBin = resolveChrome();
  if (!chromeBin) throw new Error('No Chrome/Chromium binary found on this runner.');

  const chrome = spawn(chromeBin, [
    '--headless=new',
    `--remote-debugging-port=${chromePort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${chromeProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
  ], { stdio: 'ignore' });

  const env = {
    DATA_DIR: dataDir,
    PORT: String(port),
    VP_RUNNER_PORT: String(runnerPort),
    VP_APP_RUNNER_PORT: String(appRunnerPort),
    VP_TERM_PORT: String(termPort),
    VP_LAN_VIEWER_PORT: String(lanViewerPort),
    VP_IDENTITY: 'dev',
  };
  // Started together on purpose, against a brand-new DATA_DIR: this is the
  // first-boot migration race, so every smoke run guards against it coming back.
  const runner = spawnService(path.join(serverDist, 'runner', 'index.js'), env);
  const term = spawnService(path.join(serverDist, 'terminalService', 'index.js'), env);
  const web = spawnService(path.join(serverDist, 'index.js'), env);

  const rmBestEffort = (dir) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // Best-effort: Chrome can still be flushing SingletonLock/leveldb files
      // for a moment right after SIGKILL, which can race a recursive rm into
      // ENOTEMPTY. It's a throwaway temp dir either way — don't fail a run
      // that already passed just because cleanup lost this race.
      console.warn(`cleanup: failed to remove ${dir}: ${err.message}`);
    }
  };

  const cleanup = async () => {
    await Promise.all([stopChild(web), stopChild(runner), stopChild(term)]);
    chrome.kill('SIGKILL');
    rmBestEffort(dataDir);
    rmBestEffort(chromeProfile);
  };

  try {
    await waitForHttp(`http://127.0.0.1:${port}/healthz`, BOOT_TIMEOUT_MS);
    await waitForHttp(`http://127.0.0.1:${termPort}/healthz`, BOOT_TIMEOUT_MS);
    ok('web + runner + terminal service booted, /healthz is green');

    // SQLite write: round-tripped through the real HTTP API against the
    // throwaway DATA_DIR's on-disk database, not a mocked one.
    await fetch(`http://127.0.0.1:${port}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Boot Smoke' }),
    }).then((res) => assertOk('POST /api/setup', res));
    const created = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'boot-smoke' }),
    }).then((res) => assertOk('POST /api/projects', res)).then((res) => res.json());
    const listed = await fetch(`http://127.0.0.1:${port}/api/projects`)
      .then((res) => assertOk('GET /api/projects', res)).then((res) => res.json());
    if (!listed.projects?.some((project) => project.id === created.project.id)) {
      throw new Error('created project did not round-trip through SQLite');
    }
    ok('SQLite write persisted and round-tripped');

    // node-pty spawn: a real PTY on this OS/arch, not a mocked one — this is
    // the exact seam that breaks silently when a native prebuilt doesn't
    // actually run on the host (see node-pty/Node 26/mac-arm64 history).
    await new Promise((resolve, reject) => {
      const shell = process.env.SHELL || '/bin/sh';
      const term = ptySpawn(shell, [], { name: 'xterm-color', cols: 80, rows: 24, cwd: os.tmpdir(), env: process.env });
      let out = '';
      const timer = setTimeout(() => {
        term.kill();
        reject(new Error('pty spawn timed out'));
      }, PTY_TIMEOUT_MS);
      term.onData((chunk) => {
        out += chunk;
        if (out.includes('veneer-pro-smoke-ok')) {
          clearTimeout(timer);
          term.kill();
          resolve();
        }
      });
      term.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
      term.write('echo veneer-pro-smoke-ok\r');
    });
    ok('node-pty spawned a real PTY and read its output');

    // CDP attach to the headless Chrome this script just launched, reusing
    // the app's own minimal CDP client (channels/cdpClient.ts) rather than
    // rolling a second one.
    await waitForHttp(`http://127.0.0.1:${chromePort}/json/version`, CHROME_TIMEOUT_MS);
    const { browserWebSocketUrl, connectCdp } = await import(path.join(serverDist, 'channels', 'cdpClient.js'));
    const wsUrl = await browserWebSocketUrl(chromePort);
    const cdp = await connectCdp(wsUrl);
    const version = await cdp.send('Browser.getVersion');
    cdp.close();
    if (!version?.product) throw new Error('Browser.getVersion returned no product');
    ok(`CDP attach succeeded (${version.product})`);

    // Two concurrent commands against the Phase 1a shared-browser queue must
    // serialize strictly (arrival order), not interleave. Exercised directly
    // against the built serialQueue module rather than through a real
    // agent-browser CLI invocation: that binary is a separate host install
    // (not part of this repo or CI), and this is the exact primitive that
    // replaced flock(1) so the behavior needs no OS lock to prove.
    const { createSerialQueue } = await import(path.join(serverDist, 'mcp', 'serialQueue.js'));
    const queue = createSerialQueue();
    const order = [];
    const track = (label, delayMs) => queue.run(async () => {
      order.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(`${label}:end`);
    });
    await Promise.all([track('a', 100), track('b', 10)]);
    const expected = ['a:start', 'a:end', 'b:start', 'b:end'].join();
    if (order.join() !== expected) {
      throw new Error(`expected strict serialization, got: ${order.join(', ')}`);
    }
    ok('two concurrent browser-queue commands serialized in arrival order');

    console.log('\nboot smoke: PASS');
  } catch (err) {
    console.error('\n--- web output ---\n' + web.dump());
    console.error('\n--- runner output ---\n' + runner.dump());
    throw err;
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error('\nboot smoke: FAIL');
  console.error(err?.stack ?? err);
  process.exit(1);
});
