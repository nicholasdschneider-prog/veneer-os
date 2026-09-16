#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { createAgentCursorTracker, ticketPurpose } from './cursor.mjs';
import { relayCdp } from './cdp-relay.mjs';
import { createDockerBackend } from './backends/docker.mjs';
import { createNativeBackend } from './backends/native.mjs';

const exec = promisify(execFile);
const DARWIN = process.platform === 'darwin';
const HOME = process.env.HOME || os.homedir();
// The Mac runs the manager beside the Pro server as a launchd agent, so its
// defaults live under the service account's home instead of /srv and /etc.
const DEFAULT_STORE = DARWIN
  ? path.join(HOME, 'Library', 'Application Support', 'veneer-browser', 'store')
  : '/srv/veneer-browser/store';
const DEFAULT_CLIENTS_FILE = DARWIN
  ? path.join(HOME, '.config', 'veneer-browser', 'clients.json')
  : '/etc/veneer-browser/clients.json';
const PORT = integer(process.env.VENEER_BROWSER_MANAGER_PORT, 7300, 1, 65_535);
const STORE = path.resolve(process.env.VENEER_BROWSER_STORE || DEFAULT_STORE);
const CLIENTS_FILE = path.resolve(process.env.VENEER_BROWSER_CLIENTS_FILE || DEFAULT_CLIENTS_FILE);
// native = one Chrome process per copy on this machine (macOS);
// docker = one hardened container per copy on the browser VM (Linux).
const BACKEND_KIND = process.env.VENEER_BROWSER_BACKEND || (DARWIN ? 'native' : 'docker');
// The native backend has no VM boundary around it, so it stays on loopback
// unless the operator says otherwise; the VM keeps its LAN listener.
const BIND = process.env.VENEER_BROWSER_BIND || (DARWIN ? '127.0.0.1' : '0.0.0.0');
// On a Mac this listener fronts the operator's own logged-in profiles with no
// container between them and the network, so reaching it from off-box is an
// explicit decision rather than a typo in VENEER_BROWSER_BIND.
const ALLOW_REMOTE = process.env.VENEER_BROWSER_ALLOW_REMOTE === '1';
// The Pro server pins the origin it was configured with, so tickets can be
// forced to that origin rather than echoing the request's Host header.
const PUBLIC_ORIGIN = (process.env.VENEER_BROWSER_PUBLIC_ORIGIN || '').replace(/\/+$/, '');
const CHROME_BIN = process.env.VENEER_BROWSER_CHROME_BIN || '';
const HEADLESS = process.env.VENEER_BROWSER_HEADLESS !== '0';
const IMAGE = process.env.VENEER_BROWSER_IMAGE || 'veneer-browser-runtime:1';
const SECCOMP = path.resolve(process.env.VENEER_BROWSER_SECCOMP || '/etc/veneer-browser/seccomp_profile.json');
const MAX_ACTIVE = integer(process.env.VENEER_BROWSER_MAX_ACTIVE, 5, 1, 20);
const IDLE_MS = integer(process.env.VENEER_BROWSER_IDLE_MINUTES, 30, 5, 1440) * 60_000;
const TEMP_IDLE_MS = integer(process.env.VENEER_BROWSER_TEMP_IDLE_MINUTES, 30, 5, 1440) * 60_000;
const SWEEP_MS = integer(process.env.VENEER_BROWSER_SWEEP_SECONDS, 60, 1, 3600) * 1000;
const REQUIRE_ENCRYPTED = process.env.VENEER_BROWSER_REQUIRE_ENCRYPTED === '1';
// One pre-booted copy per saved profile; 0 turns the pool off entirely.
const WARM = integer(process.env.VENEER_BROWSER_WARM, 1, 0, 1);
// Every warm copy holds a container's worth of memory, so the pool is capped as
// a whole as well as per profile; a full pool evicts its oldest copy.
const WARM_MAX = integer(process.env.VENEER_BROWSER_WARM_MAX, 2, 0, 10);
const TLS_PORT = integer(process.env.VENEER_BROWSER_TLS_PORT, 0, 0, 65_535);
const TLS_CERT = process.env.VENEER_BROWSER_TLS_CERT || '';
const TLS_KEY = process.env.VENEER_BROWSER_TLS_KEY || '';
// Must match the chrome user baked into the runtime image (runtime/Dockerfile).
const CHROME_UID = integer(process.env.VENEER_BROWSER_CHROME_UID, 10_001, 0, 2 ** 31 - 1);
const CHROME_GID = integer(process.env.VENEER_BROWSER_CHROME_GID, 10_001, 0, 2 ** 31 - 1);
const TICKET_MS = 2 * 60_000;
const MAX_BODY = 256 * 1024;
const MAX_DOWNLOAD_FILE = 25 * 1024 * 1024;
const MAX_DOWNLOAD_TOTAL = 100 * 1024 * 1024;
const MAX_PROFILE_BACKUPS = 3;
const ID = /^[A-Za-z0-9_-]{1,200}$/;
// Chrome rebuilds all of these on launch; they are ~90% of a real profile's bytes.
const DISPOSABLE_CHROME_ENTRIES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'GraphiteDawnCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'component_crx_cache',
  'Crashpad',
  'optimization_guide_model_store',
  'Safe Browsing',
  'WasmTtsEngine',
  'OnDeviceHeadSuggestModel',
  'BrowserMetrics-spare.pma',
]);

if (!['native', 'docker'].includes(BACKEND_KIND)) throw new Error('Invalid browser manager backend.');
const backend = BACKEND_KIND === 'native'
  ? createNativeBackend({ store: STORE, chromeBin: CHROME_BIN, headless: HEADLESS })
  : createDockerBackend({ image: IMAGE, seccomp: SECCOMP, chromeUid: CHROME_UID, chromeGid: CHROME_GID });

const tickets = new Map();
// Warm copies waiting for adoption, keyed by their saved profile's scope key.
const warmCopies = new Map();
// Container names of warm copies still being built; they are not in the registry
// yet, so the sweeper would otherwise read them as strays and delete them.
const warmPending = new Set();
// The sweeper stays out of the way until boot has rebuilt the registry.
let warmRestored = false;
const profileOps = new Map();
const liveConnections = new Map();
const cursorViewers = new Map();

function integer(value, fallback, min, max) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error('Invalid browser manager setting.');
  return parsed;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeId(value, label) {
  const id = typeof value === 'string' ? value : '';
  if (!ID.test(id)) throw new HttpError(400, `Invalid ${label}.`);
  return id;
}

