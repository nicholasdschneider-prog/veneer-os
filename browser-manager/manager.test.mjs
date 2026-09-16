import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { seedDownloadPreferences } from './backends/native.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-browser-manager-'));
const store = path.join(root, 'store');
const bin = path.join(root, 'bin');
const clientsFile = path.join(root, 'clients.json');
const seccomp = path.join(root, 'seccomp.json');
const dockerLog = path.join(root, 'docker.log');
const dockerState = path.join(root, 'docker-state.json');
const imageFile = path.join(root, 'image-id');
const runningFile = path.join(root, 'running-container');
const managerDir = path.dirname(new URL(import.meta.url).pathname);
const token = 'test-browser-token';
const clientId = 'test-client';
const projectId = 'test-project';
const sourceProfileId = 'saved-login';
const cloneProfileId = 'temporary-copy';
const freshProfileId = 'fresh-copy';
const children = [];
let cdpServer;
let cdpPort;
let port;
let child;
let childOutput = '';

// The fake docker keeps container state in a JSON file so tests can watch the
// manager create, start, label and remove containers without a real daemon.
const FAKE_DOCKER = `import fs from 'node:fs';

const args = process.argv.slice(2);
const stateFile = process.env.FAKE_DOCKER_STATE;
const lockDir = \`\${stateFile}.lock\`;

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lock() {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    try { fs.mkdirSync(lockDir); return; } catch { pause(5); }
  }
  throw new Error('fake docker lock timeout');
}

function load() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { containers: {} }; }
}

function save(state) {
  fs.writeFileSync(stateFile, \`\${JSON.stringify(state)}\\n\`);
}

function imageId() {
  try { return fs.readFileSync(process.env.FAKE_IMAGE_FILE, 'utf8').trim() || 'sha256:image-one'; }
  catch { return 'sha256:image-one'; }
}

function forcedRunning() {
  try { return fs.readFileSync(process.env.FAKE_RUNNING_FILE, 'utf8').split('\\n')[0].trim(); }
  catch { return ''; }
}

function out(text) {
  process.stdout.write(\`\${text}\\n\`);
}

function render(format, name, container) {
  return format
    .replaceAll('{{.Names}}', name)
    .replaceAll('{{.ID}}', name)
    .replaceAll('{{.State}}', container.running ? 'running' : 'created')
    .replace(/\\{\\{\\.Label "([^"]+)"\\}\\}/g, (_, key) => container.labels[key] ?? '');
}

function run(state) {
  const [command] = args;
  const last = args[args.length - 1];
  if (command === 'inspect') {
    const format = args[args.indexOf('--format') + 1];
    const container = state.containers[last];
    if (format === '{{.Image}}') {
      if (!container) return 1;
      out(container.image);
      return 0;
    }
    if (container || forcedRunning() === last) {
      const running = container ? container.running : true;
      out(JSON.stringify({ Running: running, Paused: false, Status: running ? 'running' : 'created' }));
      return 0;
    }
    return 1;
  }
  if (command === 'image' && args[1] === 'inspect') {
    out(imageId());
    return 0;
  }
  if (command === 'create') {
    const labels = {};
    let name = '';
    for (let index = 1; index < args.length; index += 1) {
      if (args[index] === '--name') name = args[index + 1];
      if (args[index] === '--label') {
        const value = args[index + 1];
        const split = value.indexOf('=');
        labels[value.slice(0, split)] = value.slice(split + 1);
      }
    }
    if (!name || state.containers[name]) return 1;
    state.containers[name] = { running: false, labels, image: imageId() };
    save(state);
    out(name);
    return 0;
  }
  if (command === 'start' || command === 'stop') {
    const container = state.containers[last];
    if (!container) return 1;
    container.running = command === 'start';
    save(state);
    out(last);
    return 0;
  }
  if (command === 'pause' || command === 'unpause') return 0;
  if (command === 'rm') {
    if (!state.containers[last]) return args.includes('-f') ? 0 : 1;
    delete state.containers[last];
    save(state);
    out(last);
    return 0;
  }
  if (command === 'port') {
    if (!state.containers[last === '9222/tcp' ? args[1] : last]) return 1;
    out(\`9222/tcp -> 127.0.0.1:\${process.env.FAKE_CDP_PORT}\`);
    return 0;
  }
  if (command === 'ps') {
    const filter = args[args.indexOf('--filter') + 1] || '';
    const label = filter.startsWith('label=') ? filter.slice(6) : '';
    const split = label.indexOf('=');
    const key = label.slice(0, split);
    const value = label.slice(split + 1);
    const format = args[args.indexOf('--format') + 1] || '{{.Names}}';
    const lines = [];
    for (const [name, container] of Object.entries(state.containers)) {
      if (!args.includes('-a') && !container.running) continue;
      if (key && container.labels[key] !== value) continue;
      lines.push(render(format, name, container));
    }
    if (lines.length) out(lines.join('\\n'));
    return 0;
  }
  return 1;
}

fs.appendFileSync(process.env.FAKE_DOCKER_LOG, \`\${args.join(' ')}\\n\`);
lock();
let code = 1;
try { code = run(load()); }
finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
process.exit(code);
`;

