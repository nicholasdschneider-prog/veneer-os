import assert from 'node:assert/strict';
import test from 'node:test';
import { reloadLaunchdServices, renderReloadJobPlist } from './launchd-reload.mjs';

function fakeLaunchctl({ initiallyLoaded = [], failBootstrap = null } = {}) {
  const loaded = new Set(initiallyLoaded);
  const calls = [];
  const plistLabels = new Map([
    ['/tmp/web.plist', 'com.veneer.pro'],
    ['/tmp/runner.plist', 'com.veneer.pro.runner'],
    ['/tmp/probe.plist', 'com.veneer.boot-probe'],
  ]);
  const launchctl = (args) => {
    calls.push(args);
    const [command, target, plist] = args;
    if (command === 'bootout') {
      if (!loaded.delete(target)) throw new Error('not loaded');
      return '';
    }
    if (command === 'print') {
      if (!loaded.has(target)) throw new Error('not loaded');
      return 'state = running';
    }
    if (command === 'bootstrap') {
      const label = plistLabels.get(plist);
      if (label === failBootstrap) throw new Error('bootstrap rejected');
      loaded.add(`${target}/${label}`);
      return '';
    }
    if (command === 'enable') return '';
    throw new Error(`unexpected launchctl command: ${command}`);
  };
  return { calls, launchctl, loaded };
}

const services = [
  { label: 'com.veneer.pro', plist: '/tmp/web.plist' },
  { label: 'com.veneer.pro.runner', plist: '/tmp/runner.plist' },
  { label: 'com.veneer.boot-probe', plist: '/tmp/probe.plist' },
];

test('reloads the runner after persistent services and before the boot probe', async () => {
  const fake = fakeLaunchctl({ initiallyLoaded: services.map(({ label }) => `gui/501/${label}`) });
  const result = await reloadLaunchdServices({
    uid: 501,
    services,
    launchctl: fake.launchctl,
    fetchImpl: async () => ({ ok: true }),
    wait: async () => {},
    log: () => {},
  });
  assert.deepEqual(result, { ok: true, errors: [] });
  const bootouts = fake.calls.filter(([command]) => command === 'bootout').map(([, target]) => target);
  assert.deepEqual(bootouts, [
    'gui/501/com.veneer.pro',
    'gui/501/com.veneer.pro.runner',
    'gui/501/com.veneer.boot-probe',
  ]);
});

test('continues reloading later services after one bootstrap fails', async () => {
  const fake = fakeLaunchctl({
    initiallyLoaded: services.map(({ label }) => `gui/501/${label}`),
    failBootstrap: 'com.veneer.pro.runner',
  });
  const result = await reloadLaunchdServices({
    uid: 501,
    services,
    launchctl: fake.launchctl,
    fetchImpl: async () => ({ ok: true }),
    wait: async () => {},
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /com\.veneer\.pro\.runner: bootstrap rejected/);
  assert.equal(fake.loaded.has('gui/501/com.veneer.boot-probe'), true);
});

test('reports a failed post-install health assertion', async () => {
  const fake = fakeLaunchctl();
  const result = await reloadLaunchdServices({
    uid: 501,
    services: [],
    healthChecks: [{ name: 'Veneer Pro', url: 'http://127.0.0.1:3100/healthz', attempts: 1 }],
    launchctl: fake.launchctl,
    fetchImpl: async () => ({ ok: false }),
    wait: async () => {},
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /did not become healthy/);
});

test('renders a one-shot helper plist with escaped paths and no KeepAlive', () => {
  const plist = renderReloadJobPlist({
    label: 'com.veneer.pro.installer-reload',
    nodeBin: '/path/to/node',
    helperPath: '/repo/a&b/launchd-reload.mjs',
    manifestPath: '/tmp/manifest.json',
    statusPath: '/tmp/status.json',
    logPath: '/tmp/install.log',
  });
  assert.match(plist, /<string>\/repo\/a&amp;b\/launchd-reload\.mjs<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>/);
  assert.doesNotMatch(plist, /KeepAlive/);
});
