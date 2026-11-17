#!/usr/bin/env node
// Moves stale work folders from the internal disk to the external drive and
// leaves a symlink at the old path. Dry run unless --apply.
// Port of out/disk-relocation-20261112/relocate.py.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';

const GIB = 1024 ** 3;
// The sweep reads a login-user tree (~/Projects). launchd jobs run with the
// isolated service HOME, so os.homedir() would point at the wrong place.
const LOGIN_HOME = os.userInfo().homedir;

export const DEFAULT_CONFIG = Object.freeze({
  roots: [{ source: path.join(LOGIN_HOME, 'Projects', 'ERVP', 'out'), target: '/Volumes/VeneerData/Veneer/ervp-out' }],
  minBytes: 5 * 1024 * 1024,
  ageHours: 48,
  skipNames: ['state'],
});

export function configPath(env = process.env) {
  return env.VP_DISK_SWEEP_CONFIG || path.join(LOGIN_HOME, '.config', 'veneer-pro', 'disk-sweep.json');
}

export function loadConfig(file = configPath()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_CONFIG };
    throw new Error(`disk-sweep config ${file} is unreadable: ${error.message}`);
  }
  return validateConfig({ ...DEFAULT_CONFIG, ...raw });
}

export function validateConfig(config) {
  const absolute = (value) => typeof value === 'string' && path.isAbsolute(value);
  if (!Array.isArray(config.roots) || !config.roots.length || !config.roots.every((root) => absolute(root?.source) && absolute(root?.target))) {
    throw new Error('disk-sweep config: roots must be a non-empty list of { source, target } absolute paths.');
  }
  if (!(config.minBytes >= 0) || !(config.ageHours > 0)) throw new Error('disk-sweep config: minBytes must be >= 0 and ageHours > 0.');
  if (!Array.isArray(config.skipNames) || !config.skipNames.every((name) => typeof name === 'string')) {
    throw new Error('disk-sweep config: skipNames must be a list of names.');
  }
  return config;
}

/** File count, bytes and newest mtime of everything under dir (lstat, never follows links). */
export function scanDir(dir) {
  let files = 0;
  let bytes = 0;
  let newest = fs.lstatSync(dir).mtimeMs;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let stat;
      try { stat = fs.lstatSync(full); } catch { continue; }
      newest = Math.max(newest, stat.mtimeMs);
      if (stat.isDirectory()) stack.push(full);
      else { files += 1; bytes += stat.size; }
    }
  }
  return { files, bytes, newest };
}

/** Real subdirectories of dir (no symlinks), sorted by name. */
export function listDirs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Stale folders to move. A top-level folder qualifies when it is large enough
 * and nothing inside changed for ageHours; an active top-level folder is
 * searched exactly one level down with the same test. fsx is injectable.
 */
export function selectCandidates(config, now = Date.now(), fsx = { listDirs, scanDir }) {
  const ageMs = config.ageHours * 3600 * 1000;
  const skip = new Set(config.skipNames);
  const out = [];
  const stale = (scan) => now - scan.newest > ageMs;
  for (const root of config.roots) {
    for (const top of fsx.listDirs(root.source)) {
      if (top.endsWith('.relocating')) continue;
      const topPath = path.join(root.source, top);
      const scan = fsx.scanDir(topPath);
      if (scan.bytes < config.minBytes) continue;
      if (stale(scan)) { out.push({ root, path: topPath, ...scan }); continue; }
      for (const child of fsx.listDirs(topPath)) {
        if (skip.has(child) || child.endsWith('.relocating')) continue;
        const childPath = path.join(topPath, child);
        const childScan = fsx.scanDir(childPath);
        if (childScan.bytes >= config.minBytes && stale(childScan)) out.push({ root, path: childPath, ...childScan });
      }
    }
  }
  return out;
}