// A stand-in for Chrome: it claims the port it was handed, answers the readiness
// probe and the CDP HTTP proxy, and stays up until it is signalled, so the native
// backend's spawn, readiness poll, state file and kill paths are all exercised
// without a browser.
const FAKE_CHROME = `import fs from 'node:fs';
import http from 'node:http';

const args = process.argv.slice(2);
const port = Number((args.find((arg) => arg.startsWith('--remote-debugging-port=')) || '').split('=')[1]);
const userDataDir = (args.find((arg) => arg.startsWith('--user-data-dir=')) || '').split('=')[1] || '';
fs.appendFileSync(process.env.FAKE_CHROME_LOG, \`\${process.pid}\t\${args.join(' ')}\n\`);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    Browser: 'Chrome/fake-native',
    userDataDir,
    webSocketDebuggerUrl: \`ws://127.0.0.1:\${port}/devtools/browser/fake\`,
  }));
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function profileScope(profileId, storeDir = store) {
  const clientKey = hash(`client\0${clientId}`).slice(0, 32);
  const projectKey = hash(`project\0${clientId}\0${projectId}`).slice(0, 32);
  const profileKey = hash(`profile\0${clientId}\0${projectId}\0${profileId}`).slice(0, 32);
  const profileRoot = path.join(storeDir, 'profiles', clientKey, projectKey, profileKey);
  return {
    profileKey,
    profileRoot,
    container: `veneer-browser-${profileKey}`,
    chromeDir: path.join(profileRoot, 'chrome'),
    metaFile: path.join(profileRoot, 'metadata.json'),
  };
}

function markWarm(target) {
  fs.writeFileSync(path.join(target.profileRoot, '.warm'), '');
}

function readMeta(target) {
  return JSON.parse(fs.readFileSync(target.metaFile, 'utf8'));
}

function writeMeta(target, meta) {
  fs.writeFileSync(target.metaFile, `${JSON.stringify(meta)}\n`);
}

function containers(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')).containers; } catch { return {}; }
}

function warmContainers(stateFile) {
  return Object.entries(containers(stateFile))
    .filter(([, container]) => container.labels['veneer.warm'] === '1')
    .map(([name, container]) => ({ name, ...container }));
}

// A warm container exists from docker create onwards, but its copy is only
// complete once the manager has started it.
function readyWarmContainers(stateFile) {
  return warmContainers(stateFile).filter((container) => container.running);
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const selected = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return selected;
}

async function request(route, init = {}, targetPort = port) {
  return fetch(`http://127.0.0.1:${targetPort}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

function secureRequest(tlsPort, route, init = {}) {
  return new Promise((resolve, reject) => {
    const call = https.request({
      host: '127.0.0.1',
      port: tlsPort,
      path: route,
      method: init.method || 'GET',
      rejectUnauthorized: false,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (response) => {
      let raw = '';
      response.on('data', (chunk) => { raw += String(chunk); });
      response.on('end', () => resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : {} }));
    });
    call.on('error', reject);
    if (init.body) call.write(init.body);
    call.end();
  });
}

async function waitFor(check, timeoutMs = 5000, output = () => childOutput) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for browser manager.\n${output()}`);
}

function spawnManager(env) {
  const manager = spawn(process.execPath, ['manager.mjs'], {
    cwd: managerDir,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      // Every instance below is docker-backed unless it opts into the native
      // backend; on darwin the manager would otherwise default to native.
      VENEER_BROWSER_BACKEND: 'docker',
      VENEER_BROWSER_CLIENTS_FILE: clientsFile,
      VENEER_BROWSER_SECCOMP: seccomp,
      VENEER_BROWSER_REQUIRE_ENCRYPTED: '0',
      VENEER_BROWSER_CHROME_UID: String(process.getuid?.() ?? 0),
      VENEER_BROWSER_CHROME_GID: String(process.getgid?.() ?? 0),
      VENEER_BROWSER_TEMP_IDLE_MINUTES: '5',
      VENEER_BROWSER_SWEEP_SECONDS: '1',
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_DOCKER_STATE: dockerState,
      FAKE_RUNNING_FILE: runningFile,
      FAKE_IMAGE_FILE: imageFile,
      FAKE_CDP_PORT: String(cdpPort),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(manager);
  return manager;
}

// A second manager on its own store, docker state and log; the fake docker reads
// all three from the environment, so instances never see each other's containers.
async function startManager(name, env = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const instance = {
    port: await freePort(),
    store: path.join(dir, 'store'),
    state: path.join(dir, 'docker-state.json'),
    log: path.join(dir, 'docker.log'),
    running: path.join(dir, 'running-container'),
    image: path.join(dir, 'image-id'),
    output: '',
  };
  fs.writeFileSync(instance.state, `${JSON.stringify({ containers: {} })}\n`);
  fs.writeFileSync(instance.running, '');
  fs.writeFileSync(instance.log, '');
  fs.writeFileSync(instance.image, 'sha256:image-one\n');
  instance.env = {
    VENEER_BROWSER_MANAGER_PORT: String(instance.port),
    VENEER_BROWSER_STORE: instance.store,
    FAKE_DOCKER_LOG: instance.log,
    FAKE_DOCKER_STATE: instance.state,
    FAKE_RUNNING_FILE: instance.running,
    FAKE_IMAGE_FILE: instance.image,
    ...env,
  };
  instance.scope = (profileId) => profileScope(profileId, instance.store);
  instance.call = (route, init) => request(route, init, instance.port);
  instance.wait = (check, timeoutMs) => waitFor(check, timeoutMs, () => instance.output);
  await launchManager(instance);
  return instance;
}

async function launchManager(instance) {
  instance.output = '';
  instance.child = spawnManager(instance.env);
  instance.child.stdout.on('data', (data) => { instance.output += String(data); });
  instance.child.stderr.on('data', (data) => { instance.output += String(data); });
  await instance.wait(async () => {
    try { return (await fetch(`http://127.0.0.1:${instance.port}/health`)).ok; }
    catch { return false; }
  });
}

async function restartManager(instance) {
  instance.child.kill('SIGTERM');
  await new Promise((resolve) => instance.child.once('exit', resolve));
  await launchManager(instance);
}

