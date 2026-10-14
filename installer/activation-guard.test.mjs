import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertReloadSafe, browserOccupancy, captureState, describePlan, guardedReload, planReload, RELEASE_JOB_LABELS, restorePlistFiles, writePlistFiles,
} from './activation-guard.mjs';
import {
  activateRelease, activeRelease, capturePointers, previousRelease, RELEASE_SERVICES, restorePointers, SERVICE_ENTRY, snapshotRelease,
} from '../scripts/releases.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPackage = path.join(repo, 'server', 'package.json');
const Database = createRequire(serverPackage)('better-sqlite3');
const idle = async () => ({ installed: true, active: 0, waiting: 0 });

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-guard-'));
  t.after(() => { execFileSync('chmod', ['-R', 'u+w', root]); fs.rmSync(root, { recursive: true, force: true }); });
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  const db = new Database(path.join(data, 'veneer-pro.db'));
  db.exec("CREATE TABLE pending_turns (conversation_id TEXT, status TEXT)");
  db.close();
  return { root, data, setPending: (n) => {
    const w = new Database(path.join(data, 'veneer-pro.db'));
    w.exec('DELETE FROM pending_turns');
    for (let i = 0; i < n; i++) w.prepare("INSERT INTO pending_turns VALUES (?, 'pending')").run(`chat-${i}`);
    w.close();
  } };
}

function app(root, marker) {
  const dir = path.join(root, 'app');
  for (const entry of Object.values(SERVICE_ENTRY)) {
    fs.mkdirSync(path.dirname(path.join(dir, entry)), { recursive: true });
    fs.writeFileSync(path.join(dir, entry), `// ${marker}\n`);
  }
  fs.mkdirSync(path.join(dir, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'web', 'dist', 'index.html'), marker);
  return dir;
}

const check = (data, extra = {}) => (phase) => assertReloadSafe({ phase, jobs: ['com.veneer.pro'], dataDir: data, serverPackage, maintenanceApproved: true, occupancy: idle, ...extra });

test('the whole-plan pre-check refuses pending turns, a missing approval, and allows only an explicit interruption', async (t) => {
  const { data, setPending } = sandbox(t);
  setPending(2);
  await assert.rejects(check(data)('pre-check'), /pre-check: 2 active turns: production restart refused/);
  await assert.rejects(check(data, { maintenanceApproved: false })('pre-check'), /approved maintenance window is required/);
  await check(data, { allowActive: true })('pre-check'); // explicit flag only
  setPending(0);
  await check(data)('pre-check');
});

// The installer's write phase, built from the real pieces, with failure hooks.
function writePhase({ data, release, jobs, fault = {} }) {
  const bootstrapped = [];
  return {
    bootstrapped,
    args: {
      capture: () => captureState({ plistTargets: jobs.map((j) => j.target), capturePointers: () => capturePointers(data, RELEASE_SERVICES) }),
      finalCheck: async (phase) => { fault.check?.(phase); await check(data)(phase); },
      writePlists: () => writePlistFiles(jobs, { beforeWrite: fault.beforeWrite, beforeChmod: fault.beforeChmod }),
      activate: () => activateRelease({ dataDir: data, id: release, services: RELEASE_SERVICES, maintenanceApproved: true, hooks: { beforeLink: fault.beforeLink, beforeLog: fault.beforeLog } }),
      restorePlists: (plists) => restorePlistFiles(plists),
      restorePointers: (pointers) => restorePointers(data, pointers, { reason: 'test refusal' }),
      bootstrapHelper: () => { fault.bootstrap?.(); bootstrapped.push('helper'); },
      log: { error() {} },
    },
  };
}

function prior(t) {
  const { root, data, setPending } = sandbox(t);
  const dir = app(root, 'A');
  const a = snapshotRelease({ appRoot: dir, dataDir: data });
  activateRelease({ dataDir: data, id: a.id, services: ['veneer-pro'], maintenanceApproved: true }); // web on A; others have none
  fs.writeFileSync(path.join(dir, SERVICE_ENTRY['veneer-pro']), '// B\n');
  const b = snapshotRelease({ appRoot: dir, dataDir: data });
  const agents = path.join(root, 'agents');
  fs.mkdirSync(agents);
  const jobs = ['com.veneer.pro', 'com.veneer.pro.app-runner', 'com.veneer.pro.term', 'com.veneer.web-watchdog', 'com.veneer.pro.runner'].map((label, i) => {
    const target = path.join(agents, `${label}.plist`);
    if (i !== 2) { fs.writeFileSync(target, `OLD ${label}`); fs.chmodSync(target, i === 1 ? 0o600 : 0o644); } // term absent before
    return { label, target, text: `NEW ${label}`, mode: 0o644 };
  });
  const snapshot = () => ({
    plists: jobs.map((j) => (fs.existsSync(j.target) ? [fs.readFileSync(j.target, 'utf8'), fs.statSync(j.target).mode & 0o777] : null)),
    pointers: capturePointers(data, RELEASE_SERVICES),
  });
  return { data, setPending, a, b, jobs, snapshot };
}

