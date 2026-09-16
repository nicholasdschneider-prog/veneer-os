#!/usr/bin/env node
// Install the `veneer-pdf` helper onto a client and make it reachable to agents.
//
// It copies the standalone CLI to ~/.local/bin/veneer-pdf and its Python
// fallback to ~/.local/lib/veneer-pdf, ensures ~/.local/bin is on the runner
// service PATH (via ~/.config/veneer-pro/env), and best-effort installs fpdf2.
//
// Idempotent and safe to re-run on every update. Run as the service user, or
// pass SERVICE_HOME so files land in the right home. Chrome is resolved by the
// CLI at runtime, so this provisioner does not depend on a browser install.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STANDARD_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function log(message) {
  console.log(`[veneer-pdf] ${message}`);
}

function copyExecutable(src, dest, mode) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, mode);
}

// Ensure the runner service env file puts binDir on PATH without clobbering an
// existing PATH. systemd reads this as an EnvironmentFile, and the update path
// also `source`s it — a plain unquoted colon list is valid for both.
export function ensurePathEntry(envFile, binDir, fsImpl = fs) {
  let lines = [];
  try {
    lines = fsImpl.readFileSync(envFile, 'utf8').split('\n');
  } catch {
    lines = [];
  }
  const pathRe = /^\s*(?:export\s+)?PATH\s*=(.*)$/;
  let changed = false;
  let found = false;
  const next = lines.map((line) => {
    const match = pathRe.exec(line);
    if (!match) return line;
    found = true;
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const segments = value.split(':').filter(Boolean);
    if (segments.includes(binDir)) return line;
    changed = true;
    return `PATH=${[binDir, ...segments].join(':')}`;
  });
  if (!found) {
    if (next.length && next[next.length - 1] === '') next.pop();
    next.push(`PATH=${binDir}:${STANDARD_PATH}`);
    changed = true;
  }
  if (!changed) return false;
  const body = next.join('\n').replace(/\n*$/, '\n');
  const tmp = `${envFile}.veneer-pdf.${process.pid}.tmp`;
  fsImpl.mkdirSync(path.dirname(envFile), { recursive: true });
  fsImpl.writeFileSync(tmp, body, { mode: 0o600 });
  fsImpl.renameSync(tmp, envFile);
  try {
    fsImpl.chmodSync(envFile, 0o600);
  } catch {
    /* best effort */
  }
  return true;
}

function ensureFpdf(serviceHome) {
  const probe = spawnSync('python3', ['-c', 'import fpdf'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: serviceHome },
    timeout: 15_000,
  });
  if (probe.status === 0) {
    log('fpdf2 already available');
    return;
  }
  const install = spawnSync(
    'python3',
    ['-m', 'pip', 'install', '--user', '--break-system-packages', '--quiet', '--disable-pip-version-check', 'fpdf2'],
    { stdio: 'inherit', env: { ...process.env, HOME: serviceHome, PIP_BREAK_SYSTEM_PACKAGES: '1' }, timeout: 120_000 },
  );
  if (install.status === 0) {
    log('installed fpdf2 for the fallback renderer');
  } else {
    // Not fatal: the fallback degrades to a stdlib-only writer, and Chrome is
    // the primary renderer regardless.
    log('fpdf2 not installed (fallback will use the stdlib writer)');
  }
}

export function provisionVeneerPdf({
  serviceHome = os.homedir(),
  installerDir = path.dirname(fileURLToPath(import.meta.url)),
} = {}) {
  const srcDir = path.join(installerDir, 'veneer-pdf');
  const binDir = path.join(serviceHome, '.local', 'bin');
  const libDir = path.join(serviceHome, '.local', 'lib', 'veneer-pdf');
  const envFile = path.join(serviceHome, '.config', 'veneer-pro', 'env');

  copyExecutable(path.join(srcDir, 'veneer-pdf.mjs'), path.join(binDir, 'veneer-pdf'), 0o755);
  copyExecutable(path.join(srcDir, 'fallback_pdf.py'), path.join(libDir, 'fallback_pdf.py'), 0o644);
  log(`installed veneer-pdf -> ${path.join(binDir, 'veneer-pdf')}`);

  if (ensurePathEntry(envFile, binDir)) {
    log(`added ${binDir} to the runner PATH (${envFile})`);
  }

  ensureFpdf(serviceHome);
  log('ready');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const serviceHome = process.argv[2] ? path.resolve(process.argv[2]) : os.homedir();
  try {
    provisionVeneerPdf({ serviceHome });
  } catch (error) {
    console.error(`[veneer-pdf] provisioning failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
}