before(async () => {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(clientsFile, `${JSON.stringify({
    version: 1,
    clients: [{ id: clientId, tokenHash: hash(token) }],
  })}\n`);
  fs.writeFileSync(seccomp, '{}\n');
  const source = profileScope(sourceProfileId);
  const dockerScript = path.join(root, 'fake-docker.mjs');
  fs.writeFileSync(dockerScript, FAKE_DOCKER);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nexec "${process.execPath}" "${dockerScript}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(dockerState, `${JSON.stringify({ containers: {} })}\n`);
  fs.writeFileSync(imageFile, 'sha256:image-one\n');
  fs.writeFileSync(runningFile, `veneer-browser-${source.profileKey}\n`);
  fs.writeFileSync(dockerLog, '');

  cdpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'Chrome/fake', webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/browser/fake` }));
  });
  await new Promise((resolve) => cdpServer.listen(0, '127.0.0.1', resolve));
  cdpPort = cdpServer.address().port;

  port = await freePort();
  child = spawnManager({
    VENEER_BROWSER_MANAGER_PORT: String(port),
    VENEER_BROWSER_STORE: store,
  });
  child.stdout.on('data', (data) => { childOutput += String(data); });
  child.stderr.on('data', (data) => { childOutput += String(data); });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; }
    catch { return false; }
  });
});

after(async () => {
  // Wait for the managers to exit: a sweep in flight would recreate files under
  // the temporary root while it is being removed.
  await Promise.all(children.map((manager) => new Promise((resolve) => {
    if (manager.exitCode !== null || manager.signalCode) return resolve();
    manager.once('exit', resolve);
    manager.kill('SIGTERM');
  })));
  cdpServer?.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('clones a live profile into independent encrypted-store ownership and removes a stale copy', async () => {
  const created = await request('/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ projectId, profileId: sourceProfileId, name: 'Saved login' }),
  });
  assert.equal(created.status, 201);

  const source = profileScope(sourceProfileId);
  const clone = profileScope(cloneProfileId);
  fs.writeFileSync(path.join(source.chromeDir, 'Cookies'), 'source-login');
  fs.writeFileSync(path.join(source.chromeDir, 'SingletonLock'), 'live-lock');
  // Chrome keeps login state in restricted-mode nested files, and its profiles
  // contain symlinks (SingletonCookie); the copy+chown pass must survive both.
  fs.mkdirSync(path.join(source.chromeDir, 'Default'), { mode: 0o700 });
  fs.writeFileSync(path.join(source.chromeDir, 'Default', 'Cookies'), 'nested-login', { mode: 0o600 });
  fs.symlinkSync('missing-target', path.join(source.chromeDir, 'DanglingLink'));

  const copied = await request(`/v1/profiles/${sourceProfileId}/clone`, {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId, name: 'Temporary copy' }),
  });
  assert.equal(copied.status, 201);
  assert.equal(fs.readFileSync(path.join(clone.chromeDir, 'Cookies'), 'utf8'), 'source-login');
  assert.equal(fs.existsSync(path.join(clone.chromeDir, 'SingletonLock')), false);
  assert.equal(fs.readFileSync(path.join(clone.chromeDir, 'Default', 'Cookies'), 'utf8'), 'nested-login');
  const nested = fs.statSync(path.join(clone.chromeDir, 'Default', 'Cookies'));
  assert.equal(nested.uid, process.getuid?.() ?? 0);
  assert.equal(fs.lstatSync(path.join(clone.chromeDir, 'DanglingLink')).isSymbolicLink(), true);
  const cloneMeta = readMeta(clone);
  assert.equal(cloneMeta.temporary, true);
  assert.equal(cloneMeta.sourceProfileId, sourceProfileId);
  assert.equal(cloneMeta.sourceGeneration, 1);

  fs.writeFileSync(path.join(clone.chromeDir, 'Cookies'), 'clone-only-change');
  assert.equal(fs.readFileSync(path.join(source.chromeDir, 'Cookies'), 'utf8'), 'source-login');
  const dockerCalls = fs.readFileSync(dockerLog, 'utf8');
  assert.match(dockerCalls, new RegExp(`pause veneer-browser-${source.profileKey}`));
  assert.match(dockerCalls, new RegExp(`unpause veneer-browser-${source.profileKey}`));

  cloneMeta.lastUsedAt = '2000-01-01T00:00:00.000Z';
  writeMeta(clone, cloneMeta);
  await waitFor(() => !fs.existsSync(clone.profileRoot), 4000);
  assert.equal(fs.existsSync(source.profileRoot), true);
});

test('updates a saved profile atomically, keeps a backup, and rejects an old generation', async () => {
  const source = profileScope(sourceProfileId);
  const clone = profileScope(cloneProfileId);
  fs.writeFileSync(runningFile, `veneer-browser-${source.profileKey}\n`);
  const copied = await request(`/v1/profiles/${sourceProfileId}/clone`, {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId, name: 'Temporary copy' }),
  });
  assert.equal(copied.status, 201);
  fs.writeFileSync(runningFile, '');
  fs.writeFileSync(path.join(clone.chromeDir, 'Cookies'), 'new-login-state');

  const promoted = await request(`/v1/profiles/${sourceProfileId}/promote`, {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId, expectedGeneration: 1 }),
  });
  assert.equal(promoted.status, 200);
  assert.equal(fs.readFileSync(path.join(source.chromeDir, 'Cookies'), 'utf8'), 'new-login-state');
  const sourceMeta = readMeta(source);
  assert.equal(sourceMeta.temporary, false);
  assert.equal(sourceMeta.generation, 2);

  const backupRoot = path.join(store, 'backups');
  const backupCookies = [];
  for (const client of fs.readdirSync(backupRoot)) {
    for (const project of fs.readdirSync(path.join(backupRoot, client))) {
      for (const profile of fs.readdirSync(path.join(backupRoot, client, project))) {
        for (const backup of fs.readdirSync(path.join(backupRoot, client, project, profile))) {
          backupCookies.push(fs.readFileSync(path.join(backupRoot, client, project, profile, backup, 'chrome', 'Cookies'), 'utf8'));
        }
      }
    }
  }
  assert.deepEqual(backupCookies, ['source-login']);

  const stale = await request(`/v1/profiles/${sourceProfileId}/promote`, {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId, expectedGeneration: 1 }),
  });
  assert.equal(stale.status, 409);
  assert.equal(fs.readFileSync(path.join(source.chromeDir, 'Cookies'), 'utf8'), 'new-login-state');
});

test('leaves disposable cache data out of a clone and keeps profile data', async () => {
  const cacheProfileId = 'cache-source';
  const cacheCopyId = 'cache-copy';
  const source = profileScope(cacheProfileId);
  const copy = profileScope(cacheCopyId);
  const created = await request('/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ projectId, profileId: cacheProfileId, name: 'Cache heavy' }),
  });
  assert.equal(created.status, 201);

  const seed = (relative, content) => {
    const target = path.join(source.chromeDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, content);
  };
  seed('component_crx_cache/entry', 'crx cache');
  seed('BrowserMetrics-spare.pma', 'metrics');
  seed('Crashpad/settings.dat', 'crash state');
  seed('Default/Cache/data_0', 'http cache');
  seed('Default/Code Cache/js/index', 'code cache');
  seed('Profile 1/GPUCache/data_1', 'gpu cache');
  seed('Default/Cookies', 'cookie-jar');
  seed('Default/Local Storage/leveldb/000003.log', 'local storage');
  // Site data holds like-named directories deeper down; only shallow ones are disposable.
  seed('Default/IndexedDB/Cache/data_0', 'indexeddb cache');

  const copied = await request(`/v1/profiles/${cacheProfileId}/clone`, {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: cacheCopyId, name: 'Cache copy' }),
  });
  assert.equal(copied.status, 201);
  for (const dropped of [
    'component_crx_cache',
    'BrowserMetrics-spare.pma',
    'Crashpad',
    path.join('Default', 'Cache'),
    path.join('Default', 'Code Cache'),
    path.join('Profile 1', 'GPUCache'),
  ]) {
    assert.equal(fs.existsSync(path.join(copy.chromeDir, dropped)), false, dropped);
  }
  assert.equal(fs.existsSync(path.join(copy.chromeDir, 'Profile 1')), true);
  assert.equal(fs.readFileSync(path.join(copy.chromeDir, 'Default', 'Cookies'), 'utf8'), 'cookie-jar');
  assert.equal(
    fs.readFileSync(path.join(copy.chromeDir, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'utf8'),
    'local storage',
  );
  assert.equal(
    fs.readFileSync(path.join(copy.chromeDir, 'Default', 'IndexedDB', 'Cache', 'data_0'), 'utf8'),
    'indexeddb cache',
  );
});

test('creates a signed-out temporary profile and saves it only through save-as', async () => {
  const fresh = profileScope(freshProfileId);
  const saved = profileScope('separate-login');
  const created = await request('/v1/temporary-profiles', {
    method: 'POST',
    body: JSON.stringify({ projectId, profileId: freshProfileId, name: 'Signed-out working copy' }),
  });
  assert.equal(created.status, 201);
  const freshMeta = readMeta(fresh);
  assert.equal(freshMeta.temporary, true);
  assert.equal(freshMeta.sourceProfileId, null);
  fs.writeFileSync(path.join(fresh.chromeDir, 'Cookies'), 'separate-login-state');

  const savedResponse = await request(`/v1/profiles/${freshProfileId}/save`, {
    method: 'POST',
    body: JSON.stringify({ projectId, profileId: 'separate-login', name: 'Other Gmail' }),
  });
  assert.equal(savedResponse.status, 201);
  assert.equal(fs.readFileSync(path.join(saved.chromeDir, 'Cookies'), 'utf8'), 'separate-login-state');
  const savedMeta = readMeta(saved);
  assert.equal(savedMeta.temporary, false);
  assert.equal(savedMeta.generation, 1);
  assert.equal(fs.existsSync(fresh.profileRoot), true);
});

// One instance for the whole fast-start flow: its two active slots make the warm
// pool's effect on the active limit observable.
let fast;

test('opens a saved profile as a running working copy with a ticket', async () => {
  fast = await startManager('fast', { VENEER_BROWSER_MAX_ACTIVE: '2' });
  const source = fast.scope('open-source');
  const created = await fast.call('/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ projectId, profileId: 'open-source', name: 'Open source' }),
  });
  assert.equal(created.status, 201);
  fs.writeFileSync(path.join(source.chromeDir, 'Cookies'), 'open-login');

  const opened = await fast.call('/v1/profiles/open-source/open', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'work-one', purpose: 'agent' }),
  });
  assert.equal(opened.status, 200);
  const body = await opened.json();
  const work = fast.scope('work-one');
  assert.equal(body.ok, true);
  assert.equal(body.cloneProfileId, 'work-one');
  assert.equal(body.adopted, false);
  assert.equal(body.sourceGeneration, 1);
  assert.equal(body.active, true);
  assert.equal(body.runtimeId, work.container);
  assert.match(body.cdpUrl, new RegExp(`^wss://127\\.0\\.0\\.1:${fast.port}/cdp/[A-Za-z0-9_-]{20,}/ws$`));
  assert.match(body.viewerUrl, new RegExp(`^https://127\\.0\\.0\\.1:${fast.port}/cdp/[A-Za-z0-9_-]{20,}$`));
  assert.ok(Date.parse(body.expiresAt) > Date.now());

  assert.equal(fs.readFileSync(path.join(work.chromeDir, 'Cookies'), 'utf8'), 'open-login');
  const workMeta = readMeta(work);
  assert.equal(workMeta.temporary, true);
  assert.equal(workMeta.sourceProfileId, 'open-source');
  assert.equal(workMeta.sourceGeneration, 1);
  assert.equal(containers(fast.state)[work.container].running, true);

  // The copy runs against a created-but-not-started container, so the two steps
  // must be separate docker calls.
  const calls = fs.readFileSync(fast.log, 'utf8');
  assert.equal(calls.includes('run -d'), false);
  assert.ok(calls.includes(`create --name ${work.container}`));
  assert.ok(calls.includes(`start ${work.container}`));
  assert.ok(calls.indexOf(`create --name ${work.container}`) < calls.indexOf(`start ${work.container}`));
});