test('a refusal at the final check writes nothing', async (t) => {
  const { data, setPending, b, jobs, snapshot } = prior(t);
  const before = snapshot();
  setPending(1);
  const phase = writePhase({ data, release: b.id, jobs });
  await assert.rejects(guardedReload(phase.args), /final check: 1 active turns/);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(phase.bootstrapped, []);
});

test('a turn arriving after activation restores the exact prior pointers and plists; nothing reloads', async (t) => {
  const { data, setPending, a, b, jobs, snapshot } = prior(t);
  const before = snapshot();
  const order = [];
  const phase = writePhase({ data, release: b.id, jobs, fault: { check: (p) => {
    order.push(`${p}:${activeRelease(data, 'veneer-pro')}`);
    if (p === 'pre-reload check') setPending(1); // new work arrives during activation
  } } });
  await assert.rejects(guardedReload(phase.args), /pre-reload check: 1 active turns/);
  // The new release became active only after the final check had passed.
  assert.deepEqual(order, [`final check:${a.id}`, `pre-reload check:${b.id}`]);
  assert.deepEqual(snapshot(), before);
  assert.equal(activeRelease(data, 'veneer-pro'), a.id);
  for (const service of RELEASE_SERVICES.filter((s) => s !== 'veneer-pro')) assert.equal(activeRelease(data, service), null);
  assert.deepEqual(phase.bootstrapped, []);
});

// Every step that can fail, at every position: first/middle/last plist write
// and chmod, each pointer move, the activation log, the helper bootstrap.
const boom = () => { throw new Error('injected failure'); };
const nth = (n, key) => { let i = 0; return (arg) => { if (i++ === n) boom(arg); void key; }; };
for (const [name, fault] of [
  ['first plist write', { beforeWrite: nth(0) }],
  ['middle plist write', { beforeWrite: nth(2) }],
  ['last plist write', { beforeWrite: nth(4) }],
  ['first chmod', { beforeChmod: nth(0) }],
  ['middle chmod', { beforeChmod: nth(2) }],
  ['last chmod', { beforeChmod: nth(4) }],
  ...[0, 1, 2, 3, 4].map((n) => [`pointer move ${n + 1}`, { beforeLink: nth(n) }]),
  ['activation log write', { beforeLog: boom }],
  ['helper bootstrap', { bootstrap: boom }],
]) {
  test(`a failure at the ${name} restores plists, modes and pointers byte-exactly and bootstraps nothing`, async (t) => {
    const { data, b, jobs, snapshot } = prior(t);
    const before = snapshot();
    const phase = writePhase({ data, release: b.id, jobs, fault });
    await assert.rejects(guardedReload(phase.args), /injected failure/);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(phase.bootstrapped, []);
    for (const entry of fs.readdirSync(path.join(data, 'releases', 'active'))) assert.doesNotMatch(entry, /\.tmp-/);
  });
}

test('restart.mjs activation of one service also restores its pointers on a partial failure', (t) => {
  const { data, a, b } = prior(t);
  activateRelease({ dataDir: data, id: a.id, services: ['veneer-pro-runner'], maintenanceApproved: true });
  const before = capturePointers(data, RELEASE_SERVICES);
  assert.throws(() => activateRelease({ dataDir: data, id: b.id, services: ['veneer-pro-runner'], maintenanceApproved: true, hooks: { beforeLink: nth(1) } }), /every pointer was restored: injected failure/);
  assert.deepEqual(capturePointers(data, RELEASE_SERVICES), before);
});