/** True when the target's volume (e.g. /Volumes/VeneerData) exists and is not the boot disk. */
export function volumeMounted(target) {
  const volume = path.resolve(target).split(path.sep).slice(0, 3).join(path.sep);
  try {
    return fs.statSync(volume).dev !== fs.statSync('/').dev;
  } catch {
    return false;
  }
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.error ? -1 : result.status, stdout: result.stdout ?? '', stderr: result.error?.message ?? result.stderr ?? '' };
}

function moveOne(candidate, target, run, log) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const rsync = run('/usr/bin/rsync', ['-a', `${candidate.path}/`, `${target}/`]);
  if (rsync.status !== 0) {
    log(`  RSYNC FAILED (exit ${rsync.status}), source left in place; partial copy may remain at ${target}`);
    return false;
  }
  const copied = scanDir(target);
  if (copied.files !== candidate.files || copied.bytes !== candidate.bytes) {
    log(`  VERIFY FAILED, source left in place: ${candidate.files}/${copied.files} files, ${candidate.bytes}/${copied.bytes} bytes; copy remains at ${target}`);
    return false;
  }
  const aside = `${candidate.path}.relocating`;
  fs.renameSync(candidate.path, aside);
  try {
    fs.symlinkSync(target, candidate.path);
  } catch (error) {
    fs.renameSync(aside, candidate.path);
    log(`  SYMLINK FAILED, source restored: ${error.message}`);
    return false;
  }
  try {
    fs.rmSync(aside, { recursive: true, force: true });
  } catch (error) {
    log(`  moved, but could not remove ${aside}: ${error.message}`);
  }
  return true;
}

export function runSweep({
  apply = false,
  config = loadConfig(),
  log = (line) => console.log(line),
  now = Date.now(),
  run = defaultRun,
  isMounted = volumeMounted,
  fsx = undefined,
  logFile = process.env.VP_DISK_SWEEP_LOG || path.join(path.dirname(config.roots[0].target), 'sweep-log.jsonl'),
} = {}) {
  validateConfig(config);
  if (apply) {
    const unmounted = config.roots.filter((root) => !isMounted(root.target)).map((root) => root.target);
    if (unmounted.length) {
      const error = new Error(`disk-sweep: refusing to move anything; target volume not mounted for ${unmounted.join(', ')}`);
      error.code = 'not_mounted';
      throw error;
    }
  }
  const result = { moved: 0, bytes: 0, busy: 0, failed: 0 };
  const candidates = selectCandidates(config, now, fsx);
  for (const candidate of candidates) {
    const rel = path.relative(candidate.root.source, candidate.path);
    const target = path.join(candidate.root.target, rel);
    if (run('/usr/sbin/lsof', ['+D', candidate.path]).stdout.trim()) {
      result.busy += 1;
      log(`BUSY skip ${rel}`);
      continue;
    }
    log(`${(candidate.bytes / GIB).toFixed(2).padStart(7)} GiB ${String(candidate.files).padStart(7)} files  ${rel}`);
    if (!apply) { result.moved += 1; result.bytes += candidate.bytes; continue; }
    if (fs.existsSync(target)) {
      result.failed += 1;
      log(`  target already exists, skipped: ${target}`);
      continue;
    }
    let ok = false;
    try {
      ok = moveOne(candidate, target, run, log);
    } catch (error) {
      log(`  MOVE FAILED: ${error.message}`);
    }
    if (!ok) { result.failed += 1; continue; }
    result.moved += 1;
    result.bytes += candidate.bytes;
    const entry = { path: candidate.path, target, files: candidate.files, bytes: candidate.bytes, at: new Date().toISOString() };
    try {
      fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    } catch (error) {
      log(`  could not append to ${logFile}: ${error.message}`);
    }
  }
  log(`TOTAL ${(result.bytes / GIB).toFixed(2)} GiB in ${result.moved} folders, ${result.busy} skipped busy, ${result.failed} failed${apply ? '' : ' (dry run)'}`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFile(process.env.VP_ENV_FILE || path.join(os.homedir(), '.config', 'veneer-pro', 'env'));
  try {
    runSweep({ apply: process.argv.includes('--apply') });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