test('rebuilds a warm copy after an open and keeps it out of the active browser limit', async () => {
  const source = fast.scope('open-source');
  await fast.wait(() => readyWarmContainers(fast.state).length === 1, 10_000);
  const [warm] = readyWarmContainers(fast.state);
  assert.equal(warmContainers(fast.state).length, 1);
  assert.equal(warm.labels['veneer.browser'], '1');
  assert.equal(warm.labels['veneer.src'], 'open-source');
  assert.equal(warm.labels['veneer.client'], clientId);
  assert.equal(warm.labels['veneer.project'], projectId);
  assert.equal(warm.labels['veneer.gen'], '1');
  const warmCopy = fast.scope(warm.labels['veneer.clone']);
  assert.equal(warmCopy.container, warm.name);
  assert.equal(fs.readFileSync(path.join(warmCopy.chromeDir, 'Cookies'), 'utf8'), 'open-login');
  assert.equal(readMeta(warmCopy).sourceProfileId, 'open-source');
  assert.equal(readMeta(source).generation, 1);

  // Two containers are running, but only one of them is a session, so a second
  // source still fits inside VENEER_BROWSER_MAX_ACTIVE=2.
  const other = await fast.call('/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ projectId, profileId: 'other-source', name: 'Other source' }),
  });
  assert.equal(other.status, 201);
  const second = await fast.call('/v1/profiles/other-source/open', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'work-two' }),
  });
  assert.equal(second.status, 200);
  assert.equal(Object.keys(containers(fast.state)).length, 3);

  const third = await fast.call('/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ projectId, profileId: 'third-source', name: 'Third source' }),
  });
  assert.equal(third.status, 201);
  const refused = await fast.call('/v1/profiles/third-source/open', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'work-three' }),
  });
  assert.equal(refused.status, 429);
  assert.equal(fs.existsSync(fast.scope('work-three').profileRoot), false);
});