function safeName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 100) throw new HttpError(400, 'Profile name must be from 1 to 100 characters.');
  return name;
}

function safeDownloadName(value) {
  const name = path.basename(value).replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^\.+/, '').slice(0, 180);
  return name || 'download';
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readClients() {
  const parsed = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.clients)) throw new Error('Client registry is invalid.');
  return parsed.clients.map((entry) => ({
    id: safeId(entry.id, 'client'),
    tokenHash: typeof entry.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(entry.tokenHash) ? entry.tokenHash : '',
  })).filter((entry) => entry.tokenHash);
}

function authenticate(req) {
  const value = String(req.headers.authorization || '');
  const token = value.startsWith('Bearer ') ? value.slice(7).trim() : '';
  if (!token || token.length > 1000) throw new HttpError(401, 'Unauthorized.');
  const digest = Buffer.from(hash(token));
  for (const client of readClients()) {
    const expected = Buffer.from(client.tokenHash);
    if (digest.length === expected.length && crypto.timingSafeEqual(digest, expected)) return client.id;
  }
  throw new HttpError(401, 'Unauthorized.');
}

function scope(clientId, projectId, profileId) {
  const clientKey = hash(`client\0${clientId}`).slice(0, 32);
  const projectKey = hash(`project\0${clientId}\0${projectId}`).slice(0, 32);
  const profileKey = hash(`profile\0${clientId}\0${projectId}\0${profileId}`).slice(0, 32);
  const root = path.join(STORE, 'profiles', clientKey, projectKey, profileKey);
  return {
    clientId,
    clientKey,
    projectId,
    projectKey,
    profileId,
    key: profileKey,
    root,
    chromeDir: path.join(root, 'chrome'),
    downloadsDir: path.join(root, 'downloads'),
    metaFile: path.join(root, 'metadata.json'),
    container: `veneer-browser-${profileKey}`,
  };
}

