#!/usr/bin/env node
// Immutable release snapshots for the launchd-supervised node services.
//
// launchd's KeepAlive respawns a service from the path in its plist. When that
// path is the checkout's server/dist, `npm run build` rewrites what the NEXT
// crash or respawn loads, so a crash silently deploys an unapproved build and
// the bytes that were running are lost (2026-10-13: web respawned onto a
// rebuilt dist and applied two migrations). Here the plists point at
//
//   DATA_DIR/releases/active/<service>  ->  ../<release-id>
//
// and a release directory is a read-only copy of a build. Building never
// changes what a respawn loads. Only `scripts/restart.mjs --maintenance-approved`
// moves an active pointer, immediately before it restarts that same service,
// and it keeps the pointer it replaced in releases/previous/<service> so a
// verified prior artifact exists for rollback.
//
// Crashes are unaffected: a crashing service still exits non-zero, logs, and
// launchd respawns it. This only fixes WHICH bytes respawn.
//
//   node scripts/releases.mjs snapshot   # copy the current build; activates nothing
//   node scripts/releases.mjs status     # active / previous release per service
//   node scripts/releases.mjs list
//   node scripts/releases.mjs verify <id>

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_SERVICES = ['veneer-pro', 'veneer-pro-runner', 'veneer-pro-app-runner', 'veneer-pro-term'];
/** Entry script inside a release (or checkout) root, per service. */
export const SERVICE_ENTRY = {
  'veneer-pro': 'server/dist/index.js',
  'veneer-pro-runner': 'server/dist/runner/index.js',
  'veneer-pro-app-runner': 'server/dist/appRunner/index.js',
  'veneer-pro-term': 'server/dist/terminalService/index.js',
};
// Everything the built services read relative to their own location: both dist
// trees, the package.json files that make dist ESM, and the provider runtime
// provisioner the web reaches with ../../../installer (codex/grok device auth).
const COPIED_TREES = ['server/dist', 'web/dist'];
const COPIED_FILES = ['package.json', 'server/package.json', 'provider-runtimes.json', 'installer/provider-runtimes.mjs'];
// Dependencies resolve through the checkout. They are not snapshotted; the
// lockfile hash is recorded so a dependency change after activation is visible.
const LINKED_MODULES = ['node_modules', 'server/node_modules'];
const RELEASE_FILE = 'release.json';
const ID_PATTERN = /^[0-9a-f]{7,40}(?:-dirty)?-[0-9a-f]{12}$|^nogit-[0-9a-f]{12}$/;