test('adopts the warm copy on the next open even at the active browser limit', async () => {
  const [warm] = readyWarmContainers(fast.state);
  const warmCloneId = warm.labels['veneer.clone'];
  const opened = await fast.call('/v1/profiles/open-source/open', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'work-four' }),
  });
  assert.equal(opened.status, 200, fast.output);
  const body = await opened.json();
  assert.equal(body.adopted, true);
  assert.equal(body.cloneProfileId, warmCloneId);
  assert.equal(body.runtimeId, warm.name);
  assert.equal(body.sourceGeneration, 1);
  assert.equal(fs.existsSync(fast.scope('work-four').profileRoot), false);
  assert.equal(containers(fast.state)[warm.name].running, true);
  assert.ok(Date.now() - Date.parse(readMeta(fast.scope(warmCloneId)).lastUsedAt) < 60_000);
  // The adopted copy is now a session, which leaves no room for a fresh warm copy.
  const sourceKey = fast.scope('open-source').profileKey.slice(0, 10);
  await fast.wait(() => fast.output.includes(`warm copy skipped for ${sourceKey}`), 10_000);
  // It keeps the warm label for life, so the stray-container sweep must not take
  // a session away from its owner.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(containers(fast.state)[warm.name].running, true);
  assert.equal(fs.existsSync(fast.scope(warmCloneId).profileRoot), true);
});

test('rejects an open for a profile that does not exist', async () => {
  const missing = await fast.call('/v1/profiles/no-such-profile/open', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'work-five' }),
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'Browser profile not found.');
});

let warmOps;

test('refuses to adopt a warm copy of a superseded generation', async () => {
  warmOps = await startManager('warm-ops');
  const source = warmOps.scope('gen-source');
  const created = await warmOps.call('/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ projectId, profileId: 'gen-source', name: 'Generation source' }),
  });
  assert.equal(created.status, 201);
  fs.writeFileSync(path.join(source.chromeDir, 'Cookies'), 'gen-one');

  const first = await warmOps.call('/v1/profiles/gen-source/open', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'gen-work-one' }),
  });
  assert.equal(first.status, 200);
  await warmOps.wait(() => readyWarmContainers(warmOps.state).length === 1, 10_000);
  const [stale] = readyWarmContainers(warmOps.state);
  const staleCopy = warmOps.scope(stale.labels['veneer.clone']);

  const meta = readMeta(source);
  writeMeta(source, { ...meta, generation: 7 });
  const second = await warmOps.call('/v1/profiles/gen-source/open', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'gen-work-two' }),
  });
  assert.equal(second.status, 200);
  const body = await second.json();
  assert.equal(body.adopted, false);
  assert.equal(body.cloneProfileId, 'gen-work-two');
  assert.equal(body.sourceGeneration, 7);
  await warmOps.wait(() => !containers(warmOps.state)[stale.name] && !fs.existsSync(staleCopy.profileRoot), 10_000);
});