function readMeta(s) {
  try {
    const meta = JSON.parse(fs.readFileSync(s.metaFile, 'utf8'));
    if (meta.clientId !== s.clientId || meta.projectId !== s.projectId || meta.profileId !== s.profileId) {
      throw new Error('Profile scope mismatch.');
    }
    return meta;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeMeta(s, patch = {}) {
  const now = new Date().toISOString();
  const current = readMeta(s);
  const field = (name, fallback) => Object.hasOwn(patch, name) ? patch[name] : fallback;
  const meta = {
    version: 2,
    clientId: s.clientId,
    projectId: s.projectId,
    profileId: s.profileId,
    name: field('name', current?.name ?? 'Browser profile'),
    createdAt: field('createdAt', current?.createdAt ?? now),
    updatedAt: now,
    lastUsedAt: field('lastUsedAt', current?.lastUsedAt ?? null),
    temporary: field('temporary', current?.temporary ?? false),
    sourceProfileId: field('sourceProfileId', current?.sourceProfileId ?? null),
    sourceGeneration: field('sourceGeneration', current?.sourceGeneration ?? null),
    generation: field('generation', current?.generation ?? 1),
  };
  fs.mkdirSync(s.root, { recursive: true, mode: 0o700 });
  const temporary = path.join(s.root, `.metadata.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(meta)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, s.metaFile);
  return meta;
}

// The backend owns everything that differs between a container and a local
// process; the rest of this file only knows profiles and their runtimes.
function runtimeStatus(s) {
  return backend.status(s);
}

function cdpPort(s) {
  return backend.cdpPort(s);
}

function serial(key, task) {
  const previous = profileOps.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  profileOps.set(key, next);
  return next.finally(() => {
    if (profileOps.get(key) === next) profileOps.delete(key);
  });
}

function removeChromeRuntimeFiles(chromeDir) {
  for (const name of ['DevToolsActivePort', 'SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    fs.rmSync(path.join(chromeDir, name), { recursive: true, force: true });
  }
}

function scopeAt(s, root) {
  return {
    ...s,
    root,
    chromeDir: path.join(root, 'chrome'),
    downloadsDir: path.join(root, 'downloads'),
    metaFile: path.join(root, 'metadata.json'),
  };
}

function isDisposableChromeEntry(chromeDir, entry) {
  // Only top-level entries and per-profile ones (Default/Cache); deeper look-alikes
  // such as Default/IndexedDB/.../Cache are site data and must survive the copy.
  let segments;
  try { segments = path.relative(chromeDir, entry).split(path.sep); }
  catch { return false; }
  if (segments.length > 2 || segments[0] === '' || segments[0] === '..') return false;
  return DISPOSABLE_CHROME_ENTRIES.has(segments[segments.length - 1]);
}

function copyChromeProfile(source, targetRoot) {
  // The open path pre-creates the target dirs so docker create can bind-mount them
  // while this copy runs; cpSync copies into an existing empty directory.
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  const chromeDir = path.join(targetRoot, 'chrome');
  const downloadsDir = path.join(targetRoot, 'downloads');
  fs.cpSync(source.chromeDir, chromeDir, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter: (entry) => !isDisposableChromeEntry(source.chromeDir, entry),
  });
  removeChromeRuntimeFiles(chromeDir);
  fs.mkdirSync(downloadsDir, { recursive: true, mode: 0o700 });
  backend.prepareDir(chromeDir);
  backend.prepareDir(downloadsDir);
}

function profileGeneration(meta) {
  return Number.isInteger(meta?.generation) && meta.generation >= 1 ? meta.generation : 1;
}

async function cloneProfile(source, target, name) {
  if (source.key === target.key) throw new HttpError(400, 'A profile cannot copy itself.');
  return serial(source.key, async () => {
    const sourceMeta = readMeta(source);
    if (!sourceMeta) throw new HttpError(404, 'Browser profile not found.');
    if (sourceMeta.temporary) throw new HttpError(409, 'A temporary browser copy cannot be copied.');
    if (fs.existsSync(target.root) || readMeta(target)) throw new HttpError(409, 'Browser profile already exists.');

    const state = await runtimeStatus(source);
    // Pause (not stop) keeps the live viewer session intact, but Chrome batches
    // cookie writes, so the newest ~30s of cookies may miss a copy of a running profile.
    const shouldPause = state.running && !state.paused;
    const temporaryRoot = `${target.root}.clone-${crypto.randomUUID()}`;
    let moved = false;
    try {
      if (shouldPause) await backend.pause(source);
      fs.mkdirSync(path.dirname(target.root), { recursive: true, mode: 0o700 });
      copyChromeProfile(source, temporaryRoot);
      fs.renameSync(temporaryRoot, target.root);
      moved = true;
      const profile = writeMeta(target, {
        name,
        lastUsedAt: new Date().toISOString(),
        temporary: true,
        sourceProfileId: source.profileId,
        sourceGeneration: profileGeneration(sourceMeta),
        generation: 1,
      });
      console.log(`[veneer-browser] cloned profile ${source.key.slice(0, 10)} to ${target.key.slice(0, 10)}`);
      return profile;
    } catch (error) {
      fs.rmSync(moved ? target.root : temporaryRoot, { recursive: true, force: true });
      throw error;
    } finally {
      if (shouldPause) await backend.unpause(source);
    }
  });
}

function createTemporaryProfile(s, name) {
  if (readMeta(s) || fs.existsSync(s.root)) throw new HttpError(409, 'Browser profile already exists.');
  fs.mkdirSync(s.chromeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(s.downloadsDir, { recursive: true, mode: 0o700 });
  backend.prepareDir(s.chromeDir);
  backend.prepareDir(s.downloadsDir);
  return writeMeta(s, {
    name,
    temporary: true,
    sourceProfileId: null,
    sourceGeneration: null,
    generation: 1,
  });
}

function backupDirectory(source, generation) {
  return path.join(
    STORE,
    'backups',
    source.clientKey,
    source.projectKey,
    source.key,
    `${String(generation).padStart(8, '0')}-${Date.now()}-${crypto.randomUUID()}`,
  );
}

function pruneProfileBackups(source) {
  const root = path.join(STORE, 'backups', source.clientKey, source.projectKey, source.key);
  if (!fs.existsSync(root)) return;
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of entries.slice(MAX_PROFILE_BACKUPS)) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

async function promoteProfile(source, working, expectedGeneration) {
  if (source.key === working.key) throw new HttpError(400, 'A profile cannot replace itself.');
  if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
    throw new HttpError(400, 'Invalid saved profile generation.');
  }
  return serial(source.key, () => serial(working.key, async () => {
    const sourceMeta = readMeta(source);
    const workingMeta = readMeta(working);
    if (!sourceMeta || sourceMeta.temporary) throw new HttpError(404, 'Saved browser profile not found.');
    if (!workingMeta?.temporary || workingMeta.sourceProfileId !== source.profileId) {
      throw new HttpError(409, 'The working copy does not belong to this saved profile.');
    }
    const currentGeneration = profileGeneration(sourceMeta);
    const copyGeneration = Number.isInteger(workingMeta.sourceGeneration) ? workingMeta.sourceGeneration : 1;
    if (currentGeneration !== expectedGeneration || copyGeneration !== expectedGeneration) {
      throw new HttpError(409, 'The saved browser profile changed after this working copy started.');
    }
    if ((await runtimeStatus(source)).running || (await runtimeStatus(working)).running) {
      throw new HttpError(409, 'Stop both browser profiles before the saved profile is updated.');
    }

    const stagingRoot = `${source.root}.promote-${crypto.randomUUID()}`;
    const backupRoot = backupDirectory(source, currentGeneration);
    const staged = scopeAt(source, stagingRoot);
    let sourceMoved = false;
    try {
      copyChromeProfile(working, stagingRoot);
      const profile = writeMeta(staged, {
        name: sourceMeta.name,
        createdAt: sourceMeta.createdAt,
        lastUsedAt: new Date().toISOString(),
        temporary: false,
        sourceProfileId: null,
        sourceGeneration: null,
        generation: currentGeneration + 1,
      });
      fs.mkdirSync(path.dirname(backupRoot), { recursive: true, mode: 0o700 });
      fs.renameSync(source.root, backupRoot);
      sourceMoved = true;
      fs.renameSync(stagingRoot, source.root);
      sourceMoved = false;
      try { pruneProfileBackups(source); } catch {}
      // The warm copy is a clone of the profile this call just replaced.
      dropWarmCopy(source.key);
      console.log(`[veneer-browser] updated saved profile ${source.key.slice(0, 10)} from working copy`);
      return profile;
    } catch (error) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      if (sourceMoved && !fs.existsSync(source.root) && fs.existsSync(backupRoot)) {
        fs.renameSync(backupRoot, source.root);
      }
      throw error;
    }
  }));
}

async function saveTemporaryProfile(working, target, name) {
  if (working.key === target.key) throw new HttpError(400, 'A profile cannot save itself.');
  return serial(target.key, () => serial(working.key, async () => {
    const workingMeta = readMeta(working);
    if (!workingMeta?.temporary) throw new HttpError(409, 'Only a temporary working copy can be saved.');
    if (readMeta(target) || fs.existsSync(target.root)) throw new HttpError(409, 'Browser profile already exists.');
    if ((await runtimeStatus(working)).running) throw new HttpError(409, 'Stop the working copy before it is saved.');
    const stagingRoot = `${target.root}.save-${crypto.randomUUID()}`;
    const staged = scopeAt(target, stagingRoot);
    try {
      fs.mkdirSync(path.dirname(target.root), { recursive: true, mode: 0o700 });
      copyChromeProfile(working, stagingRoot);
      const profile = writeMeta(staged, {
        name,
        lastUsedAt: new Date().toISOString(),
        temporary: false,
        sourceProfileId: null,
        sourceGeneration: null,
        generation: 1,
      });
      fs.renameSync(stagingRoot, target.root);
      console.log(`[veneer-browser] saved working copy as profile ${target.key.slice(0, 10)}`);
      return profile;
    } catch (error) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }));
}

// Warm containers are not sessions until they are adopted, so they never consume
// a slot; adoption pops the registry entry, which makes the copy count again.
async function sessionRuntimeCount() {
  const warm = new Set([...warmPending, ...[...warmCopies.values()].map((entry) => entry.containerName)]);
  return backend.sessionCount(warm);
}

async function startProfile(s) {
  return serial(s.key, async () => {
    if (!readMeta(s)) throw new HttpError(404, 'Browser profile not found.');
    let state = await runtimeStatus(s);
    if (state.running) {
      await cdpPort(s);
      writeMeta(s, { lastUsedAt: new Date().toISOString() });
      return { active: true, runtimeId: s.container };
    }
    if (state.exists) await backend.remove(s.container);
    if (await sessionRuntimeCount() >= MAX_ACTIVE) {
      throw new HttpError(429, 'The browser VM is at its active browser limit. Stop an idle browser and try again.');
    }
    fs.mkdirSync(s.chromeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(s.downloadsDir, { recursive: true, mode: 0o700 });
    // Unconditional on purpose: chown -R changes the root first, so a crash could
    // leave a chrome-owned root over root-owned children; re-running self-heals.
    backend.prepareDir(s.chromeDir);
    backend.prepareDir(s.downloadsDir);
    await backend.prepare(s);
    await backend.start(s);
    writeMeta(s, { lastUsedAt: new Date().toISOString() });
    console.log(`[veneer-browser] started profile ${s.key.slice(0, 10)}`);
    return { active: true, runtimeId: s.container };
  });
}

// Container labels are fixed at create time, so an adopted copy keeps its warm
// label for life. This marker file is what actually says "still unclaimed", and
// it survives a manager restart.
function warmMarker(s) {
  return path.join(s.root, '.warm');
}

// Clone and boot in one pass. The caller must hold serial(source.key) and
// serial(target.key). Unlike cloneProfile this copies straight into the target
// root rather than a staging directory, because docker create needs the final
// bind-mount paths; a failure removes the container and the half-written copy.
async function cloneAndStartLocked(source, sourceMeta, target, name, labels = []) {
  if (source.key === target.key) throw new HttpError(400, 'A profile cannot copy itself.');
  if (sourceMeta.temporary) throw new HttpError(409, 'A temporary browser copy cannot be copied.');
  if (fs.existsSync(target.root) || readMeta(target)) throw new HttpError(409, 'Browser profile already exists.');
  if ((await runtimeStatus(target)).exists) await backend.remove(target.container);
  if (await sessionRuntimeCount() >= MAX_ACTIVE) {
    throw new HttpError(429, 'The browser VM is at its active browser limit. Stop an idle browser and try again.');
  }
  const state = await runtimeStatus(source);
  const shouldPause = state.running && !state.paused;
  let create = null;
  try {
    if (shouldPause) await backend.pause(source);
    try {
      fs.mkdirSync(target.chromeDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(target.downloadsDir, { recursive: true, mode: 0o700 });
      if (labels.includes('veneer.warm=1')) fs.writeFileSync(warmMarker(target), '', { mode: 0o600 });
      // execFile spawns docker before the synchronous copy blocks this thread, so
      // the container is created while the profile bytes are still moving.
      create = backend.prepare(target, labels);
      const copy = Promise.resolve().then(() => copyChromeProfile(source, target.root));
      await Promise.all([create, copy]);
    } finally {
      if (shouldPause) await backend.unpause(source);
    }
    const profile = writeMeta(target, {
      name,
      lastUsedAt: new Date().toISOString(),
      temporary: true,
      sourceProfileId: source.profileId,
      sourceGeneration: profileGeneration(sourceMeta),
      generation: 1,
    });
    await backend.start(target);
    console.log(`[veneer-browser] opened copy ${target.key.slice(0, 10)} of ${source.key.slice(0, 10)}`);
    return profile;
  } catch (error) {
    // A copy that failed early leaves the create in flight; the removal has to
    // wait for it or the container it is about to make outlives this call.
    await create?.catch(() => {});
    await backend.remove(target.container).catch(() => {});
    fs.rmSync(target.root, { recursive: true, force: true });
    throw error;
  }
}

// Docker reuses 127.0.0.1 ports, so a ticket must not outlive the runtime it
// was minted for; every removal path drops the scope's tickets with it.
function purgeTickets(s) {
  for (const [key, ticket] of tickets) {
    if (ticket.clientId === s.clientId && ticket.projectId === s.projectId && ticket.profileId === s.profileId) {
      tickets.delete(key);
    }
  }
}

// A warm copy holds no user work and its directories go with it, so a clean
// Chrome shutdown would only protect data that is about to be deleted.
async function discardWarmCopy(entry) {
  if (warmCopies.get(entry.sourceKey) === entry) warmCopies.delete(entry.sourceKey);
  return serial(entry.scope.key, async () => {
    await backend.remove(entry.containerName).catch(() => {});
    purgeTickets(entry.scope);
    fs.rmSync(entry.scope.root, { recursive: true, force: true });
    console.log(`[veneer-browser] discarded warm copy ${entry.scope.key.slice(0, 10)}`);
  });
}

function dropWarmCopy(sourceKey) {
  const entry = warmCopies.get(sourceKey);
  if (!entry) return;
  void discardWarmCopy(entry).catch((error) => console.log(`[veneer-browser] warm discard failed: ${error.message}`));
}

function warmCopyEntry(copyKey) {
  for (const entry of warmCopies.values()) if (entry.scope.key === copyKey) return entry;
  return null;
}

function warmEntryByContainer(containerName) {
  for (const entry of warmCopies.values()) if (entry.containerName === containerName) return entry;
  return null;
}

// The pool is bounded by memory, so a new copy pushes out the oldest one; the
// source being rebuilt is never the victim, or the rebuild would free nothing.
function evictOldestWarmCopy(keepSourceKey) {
  let oldest = null;
  for (const entry of warmCopies.values()) {
    if (entry.sourceKey === keepSourceKey) continue;
    if (!oldest || entry.builtAt < oldest.builtAt) oldest = entry;
  }
  if (!oldest) return false;
  console.log(`[veneer-browser] evicting warm copy ${oldest.scope.key.slice(0, 10)}: the warm pool is full`);
  dropWarmCopy(oldest.sourceKey);
  return true;
}

async function adoptWarmCopy(source, generation) {
  const entry = warmCopies.get(source.key);
  if (!entry) return null;
  // Claim registry and marker together: the sweeper reads both, and a copy that
  // is in neither looks like a stray it should delete.
  warmCopies.delete(source.key);
  fs.rmSync(warmMarker(entry.scope), { force: true });
  const current = await backend.imageId();
  const running = (await runtimeStatus(entry.scope)).running;
  if (entry.generation === generation && running && current && entry.imageId === current) {
    console.log(`[veneer-browser] adopted warm copy ${entry.scope.key.slice(0, 10)} for ${source.key.slice(0, 10)}`);
    return entry.scope;
  }
  void discardWarmCopy(entry).catch((error) => console.log(`[veneer-browser] warm discard failed: ${error.message}`));
  return null;
}

async function rebuildWarmCopy(clientId, source) {
  const sourceMeta = readMeta(source);
  if (!sourceMeta || sourceMeta.temporary) return;
  const generation = profileGeneration(sourceMeta);
  const existing = warmCopies.get(source.key);
  if (existing?.generation === generation) return;
  if (existing) dropWarmCopy(source.key);
  while (warmCopies.size >= WARM_MAX && evictOldestWarmCopy(source.key)) { /* make room */ }
  if (warmCopies.size >= WARM_MAX) {
    console.log(`[veneer-browser] warm copy skipped for ${source.key.slice(0, 10)}: the warm pool is full`);
    return;
  }
  if (await sessionRuntimeCount() >= MAX_ACTIVE) {
    console.log(`[veneer-browser] warm copy skipped for ${source.key.slice(0, 10)}: at the active browser limit`);
    return;
  }
  const target = scope(clientId, source.projectId, crypto.randomUUID());
  warmPending.add(target.container);
  try {
    await serial(target.key, () => cloneAndStartLocked(source, sourceMeta, target, sourceMeta.name, [
      'veneer.warm=1',
      `veneer.src=${source.profileId}`,
      `veneer.client=${clientId}`,
      `veneer.project=${source.projectId}`,
      `veneer.clone=${target.profileId}`,
      `veneer.gen=${generation}`,
    ]));
    warmCopies.set(source.key, {
      scope: target,
      sourceKey: source.key,
      sourceProfileId: source.profileId,
      projectId: source.projectId,
      clientId,
      generation,
      containerName: target.container,
      imageId: await backend.instanceImageId(target),
      builtAt: Date.now(),
    });
  } finally {
    warmPending.delete(target.container);
  }
  console.log(`[veneer-browser] warm copy ${target.key.slice(0, 10)} ready for ${source.key.slice(0, 10)}`);
}

// Runs after the open response is sent; a failure only costs the next open its
// head start, so it is logged rather than surfaced.
function scheduleWarmRebuild(clientId, source) {
  if (!WARM) return;
  void serial(source.key, () => rebuildWarmCopy(clientId, source))
    .catch((error) => console.log(`[veneer-browser] warm rebuild failed for ${source.key.slice(0, 10)}: ${error.message}`));
}

async function openProfile(clientId, source, cloneProfileId, name) {
  return serial(source.key, async () => {
    const sourceMeta = readMeta(source);
    if (!sourceMeta) throw new HttpError(404, 'Browser profile not found.');
    if (sourceMeta.temporary) throw new HttpError(409, 'A temporary browser copy cannot be copied.');
    const generation = profileGeneration(sourceMeta);
    const adopted = await adoptWarmCopy(source, generation);
    if (adopted) {
      try {
        await startProfile(adopted);
        return { scope: adopted, adopted: true, generation };
      } catch (error) {
        // The warm container died between the adoption checks and the start; the
        // copy is worthless now, so it goes and the open falls back to a clone.
        console.log(`[veneer-browser] adopted warm copy ${adopted.key.slice(0, 10)} failed to start: ${error.message}`);
        await discardWarmCopy({ sourceKey: source.key, scope: adopted, containerName: adopted.container })
          .catch((failure) => console.log(`[veneer-browser] warm discard failed: ${failure.message}`));
      }
    }
    const target = scope(clientId, source.projectId, cloneProfileId);
    await serial(target.key, () => cloneAndStartLocked(source, sourceMeta, target, name || sourceMeta.name));
    return { scope: target, adopted: false, generation };
  });
}

async function stopProfileLocked(s) {
  if (!(await runtimeStatus(s)).exists) return { active: false };
  await backend.stop(s);
  purgeTickets(s);
  console.log(`[veneer-browser] stopped profile ${s.key.slice(0, 10)}`);
  return { active: false };
}

async function stopProfile(s) {
  return serial(s.key, () => stopProfileLocked(s));
}

function temporaryProfileIsStale(meta, timestamp = Date.now()) {
  return meta?.temporary === true && meta.lastUsedAt && timestamp - Date.parse(meta.lastUsedAt) > TEMP_IDLE_MS;
}

function profileHasLiveConnection(s) {
  return (liveConnections.get(s.key) ?? 0) > 0;
}

// Warm containers carry their whole identity in labels so a restart can rebuild
// the registry, and a crash leaves enough to find the orphan's directories.
function listWarmContainers() {
  return backend.listWarm();
}

// Only an unclaimed copy answers to the warm label; an adopted one is an ordinary
// working copy that carries the label for the rest of its life. A copy is null
// when nothing on disk backs the container, which leaves only the container to remove.
function classifyWarmContainer(info) {
  const copy = info.valid ? scope(info.clientId, info.projectId, info.cloneProfileId) : null;
  let meta = null;
  if (copy) { try { meta = readMeta(copy); } catch {} }
  const owned = Boolean(meta?.temporary) && meta.sourceProfileId === info.sourceProfileId;
  if (owned && !fs.existsSync(warmMarker(copy))) return { adopted: true, copy: null };
  return { adopted: false, copy: owned ? copy : null };
}

async function removeWarmContainer(info, copy) {
  await backend.remove(info.name).catch(() => {});
  if (copy) {
    purgeTickets(copy);
    fs.rmSync(copy.root, { recursive: true, force: true });
  }
  console.log(`[veneer-browser] removed stray warm container ${info.name}`);
}

async function sweepWarmContainers() {
  const listed = await listWarmContainers();
  for (const info of listed) {
    // The registry is read per container and after the listing: a build that
    // finished during one of these awaits is registered now, and reading a stale
    // snapshot would delete it as a stray while the registry still points at it.
    if (warmPending.has(info.name)) continue;
    const entry = warmEntryByContainer(info.name);
    if (entry) {
      if (!info.running) dropWarmCopy(entry.sourceKey);
      continue;
    }
    const { adopted, copy } = classifyWarmContainer(info);
    if (!adopted) await removeWarmContainer(info, copy);
  }
}

async function restoreWarmRegistry() {
  for (const info of await listWarmContainers()) {
    const { adopted, copy } = classifyWarmContainer(info);
    // Adopted before the restart: it belongs to a session now, not to the pool.
    if (adopted) continue;
    if (!info.running || !copy) {
      await removeWarmContainer(info, copy);
      continue;
    }
    const source = scope(info.clientId, info.projectId, info.sourceProfileId);
    // Never overwrite a live registration: the loser would keep its container and
    // directories with nothing pointing at them. The sweeper collects it instead.
    if (warmCopies.has(source.key)) continue;
    warmCopies.set(source.key, {
      scope: copy,
      sourceKey: source.key,
      sourceProfileId: info.sourceProfileId,
      projectId: info.projectId,
      clientId: info.clientId,
      generation: info.generation,
      containerName: info.name,
      imageId: await backend.instanceImageId(copy),
      builtAt: Date.now(),
    });
    console.log(`[veneer-browser] restored warm copy ${copy.key.slice(0, 10)} for ${source.key.slice(0, 10)}`);
  }
}

async function cleanupTemporaryProfile(s, timestamp = Date.now()) {
  return serial(s.key, async () => {
    const meta = readMeta(s);
    if (warmCopyEntry(s.key)) return false;
    if (!temporaryProfileIsStale(meta, timestamp)) return false;
    if (profileHasLiveConnection(s)) return false;
    await stopProfileLocked(s);
    if ((await runtimeStatus(s)).running) return false;
    purgeTickets(s);
    fs.rmSync(s.root, { recursive: true, force: true });
    console.log(`[veneer-browser] removed stale temporary profile ${s.key.slice(0, 10)}`);
    return true;
  });
}

async function statusProfile(s) {
  const state = await runtimeStatus(s);
  return { active: state.running, status: state.status, profile: readMeta(s) };
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new HttpError(413, 'Request is too large.');
  }
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function send(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function profileFromRequest(clientId, url, body = {}) {
  const match = /^\/v1\/profiles\/([A-Za-z0-9_-]{1,200})(?:\/(start|stop|ticket|downloads|clone|promote|save|open))?$/.exec(url.pathname);
  if (!match) return null;
  const projectId = safeId(body.projectId || url.searchParams.get('projectId'), 'project');
  return { scope: scope(clientId, projectId, safeId(match[1], 'profile')), action: match[2] || '' };
}

// The Pro server pins the origin of the ticket URLs it is handed (it requires
// https + /cdp/ and connects the socket to the same origin), so a deployment
// behind a name the manager never sees sets VENEER_BROWSER_PUBLIC_ORIGIN.
// Otherwise the request's own host is echoed back, https unless a proxy said
// the hop was plain http; a request on the TLS listener is https either way.
function ticketOrigin(req) {
  if (PUBLIC_ORIGIN) {
    const origin = new URL(PUBLIC_ORIGIN);
    return { proto: origin.protocol === 'http:' ? 'http' : 'https', host: origin.host };
  }
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').replace(/[^A-Za-z0-9.:-]/g, '');
  const forwarded = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  const proto = forwarded === 'http' && !req.socket?.encrypted ? 'http' : 'https';
  return { proto, host };
}

// No port is stored: the scope is the ticket's identity, and the port behind it
// is resolved at use time so a recycled port cannot lead to another profile.
function mintTicket(req, clientId, s, purpose) {
  const ticket = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + TICKET_MS;
  tickets.set(ticket, {
    clientId,
    projectId: s.projectId,
    profileId: s.profileId,
    expiresAt,
    uses: 0,
    scope: s,
    purpose: ticketPurpose(purpose),
  });
  const { proto, host } = ticketOrigin(req);
  const wsProto = proto === 'https' ? 'wss' : 'ws';
  return {
    cdpUrl: `${wsProto}://${host}/cdp/${ticket}/ws`,
    viewerUrl: `${proto}://${host}/cdp/${ticket}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

async function apiRequest(req, res) {
  const url = new URL(req.url || '/', 'http://manager.local');
  if (url.pathname === '/health') {
    send(res, 200, { ok: true, service: 'veneer-browser-manager' });
    return;
  }
  const clientId = authenticate(req);
  const body = ['POST', 'PATCH'].includes(req.method || '') ? await readBody(req) : {};
  if (url.pathname === '/v1/profiles' && req.method === 'POST') {
    const projectId = safeId(body.projectId, 'project');
    const profileId = safeId(body.profileId, 'profile');
    const s = scope(clientId, projectId, profileId);
    if (readMeta(s)) throw new HttpError(409, 'Browser profile already exists.');
    fs.mkdirSync(s.chromeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(s.downloadsDir, { recursive: true, mode: 0o700 });
    const profile = writeMeta(s, {
      name: safeName(body.name),
      temporary: false,
      sourceProfileId: null,
      sourceGeneration: null,
      generation: 1,
    });
    send(res, 201, { ok: true, profile });
    return;
  }
  if (url.pathname === '/v1/temporary-profiles' && req.method === 'POST') {
    const projectId = safeId(body.projectId, 'project');
    const profileId = safeId(body.profileId, 'profile');
    const s = scope(clientId, projectId, profileId);
    const profile = createTemporaryProfile(s, safeName(body.name));
    send(res, 201, { ok: true, profile });
    return;
  }
  const parsed = profileFromRequest(clientId, url, body);
  if (!parsed) throw new HttpError(404, 'Not found.');
  const { scope: s, action } = parsed;
  if (req.method === 'GET' && !action) {
    const status = await statusProfile(s);
    if (!status.profile) throw new HttpError(404, 'Browser profile not found.');
    send(res, 200, { ok: true, ...status });
    return;
  }
  if (req.method === 'PATCH' && !action) {
    if (!readMeta(s)) throw new HttpError(404, 'Browser profile not found.');
    send(res, 200, { ok: true, profile: writeMeta(s, { name: safeName(body.name) }) });
    return;
  }
  if (req.method === 'POST' && action === 'clone') {
    const cloneProfileId = safeId(body.cloneProfileId, 'clone profile');
    const target = scope(clientId, s.projectId, cloneProfileId);
    const profile = await cloneProfile(s, target, safeName(body.name));
    send(res, 201, { ok: true, profile });
    return;
  }
  if (req.method === 'POST' && action === 'promote') {
    const cloneProfileId = safeId(body.cloneProfileId, 'working copy');
    const working = scope(clientId, s.projectId, cloneProfileId);
    const profile = await promoteProfile(s, working, Number(body.expectedGeneration));
    send(res, 200, { ok: true, profile });
    return;
  }
  if (req.method === 'POST' && action === 'save') {
    const profileId = safeId(body.profileId, 'profile');
    const target = scope(clientId, s.projectId, profileId);
    const profile = await saveTemporaryProfile(s, target, safeName(body.name));
    send(res, 201, { ok: true, profile });
    return;
  }
  if (req.method === 'DELETE' && !action) {
    if ((await runtimeStatus(s)).running) throw new HttpError(409, 'Stop the active browser first.');
    if (!readMeta(s)) throw new HttpError(404, 'Browser profile not found.');
    fs.rmSync(s.root, { recursive: true, force: true });
    dropWarmCopy(s.key);
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && action === 'start') {
    const runtime = await startProfile(s);
    send(res, 200, { ok: true, active: true, runtimeId: runtime.runtimeId, startedAt: new Date().toISOString() });
    return;
  }
  if (req.method === 'POST' && action === 'stop') {
    await stopProfile(s);
    send(res, 200, { ok: true, active: false, stoppedAt: new Date().toISOString() });
    return;
  }
  if (req.method === 'POST' && action === 'ticket') {
    await startProfile(s);
    const ticket = mintTicket(req, clientId, s, body.purpose);
    send(res, 200, { ok: true, cdpUrl: ticket.cdpUrl, viewerUrl: ticket.viewerUrl, expiresAt: ticket.expiresAt });
    return;
  }
  if (req.method === 'POST' && action === 'open') {
    const cloneProfileId = safeId(body.cloneProfileId, 'clone profile');
    const opened = await openProfile(clientId, s, cloneProfileId, body.name === undefined ? '' : safeName(body.name));
    const ticket = mintTicket(req, clientId, opened.scope, body.purpose);
    send(res, 200, {
      ok: true,
      cloneProfileId: opened.scope.profileId,
      adopted: opened.adopted,
      sourceGeneration: opened.generation,
      active: true,
      runtimeId: opened.scope.container,
      cdpUrl: ticket.cdpUrl,
      viewerUrl: ticket.viewerUrl,
      expiresAt: ticket.expiresAt,
    });
    scheduleWarmRebuild(clientId, s);
    return;
  }
  if (req.method === 'GET' && action === 'downloads') {
    const files = [];
    let total = 0;
    for (const entry of fs.readdirSync(s.downloadsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(s.downloadsDir, entry.name);
      const stat = fs.statSync(file);
      if (stat.size > MAX_DOWNLOAD_FILE || total + stat.size > MAX_DOWNLOAD_TOTAL) continue;
      const data = fs.readFileSync(file);
      total += data.length;
      files.push({ name: safeDownloadName(entry.name), size: data.length, data: data.toString('base64') });
    }
    send(res, 200, { ok: true, files });
    return;
  }
  throw new HttpError(404, 'Not found.');
}

function validTicket(value) {
  const ticket = tickets.get(value);
  if (!ticket || ticket.expiresAt <= Date.now() || ticket.uses >= 4) {
    tickets.delete(value);
    throw new HttpError(401, 'Browser ticket expired.');
  }
  return ticket;
}

// Docker hands the same 127.0.0.1 port to the next container, so a ticket whose
// runtime is gone must die with it rather than reach a stranger's profile.
async function ticketPort(ticket) {
  try {
    return await cdpPort(ticket.scope);
  } catch {
    throw new HttpError(401, 'Browser ticket expired.');
  }
}

async function cdpHttp(req, res) {
  const url = new URL(req.url || '/', 'http://manager.local');
  const match = /^\/cdp\/([A-Za-z0-9_-]{20,100})(\/json(?:\/.*)?)?$/.exec(url.pathname);
  if (!match) return false;
  const ticket = validTicket(match[1]);
  const port = await ticketPort(ticket);
  const suffix = match[2] || '/json/version';
  const response = await fetch(`http://127.0.0.1:${port}${suffix}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new HttpError(502, 'Browser control is unavailable.');
  const value = await response.json();
  const { proto, host } = ticketOrigin(req);
  const wsUrl = `${proto === 'https' ? 'wss' : 'ws'}://${host}/cdp/${match[1]}/ws`;
  const rewrite = (item) => item && typeof item === 'object' && item.webSocketDebuggerUrl ? { ...item, webSocketDebuggerUrl: wsUrl } : item;
  send(res, 200, Array.isArray(value) ? value.map(rewrite) : rewrite(value));
  return true;
}

// FileVault is whole-disk, so there is no per-mount check like the VM's LUKS
// one: either the disk is encrypted at rest or every saved login in the store
// is not. Off is a warning by default and fatal under
// VENEER_BROWSER_REQUIRE_ENCRYPTED=1.
async function verifyFileVault() {
  let status = '';
  try {
    ({ stdout: status } = await exec('/usr/bin/fdesetup', ['status'], { encoding: 'utf8' }));
  } catch (error) {
    return refuseUnencrypted(`FileVault status could not be read (${error.message}).`);
  }
  if (/FileVault is On/i.test(status)) return;
  return refuseUnencrypted(`FileVault is off (${status.trim() || 'unknown'}).`);
}

function refuseUnencrypted(detail) {
  const message = `${detail} Every saved login under ${STORE} is sitting unencrypted on this disk.`;
  if (REQUIRE_ENCRYPTED) throw new Error(message);
  console.log('[veneer-browser] ****************************************************************');
  console.log(`[veneer-browser] WARNING: ${message}`);
  console.log('[veneer-browser] WARNING: turn FileVault on in System Settings > Privacy & Security,');
  console.log('[veneer-browser] WARNING: or set VENEER_BROWSER_REQUIRE_ENCRYPTED=1 to refuse to start.');
  console.log('[veneer-browser] ****************************************************************');
}

// LUKS lives on the browser VM; the Mac has FileVault instead.
function verifyEncryptedStore() {
  fs.mkdirSync(STORE, { recursive: true, mode: 0o700 });
  if (DARWIN) return verifyFileVault();
  if (!REQUIRE_ENCRYPTED || backend.kind !== 'docker') return;
  return exec('findmnt', ['-n', '-o', 'SOURCE', '--target', STORE], { encoding: 'utf8' })
    .then(async ({ stdout }) => {
      const source = stdout.trim();
      if (!source) throw new Error('Browser store is not a mount.');
      const { stdout: kind } = await exec('lsblk', ['-n', '-o', 'TYPE', source], { encoding: 'utf8' });
      if (!kind.split('\n').includes('crypt')) throw new Error('Browser store is not on an encrypted device.');
    });
}

await verifyEncryptedStore();
readClients();
// The seccomp profile (docker) and the Chrome binary (native) are each their
// backend's boot requirement.
backend.verifyBoot();
if ([TLS_PORT, TLS_CERT, TLS_KEY].filter(Boolean).length % 3 !== 0) {
  throw new Error('The browser manager TLS listener needs a port, a certificate, and a key.');
}
const TLS_OPTIONS = TLS_PORT ? { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) } : null;

function isLoopbackAddress(value) {
  const address = String(value).replace(/^\[|\]$/g, '').toLowerCase();
  return address === 'localhost' || address === '::1' || address === '::ffff:127.0.0.1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}

if (DARWIN && !isLoopbackAddress(BIND) && !ALLOW_REMOTE) {
  throw new Error(
    `VENEER_BROWSER_BIND=${BIND} would publish this Mac's logged-in browser profiles beyond loopback. `
    + 'Set VENEER_BROWSER_ALLOW_REMOTE=1 as well if that is really what you want.',
  );
}
// A TLS listener is the one the Pro server pins; the plain one exists for local
// health checks. Leaving it on a routable address next to the TLS port would
// hand every ticket and bearer token to the network in cleartext.
const HTTP_BIND = TLS_OPTIONS && !isLoopbackAddress(BIND) ? '127.0.0.1' : BIND;

function handleRequest(req, res) {
  void (async () => {
    if (await cdpHttp(req, res)) return;
    await apiRequest(req, res);
  })().catch((error) => {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(`[veneer-browser] request failed: ${error.message}`);
    if (!res.headersSent) send(res, status, { ok: false, error: status >= 500 ? 'Browser manager unavailable.' : error.message });
    else res.destroy();
  });
}

const server = http.createServer(handleRequest);

const wss = new WebSocketServer({ noServer: true });
function handleUpgrade(req, socket, head) {
  const url = new URL(req.url || '/', 'http://manager.local');
  const match = /^\/cdp\/([A-Za-z0-9_-]{20,100})\/ws$/.exec(url.pathname);
  if (!match) return socket.destroy();
  let ticket;
  try {
    ticket = validTicket(match[1]);
    ticket.uses += 1;
  } catch {
    return socket.destroy();
  }
  // The container the ticket was minted for may be gone and its port already
  // handed to another profile, so the scope resolves the port at connect time.
  void cdpPort(ticket.scope).then((port) => wss.handleUpgrade(req, socket, head, (client) => {
    liveConnections.set(ticket.scope.key, (liveConnections.get(ticket.scope.key) ?? 0) + 1);
    if (ticket.purpose === 'viewer') {
      const viewers = cursorViewers.get(ticket.scope.key) ?? new Set();
      viewers.add(client);
      cursorViewers.set(ticket.scope.key, viewers);
    }
    const cursorTracker = ticket.purpose === 'agent' ? createAgentCursorTracker() : null;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = (liveConnections.get(ticket.scope.key) ?? 1) - 1;
      if (remaining > 0) liveConnections.set(ticket.scope.key, remaining);
      else liveConnections.delete(ticket.scope.key);
      if (ticket.purpose === 'viewer') {
        const viewers = cursorViewers.get(ticket.scope.key);
        viewers?.delete(client);
        if (viewers?.size === 0) cursorViewers.delete(ticket.scope.key);
      }
    };
    client.once('close', release);
    client.once('error', release);
    // Chrome requires the exact browser id. Resolve it before relaying.
    relayCdp(client, async () => {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(10_000) });
        const version = await response.json();
        const target = new URL(version.webSocketDebuggerUrl);
        return `ws://127.0.0.1:${port}${target.pathname}`;
      }, {
        // What the relay measures a setDownloadBehavior against, and the only
        // directory a download may be aimed at.
        downloadsDir: backend.downloadsPath(ticket.scope),
        onBlocked: (reason) => console.log(`[veneer-browser] ${ticket.scope.key}: refused a CDP command: ${reason}`),
        onClientMessage(data, binary) {
          writeMeta(ticket.scope, { lastUsedAt: new Date().toISOString() });
          for (const agentEvent of cursorTracker?.clientEvents(data, binary) ?? []) {
            const payload = JSON.stringify(agentEvent);
            for (const viewer of cursorViewers.get(ticket.scope.key) ?? []) {
              if (viewer.readyState === WebSocket.OPEN) viewer.send(payload);
            }
          }
        },
        onChromeMessage(data, binary) {
          cursorTracker?.chromeMessage(data, binary);
        },
      });
  }), () => socket.destroy());
}
server.on('upgrade', handleUpgrade);