test('occupied, held or unknown browsers refuse; the token never appears in output', async (t) => {
  const { root, data } = sandbox(t);
  const browserEnvFile = path.join(root, 'browser.env');
  assert.deepEqual(await browserOccupancy({ browserEnvFile }), { installed: false, active: 0, waiting: 0 });
  fs.writeFileSync(browserEnvFile, 'VP_VENEER_BROWSER_CLIENT_ID=veneer\nVP_VENEER_BROWSER_TOKEN=secret-token-value\n');
  let seen = null;
  const fake = (body, status = 200) => async (url, init) => { seen = { url, auth: init.headers.authorization }; return { ok: status === 200, status, json: async () => body }; };
  const busy = await browserOccupancy({ browserEnvFile, fetchImpl: fake({ active: 1, waiting: 0, limit: 7 }) });
  assert.equal(seen.url, 'http://127.0.0.1:7300/v1/capacity');
  assert.equal(seen.auth, 'Bearer secret-token-value');
  assert.deepEqual(busy, { installed: true, active: 1, waiting: 0 });
  const refuse = (o) => assertReloadSafe({ phase: 'pre-check', jobs: ['com.veneer.pro.runner'], dataDir: data, serverPackage, maintenanceApproved: true, occupancy: async () => o });
  await assert.rejects(refuse(busy), /Veneer Browser is in use or its state is unknown \(1 running working copy, 0 waiting\)/);
  const unknown = await browserOccupancy({ browserEnvFile, fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
  await assert.rejects(refuse(unknown), /UNKNOWN: browser manager unreachable/);
  const unauthorized = await browserOccupancy({ browserEnvFile, fetchImpl: fake({}, 401) });
  await assert.rejects(refuse(unauthorized), /HTTP 401/);
  for (const o of [busy, unknown, unauthorized]) assert.doesNotMatch(JSON.stringify(o), /secret-token-value/);
  await refuse({ installed: true, active: 0, waiting: 0 });
});

test('a bounded reload lists only changed release jobs and reports untouched jobs it leaves alone', () => {
  const job = (label, changed) => ({ label, text: 'new', current: changed ? 'old' : 'new' });
  const rendered = [
    job('com.veneer.pro', true), job('com.veneer.pro.runner', true), job('com.veneer.pro.app-runner', false), job('com.veneer.pro.term', false),
    job('com.veneer.web-watchdog', true), job('com.veneer.chrome', true), job('com.veneer.browser-manager', false),
    job('com.veneer.pro.cloudflared', false), job('com.veneer.pro.backup', true), job('com.veneer.boot-probe', false),
  ];
  const plan = planReload({ rendered, bounded: true, pointerMoves: new Set(['com.veneer.pro.app-runner']) });
  assert.deepEqual(plan.reload.map((j) => j.label), ['com.veneer.pro', 'com.veneer.pro.runner', 'com.veneer.pro.app-runner', 'com.veneer.web-watchdog']);
  assert.equal(plan.reload.find((j) => j.label === 'com.veneer.pro.app-runner').reason, 'release pointer moves');
  assert.deepEqual(plan.untouchedChanged, ['com.veneer.chrome', 'com.veneer.pro.backup']);
  for (const label of plan.reload.map((j) => j.label)) assert.ok(RELEASE_JOB_LABELS.includes(label));
  assert.equal(planReload({ rendered, bounded: false }).reload.length, rendered.length);
  assert.deepEqual(planReload({ rendered: rendered.map((j) => ({ ...j, current: j.text })), bounded: true }).reload, []);
});

test('the dry-run plan names the exact jobs, the pending turns and the browser occupancy', () => {
  const lines = describePlan({
    bounded: true, releaseId: 'abc123def456-0123456789ab', releaseServices: RELEASE_SERVICES,
    plan: { reload: [{ label: 'com.veneer.pro', reason: 'plist changed, release pointer moves' }], untouchedChanged: ['com.veneer.chrome'] },
    pending: 0, occupancy: { installed: true, active: 0, waiting: 0 }, allowActive: false,
  });
  assert.deepEqual(lines, [
    '[install] mode   bounded: release services only, no provisioning',
    `[install] release abc123def456-0123456789ab would be snapshotted and activated for ${RELEASE_SERVICES.join(', ')}`,
    '[install] reload com.veneer.pro (plist changed, release pointer moves)',
    '[install] NOT reloaded although their rendered plists differ (needs a separately approved full install): com.veneer.chrome',
    '[install] pending turns 0',
    '[install] browsers 0 running working copies, 0 waiting',
  ]);
  assert.match(describePlan({ bounded: false, plan: { reload: [], untouchedChanged: [] }, pending: null, occupancy: { installed: false }, allowActive: true }).join('\n'), /no database yet[\s\S]*not installed[\s\S]*human-authorized interruption/);
});

test('the installer guards before any write and activates only inside guardedReload', () => {
  const source = fs.readFileSync(path.join(repo, 'installer', 'install-darwin.mjs'), 'utf8');
  const pre = source.indexOf("await guard('pre-check')");
  assert.ok(pre > 0);
  for (const write of ['upsertEnvValues(envFile', 'provisionLocalBrowserManager(', 'snapshotRelease(', 'await guardedReload(']) assert.ok(source.indexOf(write, pre) > pre, write);
  assert.ok(source.indexOf('upsertEnvValues(envFile') > pre);
  // The only activation call sits inside the guarded write phase.
  const activations = [...source.matchAll(/activateRelease\(\{/g)].map((m) => m.index);
  assert.equal(activations.length, 1);
  assert.ok(activations[0] > source.indexOf('await guardedReload('));
  assert.doesNotMatch(source, /allowActive(Turns)?\s*=\s*true/);
  assert.match(source, /const allowActiveTurns = args\.includes\('--allow-active-turns'\)/);
});