export const releasesDir = (dataDir) => path.join(dataDir, 'releases');
export const activeLink = (dataDir, service) => path.join(releasesDir(dataDir), 'active', service);
export const previousLink = (dataDir, service) => path.join(releasesDir(dataDir), 'previous', service);
/** The path a release-mode plist launches. Node runs the real path behind the link. */
export const activeEntry = (dataDir, service) => path.join(activeLink(dataDir, service), SERVICE_ENTRY[service]);

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(root, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** Sorted `sha256  path` lines over the snapshot contents, and their digest. */
export function contentManifest(root) {
  const files = [];
  for (const tree of COPIED_TREES) {
    if (!fs.existsSync(path.join(root, tree))) throw new Error(`${tree} is missing under ${root}; run npm run build first`);
    files.push(...walk(root, tree));
  }
  for (const file of COPIED_FILES) if (fs.existsSync(path.join(root, file))) files.push(file);
  files.sort();
  const lines = files.map((file) => `${sha256File(path.join(root, file))}  ${file}`);
  const text = lines.join('\n') + '\n';
  return { files: files.length, text, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function gitIdentity(appRoot) {
  try {
    const sha = execFileSync('git', ['-C', appRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['-C', appRoot, 'status', '--porcelain', '--untracked-files=no', '--', 'server', 'web', 'installer', 'package.json', 'package-lock.json', 'provider-runtimes.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: null };
  }
}

function lockHash(appRoot) {
  const lock = path.join(appRoot, 'package-lock.json');
  return fs.existsSync(lock) ? sha256File(lock) : null;
}

function makeReadOnly(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { makeReadOnly(p); fs.chmodSync(p, 0o555); }
    else fs.chmodSync(p, 0o444);
  }
}

export function readRelease(dataDir, id) {
  if (!ID_PATTERN.test(id)) throw new Error(`not a release id: ${id}`);
  const dir = path.join(releasesDir(dataDir), id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, RELEASE_FILE), 'utf8'));
  return { dir, meta };
}

/** Recomputes the content manifest; throws when the release no longer matches what was recorded. */
export function verifyRelease(dataDir, id) {
  const { dir, meta } = readRelease(dataDir, id);
  const now = contentManifest(dir);
  if (now.sha256 !== meta.manifest_sha256 || now.files !== meta.files) {
    throw new Error(`release ${id} changed on disk (manifest ${now.sha256.slice(0, 12)} != recorded ${meta.manifest_sha256.slice(0, 12)})`);
  }
  for (const link of LINKED_MODULES) {
    const target = path.join(dir, link);
    if (!fs.lstatSync(target).isSymbolicLink()) throw new Error(`release ${id} is missing its ${link} link`);
  }
  return meta;
}

/**
 * Copies the checkout's current build into an immutable release. Activates
 * nothing: no pointer moves and no running or respawning service changes. An
 * identical build already snapshotted is reused.
 */
/** The id a snapshot of the current build would get. Reads only. */
export function releaseIdFor(appRoot, manifest = contentManifest(appRoot), git = gitIdentity(appRoot)) {
  return git.sha ? `${git.sha.slice(0, 12)}${git.dirty ? '-dirty' : ''}-${manifest.sha256.slice(0, 12)}` : `nogit-${manifest.sha256.slice(0, 12)}`;
}

export function snapshotRelease({ appRoot, dataDir, now = new Date() }) {
  const manifest = contentManifest(appRoot);
  const git = gitIdentity(appRoot);
  const id = releaseIdFor(appRoot, manifest, git);
  const root = releasesDir(dataDir);
  const dir = path.join(root, id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.existsSync(dir)) return { id, dir, meta: verifyRelease(dataDir, id), reused: true };
  const staging = fs.mkdtempSync(path.join(root, '.staging-'));
  try {
    // APFS clones make the 250 MB web/dist nearly free; elsewhere it copies.
    for (const tree of COPIED_TREES) fs.cpSync(path.join(appRoot, tree), path.join(staging, tree), { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true });
    for (const file of COPIED_FILES) {
      if (!fs.existsSync(path.join(appRoot, file))) continue;
      fs.mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
      fs.copyFileSync(path.join(appRoot, file), path.join(staging, file), fs.constants.COPYFILE_FICLONE);
    }
    const copied = contentManifest(staging);
    if (copied.sha256 !== manifest.sha256) throw new Error('the build changed while it was being copied; run the snapshot again');
    for (const link of LINKED_MODULES) fs.symlinkSync(path.join(appRoot, link), path.join(staging, link));
    fs.writeFileSync(path.join(staging, 'MANIFEST.sha256'), manifest.text);
    const meta = {
      schema: 'veneer-release/v1',
      id,
      created_at: now.toISOString(),
      source_dir: appRoot,
      git_sha: git.sha,
      git_dirty: git.dirty,
      manifest_sha256: manifest.sha256,
      files: manifest.files,
      package_lock_sha256: lockHash(appRoot),
      node_modules: 'linked to source_dir (not snapshotted)',
    };
    fs.writeFileSync(path.join(staging, RELEASE_FILE), JSON.stringify(meta, null, 2) + '\n');
    makeReadOnly(staging);
    fs.chmodSync(staging, 0o555);
    fs.renameSync(staging, dir);
    return { id, dir, meta, reused: false };
  } catch (error) {
    fs.chmodSync(staging, 0o700);
    makeWritable(staging);
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function makeWritable(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { fs.chmodSync(p, 0o755); makeWritable(p); }
    else fs.chmodSync(p, 0o644);
  }
}

function linkTarget(link) {
  try {
    return path.basename(fs.readlinkSync(link));
  } catch {
    return null;
  }
}

export function activeRelease(dataDir, service) {
  return linkTarget(activeLink(dataDir, service));
}

export function previousRelease(dataDir, service) {
  return linkTarget(previousLink(dataDir, service));
}

function swapLink(link, target) {
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
  const tmp = `${link}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.symlinkSync(target, tmp);
  try {
    fs.renameSync(tmp, link); // atomic replace: a respawn sees old or new, never neither
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Points the given services at a verified release and records the release each
 * one replaced. Only restart.mjs calls this, inside --maintenance-approved, right
 * before restarting exactly these services; it refuses anything else.
 */
export function activateRelease({ dataDir, id, services, maintenanceApproved, reason = 'restart.mjs', now = new Date(), hooks = {} }) {
  if (!maintenanceApproved) throw new Error('Release activation refused: it changes what a respawn loads, so it needs --maintenance-approved inside an approved window.');
  const unknown = services.filter((s) => !RELEASE_SERVICES.includes(s));
  if (unknown.length) throw new Error(`no release entry for: ${unknown.join(', ')}`);
  const meta = verifyRelease(dataDir, id);
  for (const service of services) {
    if (!fs.existsSync(path.join(releasesDir(dataDir), id, SERVICE_ENTRY[service]))) throw new Error(`release ${id} has no ${SERVICE_ENTRY[service]}`);
  }
  // Captured before the first move, so a throw anywhere below (any link, the
  // log write) puts every pointer back exactly, absent ones included.
  const captured = capturePointers(dataDir, services);
  const changes = [];
  try {
    for (const service of services) {
      const from = activeRelease(dataDir, service);
      if (from === id) { changes.push({ service, from, to: id, changed: false }); continue; }
      if (from) { hooks.beforeLink?.(previousLink(dataDir, service)); swapLink(previousLink(dataDir, service), path.join('..', from)); }
      hooks.beforeLink?.(activeLink(dataDir, service));
      swapLink(activeLink(dataDir, service), path.join('..', id));
      changes.push({ service, from, to: id, changed: true });
    }
    const log = path.join(releasesDir(dataDir), 'activations.jsonl');
    hooks.beforeLog?.();
    fs.appendFileSync(log, changes.map((change) => JSON.stringify({ at: now.toISOString(), ...change, git_sha: meta.git_sha, reason }) + '\n').join(''), { mode: 0o600 });
  } catch (error) {
    restorePointersExact(dataDir, captured);
    throw new Error(`release activation failed and every pointer was restored: ${error.message}`);
  }
  return changes;
}

function rawLink(link) {
  try { return fs.readlinkSync(link); } catch { return null; }
}

/** Exact active/previous link targets, so a refused activation can put them back. */
export function capturePointers(dataDir, services) {
  return services.map((service) => ({
    service,
    active: rawLink(activeLink(dataDir, service)),
    previous: rawLink(previousLink(dataDir, service)),
  }));
}

/** Puts links back exactly as captured, without touching the activation log. */
export function restorePointersExact(dataDir, captured) {
  const failures = [];
  for (const { service, active, previous } of captured) {
    for (const [link, target] of [[activeLink(dataDir, service), active], [previousLink(dataDir, service), previous]]) {
      try {
        if (target) swapLink(link, target);
        else fs.rmSync(link, { force: true });
      } catch (error) {
        failures.push(`${service} ${path.basename(path.dirname(link))}: ${error.message}`);
      }
    }
  }
  if (failures.length) throw new Error(`RESTORE INCOMPLETE, read releases status before anything else: ${failures.join('; ')}`);
}

/**
 * Puts active/previous links back exactly as captured. A service that had no
 * active release loses its link again, so its plist's checkout fallback applies.
 */
export function restorePointers(dataDir, captured, { reason = 'restore', now = new Date() } = {}) {
  fs.mkdirSync(releasesDir(dataDir), { recursive: true, mode: 0o700 });
  restorePointersExact(dataDir, captured);
  fs.appendFileSync(path.join(releasesDir(dataDir), 'activations.jsonl'), captured.map(({ service, active }) => JSON.stringify({ at: now.toISOString(), service, restored_to: active ? path.basename(active) : null, reason }) + '\n').join(''), { mode: 0o600 });
}

/** Which bytes each service would respawn from right now. */
export function releaseStatus({ dataDir, appRoot, plistEntry = () => null }) {
  return RELEASE_SERVICES.map((service) => {
    const entry = plistEntry(service);
    const mode = entry === activeEntry(dataDir, service) ? 'release' : entry === path.join(appRoot, SERVICE_ENTRY[service]) ? 'checkout' : entry ? 'other' : 'unknown';
    return { service, mode, plist_entry: entry, active: activeRelease(dataDir, service), previous: previousRelease(dataDir, service) };
  });
}

/** ProgramArguments[1] of an installed LaunchAgent, or null where launchd is absent. */
export function launchdEntry(label) {
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  try {
    const wrapped = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const actual = wrapped.ProgramArguments;
    const original = wrapped.VeneerOriginalProgramArguments;
    if (Array.isArray(original) && actual?.[1]?.endsWith('/veneer-volume/ensure-mounted.py') && actual[2] === '--exec' && JSON.stringify(actual.slice(3)) === JSON.stringify(original)) return original[1] ?? null;
    return execFileSync('/usr/bin/plutil', ['-extract', 'ProgramArguments.1', 'raw', '-o', '-', plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * The root each plist launches from: the service's verified active release, or
 * the checkout when it has none (legacy in-place mode, reported as a warning).
 * Reads only; never snapshots or activates.
 */
export function plistRoots({ dataDir, codeDir }) {
  const roots = {};
  const warnings = [];
  for (const service of RELEASE_SERVICES) {
    const id = activeRelease(dataDir, service);
    if (!id) {
      roots[service] = codeDir;
      warnings.push(`${service} has no active release, so its plist launches the checkout build in place: any npm run build is deployed by its next crash. Activate a release in an approved window (--activate-release --maintenance-approved).`);
      continue;
    }
    try {
      verifyRelease(dataDir, id);
      roots[service] = activeLink(dataDir, service);
    } catch (error) {
      // Never point launchd at a release that no longer matches its record.
      roots[service] = codeDir;
      warnings.push(`${service}: active release ${id} failed verification (${error.message}); rendering the checkout path instead. Investigate before any restart.`);
    }
  }
  // The web watchdog observes the web service and follows its release.
  roots['web-watchdog'] = roots['veneer-pro'];
  return { roots, warnings };
}

export const SERVICE_LABEL = {
  'veneer-pro': 'com.veneer.pro',
  'veneer-pro-runner': 'com.veneer.pro.runner',
  'veneer-pro-app-runner': 'com.veneer.pro.app-runner',
  'veneer-pro-term': 'com.veneer.pro.term',
};

function defaultDataDir() {
  const envFile = process.env.VP_ENV_FILE || path.join(os.homedir(), '.config', 'veneer-pro', 'env');
  let fromFile = null;
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const match = /^\s*(?:export\s+)?DATA_DIR\s*=\s*(.*)$/.exec(line);
      if (match) fromFile = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* no env file */ }
  const raw = process.env.DATA_DIR || fromFile || path.join(os.homedir(), '.local', 'share', 'veneer-pro');
  return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = defaultDataDir();
  const [command, arg] = process.argv.slice(2);
  try {
    if (command === 'snapshot') {
      const r = snapshotRelease({ appRoot, dataDir });
      console.log(`${r.reused ? 'reused' : 'created'} release ${r.id} (${r.meta.files} files, manifest ${r.meta.manifest_sha256}); nothing was activated`);
    } else if (command === 'verify' && arg) {
      const meta = verifyRelease(dataDir, arg);
      console.log(`release ${arg} verified: ${meta.files} files, manifest ${meta.manifest_sha256}`);
    } else if (command === 'list') {
      const root = releasesDir(dataDir);
      for (const id of fs.existsSync(root) ? fs.readdirSync(root).filter((n) => ID_PATTERN.test(n)).sort() : []) {
        const { meta } = readRelease(dataDir, id);
        console.log(`${id}  ${meta.created_at}  git ${meta.git_sha ?? 'none'}${meta.git_dirty ? ' (dirty)' : ''}`);
      }
    } else if (command === 'status') {
      for (const row of releaseStatus({ dataDir, appRoot, plistEntry: (s) => launchdEntry(SERVICE_LABEL[s]) })) {
        const warn = row.mode === 'checkout' ? '  (respawns load the checkout build in place: any npm run build is deployed by the next crash)' : '';
        console.log(`${row.service}: ${row.mode}; active ${row.active ?? 'none'}; previous ${row.previous ?? 'none'}${warn}`);
      }
    } else {
      console.error('usage: releases.mjs snapshot | status | list | verify <id>');
      process.exit(2);
    }
  } catch (error) {
    console.error(`[releases] ${error.message}`);
    process.exit(1);
  }
}
