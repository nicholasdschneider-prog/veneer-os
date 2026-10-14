import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { guardedReload, windowedGuard } from './activation-guard.mjs';
import { reloadLaunchdServices } from './launchd-reload.mjs';
import { assertWithinWindow } from './window.mjs';

const END = Date.parse('2026-10-14T06:00:00Z');

test('assertWithinWindow reads the clock when called and refuses at or after the end', () => {
  let t = END - 1;
  assertWithinWindow(END, () => t, 'x');
  assertWithinWindow(new Date(END).toISOString(), () => new Date(t), 'x');
  assertWithinWindow(null, () => END + 1, 'no window');
  t = END;
  assert.throws(() => assertWithinWindow(END, () => t, 'commit'), (e) => e.code === 'refused_deadline' && /commit: refused_deadline/.test(e.message));
  assert.throws(() => assertWithinWindow('not a time', () => t, 'x'), (e) => e.code === 'refused_deadline');
});

/** The installer write phase with a clock that the guard's awaited checks can move. */
function installerRun({ crossDuring }) {
  let t = END - 60_000;
  const steps = [];
  const now = () => t;
  const guard = windowedGuard({
    deadline: END, now,
    backupCheck: (phase) => { steps.push(`backup ${phase}`); if (crossDuring === `backup ${phase}`) t = END + 1; },
    idleCheck: async (phase) => { steps.push(`idle ${phase}`); await Promise.resolve(); if (crossDuring === `idle ${phase}`) t = END + 1; },
  });
  const run = guardedReload({
    capture: () => ({ plists: ['P'], pointers: ['L'] }),
    finalCheck: guard,
    withinWindow: (phase) => assertWithinWindow(END, now, phase),
    writePlists: () => steps.push('write plists'),
    activate: () => steps.push('move pointers'),
    restorePlists: () => steps.push('restore plists'),
    restorePointers: () => steps.push('restore pointers'),
    bootstrapHelper: () => steps.push('bootstrap helper'),
    log: { error() {} },
  });
  return { run, steps };
}

test('the deadline crossing during the final occupancy await moves no pointer and bootstraps nothing', async () => {
  const { run, steps } = installerRun({ crossDuring: 'idle final check' });
  await assert.rejects(run, /final check: refused_deadline/);
  assert.deepEqual(steps, ['backup final check', 'idle final check']);
});

test('the deadline crossing during the backup hash at the final check writes nothing', async () => {
  const { run, steps } = installerRun({ crossDuring: 'backup final check' });
  await assert.rejects(run, /final check: refused_deadline/);
  assert.deepEqual(steps, ['backup final check']);
});

test('the deadline crossing during the pre-reload occupancy await restores exactly and bootstraps nothing', async () => {
  const { run, steps } = installerRun({ crossDuring: 'idle pre-reload check' });
  await assert.rejects(run, /pre-reload check: refused_deadline/);
  assert.deepEqual(steps, [
    'backup final check', 'idle final check', 'write plists', 'move pointers',
    'backup pre-reload check', 'idle pre-reload check', 'restore pointers', 'restore plists',
  ]);
});

/** launchd stand-in: bootout unloads, bootstrap loads, print fails only for unloaded jobs. */
function fakeLaunchctl(calls) {
  const loaded = new Set();
  return ([command, target, plist]) => {
    calls.push([command, target]);
    if (command === 'bootout') { loaded.delete(target); return ''; }
    if (command === 'bootstrap') { loaded.add(`${target}/${path.basename(plist, '.plist')}`); return ''; }
    if (command === 'print') { if (!loaded.has(target)) throw new Error('not loaded'); return ''; }
    return '';
  };
}

test('the deadline crossing during a job\'s idle check prevents that job\'s bootout', async () => {
  let t = END - 60_000;
  const calls = [];
  const restored = [];
  const services = ['com.veneer.pro', 'com.veneer.web-watchdog', 'com.veneer.pro.app-runner', 'com.veneer.pro.runner'].map((label) => ({ label, plist: `/a/${label}.plist` }));
  const result = await reloadLaunchdServices({
    uid: 501, services, deadline: new Date(END).toISOString(), now: () => t,
    // A slow idle answer for app-runner arrives after the window ended.
    check: async (phase) => { await Promise.resolve(); if (phase === 'before com.veneer.pro.app-runner') t = END + 5; },
    launchctl: fakeLaunchctl(calls),
    restore: { dataDir: '/d', plists: services.map((s) => ({ target: s.plist, bytes: null, mode: null })), pointers: [], labelService: {} },
    restoreOptions: { restorePlists: (p) => restored.push(...p.map((x) => path.basename(x.target, '.plist'))), restoreLinks: () => {} },
    wait: async () => {}, log: () => {},
  });
  assert.equal(result.refusal, 'refused_deadline');
  assert.deepEqual(result.jobs.map((j) => j.outcome), ['reloaded', 'reloaded', 'refused', 'not_started']);
  assert.deepEqual(calls.filter(([c]) => c === 'bootout').map(([, x]) => x.split('/').pop()), ['com.veneer.pro', 'com.veneer.web-watchdog']);
  assert.deepEqual(restored, ['com.veneer.pro.app-runner', 'com.veneer.pro.runner']);
});