test('sweeps stray warm containers but keeps the registered one', async () => {
  // The rebuild after the last open registers a warm copy at the new generation.
  await warmOps.wait(() => readyWarmContainers(warmOps.state).length === 1, 10_000);
  const [warm] = readyWarmContainers(warmOps.state);
  assert.equal(warm.labels['veneer.gen'], '7');
  const warmCopy = warmOps.scope(warm.labels['veneer.clone']);

  // Idle past VENEER_BROWSER_TEMP_IDLE_MINUTES: the temporary-copy sweeper must
  // leave a registered warm copy alone.
  const warmMeta = readMeta(warmCopy);
  writeMeta(warmCopy, { ...warmMeta, lastUsedAt: new Date(Date.now() - 10 * 60_000).toISOString() });

  const cloned = await warmOps.call('/v1/profiles/gen-source/clone', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'orphan-copy', name: 'Orphan copy' }),
  });
  assert.equal(cloned.status, 201);
  const orphanCopy = warmOps.scope('orphan-copy');
  markWarm(orphanCopy);
  const state = JSON.parse(fs.readFileSync(warmOps.state, 'utf8'));
  state.containers[orphanCopy.container] = {
    running: true,
    image: 'sha256:image-one',
    labels: {
      'veneer.browser': '1',
      'veneer.warm': '1',
      'veneer.src': 'gen-source',
      'veneer.client': clientId,
      'veneer.project': projectId,
      'veneer.clone': 'orphan-copy',
      'veneer.gen': '7',
    },
  };
  fs.writeFileSync(warmOps.state, `${JSON.stringify(state)}\n`);

  await warmOps.wait(() => !containers(warmOps.state)[orphanCopy.container] && !fs.existsSync(orphanCopy.profileRoot), 10_000);
  assert.equal(fs.existsSync(warmCopy.profileRoot), true);
  assert.equal(containers(warmOps.state)[warm.name].running, true);
});

test('rebuilds the warm registry from container labels after a restart', async () => {
  const [warm] = readyWarmContainers(warmOps.state);
  const warmCloneId = warm.labels['veneer.clone'];
  const cloned = await warmOps.call('/v1/profiles/gen-source/clone', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'stopped-warm-copy', name: 'Stopped warm copy' }),
  });
  assert.equal(cloned.status, 201);
  const stopped = warmOps.scope('stopped-warm-copy');
  markWarm(stopped);
  const state = JSON.parse(fs.readFileSync(warmOps.state, 'utf8'));
  state.containers[stopped.container] = {
    running: false,
    image: 'sha256:image-one',
    labels: { ...warm.labels, 'veneer.clone': 'stopped-warm-copy' },
  };
  fs.writeFileSync(warmOps.state, `${JSON.stringify(state)}\n`);

  await restartManager(warmOps);
  await warmOps.wait(() => warmOps.output.includes('restored warm copy'), 5000);
  // A warm container that did not survive the restart takes its copy with it.
  await warmOps.wait(() => !containers(warmOps.state)[stopped.container] && !fs.existsSync(stopped.profileRoot), 5000);

  const opened = await warmOps.call('/v1/profiles/gen-source/open', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'gen-work-three' }),
  });
  assert.equal(opened.status, 200);
  const body = await opened.json();
  assert.equal(body.adopted, true);
  assert.equal(body.cloneProfileId, warmCloneId);
  assert.equal(body.sourceGeneration, 7);
});

test('keeps the warm pool inside VENEER_BROWSER_WARM_MAX by evicting the oldest copy', async () => {
  const capped = await startManager('warm-cap', { VENEER_BROWSER_WARM_MAX: '1' });
  for (const profile of ['cap-one', 'cap-two']) {
    const created = await capped.call('/v1/profiles', {
      method: 'POST',
      body: JSON.stringify({ projectId, profileId: profile, name: profile }),
    });
    assert.equal(created.status, 201);
  }
  const first = await capped.call('/v1/profiles/cap-one/open', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'cap-work-one' }),
  });
  assert.equal(first.status, 200);
  await capped.wait(() => readyWarmContainers(capped.state).length === 1, 10_000);
  const [firstWarm] = readyWarmContainers(capped.state);
  assert.equal(firstWarm.labels['veneer.src'], 'cap-one');
  const firstCopy = capped.scope(firstWarm.labels['veneer.clone']);

  const second = await capped.call('/v1/profiles/cap-two/open', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'cap-work-two' }),
  });
  assert.equal(second.status, 200);
  // Two saved profiles, one warm slot: the newer copy takes it and the older
  // copy leaves with its container and its directories.
  await capped.wait(() => {
    const warm = warmContainers(capped.state);
    return warm.length === 1
      && warm[0].running
      && warm[0].labels['veneer.src'] === 'cap-two'
      && !fs.existsSync(firstCopy.profileRoot);
  }, 10_000);
  assert.ok(capped.output.includes('the warm pool is full'), capped.output);
  assert.equal(fs.existsSync(capped.scope('cap-work-two').profileRoot), true);
});

test('expires a ticket once its container is gone instead of reaching a recycled port', async () => {
  const ticketed = await startManager('tickets', { VENEER_BROWSER_WARM: '0' });
  const created = await ticketed.call('/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ projectId, profileId: 'ticket-source', name: 'Ticket source' }),
  });
  assert.equal(created.status, 201);
  const minted = await ticketed.call('/v1/profiles/ticket-source/ticket', {
    method: 'POST',
    body: JSON.stringify({ projectId, purpose: 'agent' }),
  });
  assert.equal(minted.status, 200);
  const cdpPath = new URL((await minted.json()).viewerUrl).pathname;
  const live = await fetch(`http://127.0.0.1:${ticketed.port}${cdpPath}`);
  assert.equal(live.status, 200);
  assert.equal((await live.json()).Browser, 'Chrome/fake');

  // Docker hands the same 127.0.0.1 port to the next container, so a ticket must
  // not survive the container it was minted for.
  const state = JSON.parse(fs.readFileSync(ticketed.state, 'utf8'));
  delete state.containers[ticketed.scope('ticket-source').container];
  fs.writeFileSync(ticketed.state, `${JSON.stringify(state)}\n`);

  const expired = await fetch(`http://127.0.0.1:${ticketed.port}${cdpPath}`);
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error, 'Browser ticket expired.');
});

