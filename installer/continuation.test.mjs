import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureState, LABEL_SERVICE, planReload, releasePointerMoves, writePlistFiles } from './activation-guard.mjs';
import { reloadLaunchdServices, reloadOrder } from './launchd-reload.mjs';
import { activateRelease, activeRelease, capturePointers, RELEASE_SERVICES, SERVICE_ENTRY, snapshotRelease } from '../scripts/releases.mjs';

const LABELS = ['com.veneer.pro', 'com.veneer.web-watchdog', 'com.veneer.pro.app-runner', 'com.veneer.pro.term', 'com.veneer.pro.runner'];

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-'));
  t.after(() => { execFileSync('chmod', ['-R', 'u+w', root]); fs.rmSync(root, { recursive: true, force: true }); });
  const app = path.join(root, 'app');
  for (const entry of Object.values(SERVICE_ENTRY)) { fs.mkdirSync(path.dirname(path.join(app, entry)), { recursive: true }); fs.writeFileSync(path.join(app, entry), '// R\n'); }
  fs.mkdirSync(path.join(app, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(app, 'web', 'dist', 'index.html'), 'R');
  const data = path.join(root, 'data');
  const release = snapshotRelease({ appRoot: app, dataDir: data });
  const agents = path.join(root, 'agents');
  fs.mkdirSync(agents);
  // Checkout mode today: every plist launches the checkout build.
  for (const label of LABELS) fs.writeFileSync(path.join(agents, `${label}.plist`), `CHECKOUT ${label}`);
  const jobs = () => LABELS.map((label) => {
    const target = path.join(agents, `${label}.plist`);
    return { label, target, mode: 0o644, text: `RELEASE ${label}`, current: fs.readFileSync(target, 'utf8') };
  });
  return { data, release, jobs };
}

/** A first activation whose helper is refused right before `refuseAt` (the real write, activation and helper). */
async function partialFirstActivation({ data, release, jobs }, refuseAt) {
  const planned = jobs();
  const state = captureState({ plistTargets: planned.map((j) => j.target), capturePointers: () => capturePointers(data, RELEASE_SERVICES) });
  writePlistFiles(planned);
  activateRelease({ dataDir: data, id: release.id, services: RELEASE_SERVICES, maintenanceApproved: true });
  const result = await reloadLaunchdServices({
    uid: 501,
    services: planned.map((j) => ({ label: j.label, plist: j.target })),
    check: async (phase) => { if (phase === `before ${refuseAt}`) throw new Error('1 active turns: production restart refused'); },
    restore: { dataDir: data, plists: state.plists, pointers: state.pointers, labelService: LABEL_SERVICE },
    launchctl: fakeLaunchctl(),
    wait: async () => {},
    log: () => {},
  });
  assert.equal(result.refused, true);
  return result;
}

/** What the continuation (`--activate-release --release <same id>`) would reload. */
function continuationPlan({ data, release, jobs }) {
  const plan = planReload({ rendered: jobs(), bounded: true, pointerMoves: releasePointerMoves({ dataDir: data, releaseId: release.id }) });
  return reloadOrder(plan.reload).map((j) => j.label);
}


/** launchd stand-in: bootout unloads, bootstrap loads, print fails only for unloaded jobs. */
function fakeLaunchctl() {
  const loaded = new Set();
  return ([command, target, plist]) => {
    if (command === 'bootout') { loaded.delete(target); return ''; }
    if (command === 'bootstrap') { loaded.add(`${target}/${path.basename(plist, '.plist')}`); return ''; }
    if (command === 'print') { if (!loaded.has(target)) throw new Error('not loaded'); return ''; }
    return '';
  };
}

test('after a refusal before app-runner, the continuation reloads exactly app-runner, term and runner on the same release', async (t) => {
  const w = world(t);
  const result = await partialFirstActivation(w, 'com.veneer.pro.app-runner');
  assert.deepEqual(result.jobs.map((j) => j.outcome), ['reloaded', 'reloaded', 'refused', 'not_started', 'not_started']);
  // The restored jobs are back in checkout mode, exactly as before the first run.
  assert.equal(activeRelease(w.data, 'veneer-pro'), w.release.id);
  for (const service of ['veneer-pro-app-runner', 'veneer-pro-term', 'veneer-pro-runner']) assert.equal(activeRelease(w.data, service), null);
  assert.equal(fs.readFileSync(w.jobs()[2].target, 'utf8'), 'CHECKOUT com.veneer.pro.app-runner');
  assert.deepEqual(continuationPlan(w), ['com.veneer.pro.app-runner', 'com.veneer.pro.term', 'com.veneer.pro.runner']);
});

test('a runner-only remainder continues with the runner alone', async (t) => {
  const w = world(t);
  await partialFirstActivation(w, 'com.veneer.pro.runner');
  assert.equal(activeRelease(w.data, 'veneer-pro-term'), w.release.id);
  assert.equal(activeRelease(w.data, 'veneer-pro-runner'), null);
  assert.deepEqual(continuationPlan(w), ['com.veneer.pro.runner']);
});

test('a refusal right after web leaves the watchdog as the remainder, sharing web\'s unchanged pointer', async (t) => {
  const w = world(t);
  await partialFirstActivation(w, 'com.veneer.web-watchdog');
  assert.equal(activeRelease(w.data, 'veneer-pro'), w.release.id); // web runs it, so its pointer stays
  assert.equal(fs.readFileSync(w.jobs()[1].target, 'utf8'), 'CHECKOUT com.veneer.web-watchdog');
  assert.deepEqual(continuationPlan(w), ['com.veneer.web-watchdog', 'com.veneer.pro.app-runner', 'com.veneer.pro.term', 'com.veneer.pro.runner']);
});

test('the continuation is expressible only through the guarded installer, never restart.mjs', () => {
  const restart = fs.readFileSync(new URL('../scripts/restart.mjs', import.meta.url), 'utf8');
  // restart.mjs moves pointers only for services whose plist already launches a release.
  assert.match(restart, /if \(entry === activeEntry\(dataDir, service\)\) releaseMode\.add\(service\)/);
  const installer = fs.readFileSync(new URL('./install-darwin.mjs', import.meta.url), 'utf8');
  for (const flag of ["flag('release'", "flag('expect-jobs'", "flag('source-sha'", "flag('expect-manifest'", "flag('deadline'", "flag('backup-receipt'"]) assert.ok(installer.includes(flag), flag);
});