setInterval(() => {
  const now = Date.now();
  for (const [key, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(key);
  if (WARM && warmRestored) void sweepWarmContainers().catch(() => {});
  const root = path.join(STORE, 'profiles');
  if (!fs.existsSync(root)) return;
  for (const client of fs.readdirSync(root)) for (const project of fs.readdirSync(path.join(root, client))) {
    for (const profile of fs.readdirSync(path.join(root, client, project))) {
      const dir = path.join(root, client, project, profile);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
        const s = scope(meta.clientId, meta.projectId, meta.profileId);
        const warm = warmCopyEntry(s.key);
        if (warm) {
          // A warm copy is never handed out, so idleness means nobody wants it.
          if (meta.lastUsedAt && now - Date.parse(meta.lastUsedAt) > IDLE_MS) dropWarmCopy(warm.sourceKey);
        } else if (temporaryProfileIsStale(meta, now)) {
          void cleanupTemporaryProfile(s, now).catch(() => {});
        } else if (meta.lastUsedAt && now - Date.parse(meta.lastUsedAt) > IDLE_MS && !profileHasLiveConnection(s)) {
          void stopProfile(s).catch(() => {});
        }
      } catch {}
    }
  }
}, SWEEP_MS).unref();

// Before the listeners: an /open during the restore would register a warm copy
// that the restore then overwrote, leaving the loser's container behind.
await backend.restore().catch((error) => console.log(`[veneer-browser] runtime restore failed: ${error.message}`));
if (WARM) {
  await restoreWarmRegistry()
    .catch((error) => console.log(`[veneer-browser] warm registry restore failed: ${error.message}`));
  warmRestored = true;
}
if (HTTP_BIND !== BIND) {
  console.log(`[veneer-browser] keeping the plain listener on ${HTTP_BIND} because the TLS listener is configured`);
}
server.listen(PORT, HTTP_BIND, () => console.log(`[veneer-browser] manager listening on ${HTTP_BIND}:${PORT} (${backend.kind})`));
if (TLS_OPTIONS) {
  const secure = https.createServer(TLS_OPTIONS, handleRequest);
  secure.on('upgrade', handleUpgrade);
  secure.listen(TLS_PORT, BIND, () => console.log(`[veneer-browser] manager listening on ${BIND}:${TLS_PORT} over TLS`));
}