test('leaves the warm pool switched off when VENEER_BROWSER_WARM is 0', async () => {
  const cold = await startManager('cold', { VENEER_BROWSER_WARM: '0' });
  const created = await cold.call('/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ projectId, profileId: 'cold-source', name: 'Cold source' }),
  });
  assert.equal(created.status, 201);
  const opened = await cold.call('/v1/profiles/cold-source/open', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'cold-work' }),
  });
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).adopted, false);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(Object.keys(containers(cold.state)), [cold.scope('cold-work').container]);
});

test('refuses to boot with a partial TLS listener configuration', async () => {
  const partial = spawnManager({
    VENEER_BROWSER_MANAGER_PORT: String(await freePort()),
    VENEER_BROWSER_STORE: path.join(root, 'tls-partial', 'store'),
    VENEER_BROWSER_TLS_PORT: String(await freePort()),
  });
  let output = '';
  partial.stdout.on('data', (data) => { output += String(data); });
  partial.stderr.on('data', (data) => { output += String(data); });
  const code = await new Promise((resolve) => partial.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(output, /TLS listener needs a port, a certificate, and a key/);
});

test('refuses a non-loopback bind on macOS unless remote access is explicit', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  const exposed = spawnManager({
    VENEER_BROWSER_MANAGER_PORT: String(await freePort()),
    VENEER_BROWSER_STORE: path.join(root, 'bind-exposed', 'store'),
    VENEER_BROWSER_BIND: '0.0.0.0',
  });
  let output = '';
  exposed.stdout.on('data', (data) => { output += String(data); });
  exposed.stderr.on('data', (data) => { output += String(data); });
  const code = await new Promise((resolve) => exposed.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(output, /VENEER_BROWSER_ALLOW_REMOTE=1/);

  // Saying so out loud is allowed: the owner gets a listener, not a lecture.
  const allowed = await startManager('bind-allowed', {
    VENEER_BROWSER_BIND: '0.0.0.0',
    VENEER_BROWSER_ALLOW_REMOTE: '1',
  });
  assert.match(allowed.output, /manager listening on 0\.0\.0\.0:/);
});

test('keeps the plain listener on loopback whenever a TLS listener is configured', async (t) => {
  const dir = path.join(root, 'bind-tls');
  fs.mkdirSync(dir, { recursive: true });
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  const openssl = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
  ], { stdio: 'ignore' });
  if (openssl.status !== 0) return t.skip('openssl is unavailable');

  const tlsPort = await freePort();
  const split = await startManager('bind-split', {
    VENEER_BROWSER_BIND: '0.0.0.0',
    VENEER_BROWSER_ALLOW_REMOTE: '1',
    VENEER_BROWSER_TLS_PORT: String(tlsPort),
    VENEER_BROWSER_TLS_CERT: cert,
    VENEER_BROWSER_TLS_KEY: key,
  });
  // Tickets and bearer tokens would otherwise cross the LAN in cleartext.
  assert.match(split.output, /keeping the plain listener on 127\.0\.0\.1/);
  assert.match(split.output, /manager listening on 127\.0\.0\.1:\d+ \(/);
  assert.match(split.output, new RegExp(`manager listening on 0\\.0\\.0\\.0:${tlsPort} over TLS`));
});

test('serves the same API over the TLS listener with https ticket urls', async (t) => {
  const dir = path.join(root, 'tls');
  fs.mkdirSync(dir, { recursive: true });
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  const openssl = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
  ], { stdio: 'ignore' });
  if (openssl.status !== 0) return t.skip('openssl is unavailable');

  const tlsPort = await freePort();
  const tls = await startManager('tls-instance', {
    VENEER_BROWSER_TLS_PORT: String(tlsPort),
    VENEER_BROWSER_TLS_CERT: cert,
    VENEER_BROWSER_TLS_KEY: key,
  });
  const health = await secureRequest(tlsPort, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.service, 'veneer-browser-manager');

  const created = await secureRequest(tlsPort, '/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ projectId, profileId: 'tls-source', name: 'TLS source' }),
  });
  assert.equal(created.status, 201);
  const opened = await secureRequest(tlsPort, '/v1/profiles/tls-source/open', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'tls-work' }),
  });
  assert.equal(opened.status, 200);
  assert.match(opened.body.cdpUrl, new RegExp(`^wss://127\\.0\\.0\\.1:${tlsPort}/cdp/`));
  assert.match(opened.body.viewerUrl, new RegExp(`^https://127\\.0\\.0\\.1:${tlsPort}/cdp/`));
  assert.equal(containers(tls.state)[tls.scope('tls-work').container].running, true);
});

function installFakeChrome() {
  const dir = path.join(root, 'native-bin');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'fake-chrome.mjs');
  fs.writeFileSync(script, FAKE_CHROME);
  const binary = path.join(dir, 'fake-chrome');
  // exec, not a child: the pid the manager records has to be the process that
  // ends up holding the profile, or the kill and ownership checks miss it.
  fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return binary;
}

