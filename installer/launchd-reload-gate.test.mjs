import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gateFromManifest, reloadLaunchdServices, restoreNotReloaded } from './launchd-reload.mjs';

// Manifest order from the installer; the helper reorders: web, watchdog, app-runner, term, runner.
const services = ['com.veneer.web-watchdog', 'com.veneer.pro', 'com.veneer.pro.app-runner', 'com.veneer.pro.term', 'com.veneer.pro.runner']
  .map((label) => ({ label, plist: `/agents/${label}.plist` }));

function fakeLaunchctl() {
  const loaded = new Set(services.map(({ label }) => `gui/501/${label}`));
  const calls = [];
  const launchctl = ([command, target, plist]) => {
    calls.push([command, target]);
    if (command === 'bootout') { loaded.delete(target); return ''; }
    if (command === 'print') { if (!loaded.has(target)) throw new Error('not loaded'); return ''; }
    if (command === 'bootstrap') { loaded.add(`gui/501/${path.basename(plist, '.plist')}`); return ''; }
    return '';
  };
  return { calls, launchctl };
}

const run = (check, extra = {}) => {
  const fake = fakeLaunchctl();
  const restored = [];
  return reloadLaunchdServices({
    uid: 501, services, check, launchctl: fake.launchctl, fetchImpl: async () => ({ ok: true }), wait: async () => {}, log: () => {},
    restore: { dataDir: '/data', plists: services.map((s) => ({ target: s.plist, bytes: 'b2xk', mode: 0o644 })), pointers: [], labelService: {} },
    restoreOptions: { restorePlists: (plists) => restored.push(...plists.map((p) => path.basename(p.target, '.plist'))), restoreLinks: () => {} },
    ...extra,
  }).then((result) => ({ result, fake, restored }));
};

test('the helper checks the whole plan first and every job right before its bootout', async () => {
  const phases = [];
  const { result, fake } = await run(async (phase, jobs) => { phases.push([phase, jobs.join(',')]); });
  assert.equal(result.ok, true);
  assert.deepEqual(phases.map(([p]) => p), [
    'helper start', 'before com.veneer.pro', 'before com.veneer.web-watchdog', 'before com.veneer.pro.app-runner', 'before com.veneer.pro.term', 'before com.veneer.pro.runner',
  ]);
  assert.equal(phases[0][1], 'com.veneer.pro,com.veneer.web-watchdog,com.veneer.pro.app-runner,com.veneer.pro.term,com.veneer.pro.runner');
  // Each check happens before that job's bootout, never after.
  const bootouts = fake.calls.filter(([c]) => c === 'bootout').map(([, t]) => t.split('/').pop());
  assert.deepEqual(bootouts, phases.slice(1).map(([p]) => p.replace('before ', '')));
  assert.ok(result.jobs.every((job) => job.outcome === 'reloaded'));
});

test('a turn arriving mid-sequence stops it: reloaded jobs stay, the rest are restored, nothing is retried', async () => {
  let calls = 0;
  const { result, fake, restored } = await run(async (phase) => {
    calls += 1;
    if (phase === 'before com.veneer.pro.app-runner') throw new Error('1 active turns: production restart refused');
  });
  assert.equal(result.ok, false);
  assert.equal(result.refused, true);
  assert.deepEqual(result.jobs.map((j) => [j.label, j.outcome]), [
    ['com.veneer.pro', 'reloaded'], ['com.veneer.web-watchdog', 'reloaded'],
    ['com.veneer.pro.app-runner', 'refused'], ['com.veneer.pro.term', 'not_started'], ['com.veneer.pro.runner', 'not_started'],
  ]);
  assert.deepEqual(restored, ['com.veneer.pro.app-runner', 'com.veneer.pro.term', 'com.veneer.pro.runner']);
  assert.ok(result.jobs.slice(2).every((j) => j.restored === true));
  assert.match(result.errors[0], /before com.veneer.pro.app-runner: 1 active turns/);
  assert.deepEqual(fake.calls.filter(([c]) => c === 'bootout').map(([, t]) => t.split('/').pop()), ['com.veneer.pro', 'com.veneer.web-watchdog']);
  assert.equal(calls, 4); // start + three per-job checks, then stop: no retry
});

test('a refusal at helper start reloads nothing and restores every job', async () => {
  const { result, fake, restored } = await run(async (phase) => { if (phase === 'helper start') throw new Error('Veneer Browser is in use'); });
  assert.equal(result.refused, true);
  assert.ok(result.jobs.every((j) => j.outcome === 'not_started' || j.outcome === 'refused'));
  assert.equal(fake.calls.filter(([c]) => c === 'bootout').length, 0);
  assert.equal(restored.length, services.length);
});

test('restoring jobs never reached puts back their plists and only their own pointers', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-restore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const restoredLinks = [];
  const restore = {
    dataDir: dir,
    plists: services.map((s) => ({ target: s.plist, bytes: null, mode: null })),
    pointers: [{ service: 'veneer-pro', active: '../A', previous: null }, { service: 'veneer-pro-runner', active: null, previous: null }],
    labelService: { 'com.veneer.pro': 'veneer-pro', 'com.veneer.pro.runner': 'veneer-pro-runner', 'com.veneer.web-watchdog': 'web-watchdog' },
  };
  const plists = [];
  restoreNotReloaded(restore, services.filter((s) => ['com.veneer.web-watchdog', 'com.veneer.pro.runner'].includes(s.label)), {
    restorePlists: (p) => plists.push(...p.map((x) => x.target)), restoreLinks: (_d, pointers) => restoredLinks.push(...pointers.map((p) => p.service)),
  });
  assert.deepEqual(plists.sort(), ['/agents/com.veneer.pro.runner.plist', '/agents/com.veneer.web-watchdog.plist']);
  // Web was reloaded, so its pointer stays; the watchdog follows it.
  assert.deepEqual(restoredLinks, ['veneer-pro-runner']);
});

test('the manifest gate never grants an override it was not given', async () => {
  assert.equal(gateFromManifest(null), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-gate-'));
  try {
    const gate = gateFromManifest({ dataDir: dir, serverPackage: path.resolve('server/package.json'), browserEnvFile: path.join(dir, 'none.env'), browserPort: 7300 });
    await assert.rejects(gate('helper start', ['com.veneer.pro']), /approved maintenance window is required/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const source = fs.readFileSync(new URL('./launchd-reload.mjs', import.meta.url), 'utf8');
  assert.match(source, /allowActive: gate\.allowActive === true/);
  assert.doesNotMatch(source, /allowActive: true/);
});