function nativeProcesses(instance) {
  try { return JSON.parse(fs.readFileSync(path.join(instance.store, 'runtime', 'native-processes.json'), 'utf8')).processes; }
  catch { return {}; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

let native;
const chromeLog = path.join(root, 'native-chrome.log');

test('opens a working copy as a native chrome process and stops it again', async () => {
  fs.writeFileSync(chromeLog, '');
  native = await startManager('native', {
    VENEER_BROWSER_BACKEND: 'native',
    VENEER_BROWSER_CHROME_BIN: installFakeChrome(),
    VENEER_BROWSER_WARM: '0',
    FAKE_CHROME_LOG: chromeLog,
  });
  const created = await native.call('/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ projectId, profileId: 'native-source', name: 'Native source' }),
  });
  assert.equal(created.status, 201);
  const source = native.scope('native-source');
  fs.writeFileSync(path.join(source.chromeDir, 'Cookies'), 'native-login');

  const opened = await native.call('/v1/profiles/native-source/open', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'native-work', purpose: 'agent' }),
  });
  assert.equal(opened.status, 200, native.output);
  const body = await opened.json();
  const work = native.scope('native-work');
  assert.equal(body.adopted, false);
  assert.equal(body.runtimeId, work.container);
  assert.equal(fs.readFileSync(path.join(work.chromeDir, 'Cookies'), 'utf8'), 'native-login');

  // The process is tracked on disk so a restart can reap or keep it.
  const entry = nativeProcesses(native)[work.container];
  assert.ok(entry, native.output);
  assert.equal(pidAlive(entry.pid), true);
  assert.equal(entry.chromeDir, work.chromeDir);

  const launch = fs.readFileSync(chromeLog, 'utf8').split('\n').find((line) => line.includes(work.chromeDir));
  assert.ok(launch, chromeLog);
  assert.ok(launch.includes('--headless=new'));
  assert.ok(launch.includes('--remote-debugging-address=127.0.0.1'));
  // Chrome refuses a DevTools upgrade carrying a browser Origin header unless
  // this flag is present, which is what keeps a page in the operator's own
  // browser off this loopback port. The relay dials it from Node with no Origin.
  assert.equal(launch.includes('--remote-allow-origins'), false);
  assert.ok(launch.includes('--disable-file-system'));
  assert.ok(launch.includes(`--remote-debugging-port=${entry.port}`));
  assert.equal(launch.includes('--window-size=1440,1000'), true);

  // Downloads have no managed policy to lean on here, so the profile carries it.
  const prefs = JSON.parse(fs.readFileSync(path.join(work.chromeDir, 'Default', 'Preferences'), 'utf8'));
  assert.equal(prefs.download.default_directory, path.join(work.profileRoot, 'downloads'));
  assert.equal(prefs.download.prompt_for_download, false);

  // The CDP HTTP proxy reaches the live process through the ticket.
  const cdpPath = new URL(body.viewerUrl).pathname;
  const proxied = await fetch(`http://127.0.0.1:${native.port}${cdpPath}`);
  assert.equal(proxied.status, 200);
  const version = await proxied.json();
  assert.equal(version.Browser, 'Chrome/fake-native');
  assert.match(version.webSocketDebuggerUrl, new RegExp(`^wss://127\\.0\\.0\\.1:${native.port}/cdp/`));

  const stopped = await native.call('/v1/profiles/native-work/stop', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
  assert.equal(stopped.status, 200);
  assert.equal(nativeProcesses(native)[work.container], undefined);
  await native.wait(() => !pidAlive(entry.pid), 10_000);
});

test('reaps a native process record whose browser died while the manager was down', async () => {
  const opened = await native.call('/v1/profiles/native-source/open', {
    method: 'POST',
    body: JSON.stringify({ projectId, cloneProfileId: 'native-work-two' }),
  });
  assert.equal(opened.status, 200);
  const work = native.scope('native-work-two');
  const entry = nativeProcesses(native)[work.container];
  assert.ok(entry);

  process.kill(entry.pid, 'SIGKILL');
  await waitFor(() => !pidAlive(entry.pid), 5000, () => native.output);
  await restartManager(native);
  assert.equal(nativeProcesses(native)[work.container], undefined, native.output);

  const status = await native.call(`/v1/profiles/native-work-two?projectId=${projectId}`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).active, false);
});

test('forces the ticket origin the Pro server pins with VENEER_BROWSER_PUBLIC_ORIGIN', async () => {
  const pinned = await startManager('public-origin', {
    VENEER_BROWSER_WARM: '0',
    VENEER_BROWSER_PUBLIC_ORIGIN: 'https://veneer-browser.localhost:7301/',
  });
  const created = await pinned.call('/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ projectId, profileId: 'origin-source', name: 'Origin source' }),
  });
  assert.equal(created.status, 201);
  const minted = await pinned.call('/v1/profiles/origin-source/ticket', {
    method: 'POST',
    body: JSON.stringify({ projectId, purpose: 'agent' }),
  });
  assert.equal(minted.status, 200);
  const ticket = await minted.json();
  assert.match(ticket.cdpUrl, /^wss:\/\/veneer-browser\.localhost:7301\/cdp\/[A-Za-z0-9_-]{20,}\/ws$/);
  assert.match(ticket.viewerUrl, /^https:\/\/veneer-browser\.localhost:7301\/cdp\/[A-Za-z0-9_-]{20,}$/);

  // The proxy rewrites Chrome's socket url to the same pinned origin.
  const proxied = await fetch(`http://127.0.0.1:${pinned.port}${new URL(ticket.viewerUrl).pathname}`);
  assert.equal(proxied.status, 200);
  assert.match((await proxied.json()).webSocketDebuggerUrl, /^wss:\/\/veneer-browser\.localhost:7301\/cdp\//);
});

test('merges download preferences into an existing profile instead of clobbering it', () => {
  const dir = path.join(root, 'prefs', 'chrome');
  const downloads = path.join(root, 'prefs', 'downloads');
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({
    profile: { name: 'Person 1' },
    download: { directory_upgrade: true, default_directory: '/old/place', prompt_for_download: true },
  }));

  const merged = seedDownloadPreferences(dir, downloads);
  assert.equal(merged.profile.name, 'Person 1');
  assert.equal(merged.download.directory_upgrade, true);
  assert.equal(merged.download.default_directory, downloads);
  assert.equal(merged.download.prompt_for_download, false);
  assert.equal(merged.savefile.default_directory, downloads);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8')),
    merged,
  );

  // A corrupt preferences file is replaced rather than inherited.
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), 'not json');
  const rebuilt = seedDownloadPreferences(dir, downloads);
  assert.equal(rebuilt.download.default_directory, downloads);
});
