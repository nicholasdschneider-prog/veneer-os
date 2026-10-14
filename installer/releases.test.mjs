import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  activateRelease, activeEntry, activeLink, activeRelease, plistRoots, previousRelease, RELEASE_SERVICES, SERVICE_ENTRY,
  snapshotRelease, verifyRelease,
} from '../scripts/releases.mjs';
import { renderWatchdog } from './web-watchdog.mjs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'releases-'));
  t.after(() => { execFileSync('chmod', ['-R', 'u+w', root]); fs.rmSync(root, { recursive: true, force: true }); });
  const app = path.join(root, 'app');
  const data = path.join(root, 'data');
  build(app, 'A');
  fs.writeFileSync(path.join(app, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(app, 'server', 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(app, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(app, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(app, 'web', 'dist', 'index.html'), '<html></html>');
  return { app, data };
}

// Every service entry prints the build marker and where it actually runs from.
function build(app, marker) {
  for (const entry of Object.values(SERVICE_ENTRY)) {
    const file = path.join(app, entry);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `console.log(${JSON.stringify(marker)} + ' ' + new URL(import.meta.url).pathname);\n`);
  }
}

const run = (entry) => execFileSync(process.execPath, [entry], { encoding: 'utf8' }).trim().split(' ');

test('a snapshot copies the build read-only and activates nothing', (t) => {
  const { app, data } = fixture(t);
  const release = snapshotRelease({ appRoot: app, dataDir: data });
  assert.match(release.id, /^nogit-[0-9a-f]{12}$/);
  assert.equal(release.reused, false);
  for (const service of RELEASE_SERVICES) assert.equal(activeRelease(data, service), null);
  assert.equal(fs.existsSync(path.join(data, 'releases', 'active')), false);
  assert.throws(() => fs.writeFileSync(path.join(release.dir, SERVICE_ENTRY['veneer-pro']), 'tampered'), /EACCES|EPERM/);
  assert.ok(fs.lstatSync(path.join(release.dir, 'node_modules')).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(path.join(release.dir, 'release.json'), 'utf8')).package_lock_sha256.length, 64);
  assert.equal(snapshotRelease({ appRoot: app, dataDir: data }).reused, true);
});

test('activation needs the approved window, records the previous release and is logged', (t) => {
  const { app, data } = fixture(t);
  const first = snapshotRelease({ appRoot: app, dataDir: data });
  assert.throws(() => activateRelease({ dataDir: data, id: first.id, services: ['veneer-pro'] }), /maintenance-approved/);
  assert.equal(activeRelease(data, 'veneer-pro'), null);
  activateRelease({ dataDir: data, id: first.id, services: ['veneer-pro'], maintenanceApproved: true });
  build(app, 'B');
  const second = snapshotRelease({ appRoot: app, dataDir: data });
  assert.notEqual(second.id, first.id);
  const [change] = activateRelease({ dataDir: data, id: second.id, services: ['veneer-pro'], maintenanceApproved: true });
  assert.deepEqual([change.from, change.to, change.changed], [first.id, second.id, true]);
  assert.equal(activeRelease(data, 'veneer-pro'), second.id);
  assert.equal(previousRelease(data, 'veneer-pro'), first.id);
  // Only the named service moved.
  assert.equal(activeRelease(data, 'veneer-pro-runner'), null);
  const log = fs.readFileSync(path.join(data, 'releases', 'activations.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((e) => e.to), [first.id, second.id]);
  assert.throws(() => activateRelease({ dataDir: data, id: second.id, services: ['veneer-browser-manager'], maintenanceApproved: true }), /no release entry/);
});

test('a respawn after npm run build still loads the activated bytes', (t) => {
  const { app, data } = fixture(t);
  const release = snapshotRelease({ appRoot: app, dataDir: data });
  activateRelease({ dataDir: data, id: release.id, services: RELEASE_SERVICES, maintenanceApproved: true });
  for (const service of RELEASE_SERVICES) {
    const [marker, where] = run(activeEntry(data, service));
    assert.equal(marker, 'A');
    // Node runs the real path behind the pointer, so a pointer move never
    // changes the bytes of a process that is already running.
    assert.ok(fs.realpathSync(where).startsWith(fs.realpathSync(release.dir)), where);
  }
  build(app, 'B'); // the rebuild-in-place that deployed 155b497 on 2026-10-13
  assert.equal(run(path.join(app, SERVICE_ENTRY['veneer-pro']))[0], 'B');
  for (const service of RELEASE_SERVICES) assert.equal(run(activeEntry(data, service))[0], 'A');
  verifyRelease(data, release.id);
});

test('verification catches a changed release and plists never point at one', (t) => {
  const { app, data } = fixture(t);
  let roots = plistRoots({ dataDir: data, codeDir: app });
  for (const service of RELEASE_SERVICES) assert.equal(roots.roots[service], app);
  assert.equal(roots.warnings.length, RELEASE_SERVICES.length);
  assert.match(roots.warnings[0], /checkout build in place/);
  const release = snapshotRelease({ appRoot: app, dataDir: data });
  activateRelease({ dataDir: data, id: release.id, services: RELEASE_SERVICES, maintenanceApproved: true });
  roots = plistRoots({ dataDir: data, codeDir: app });
  assert.equal(roots.roots['veneer-pro'], activeLink(data, 'veneer-pro'));
  assert.equal(roots.roots['web-watchdog'], activeLink(data, 'veneer-pro'));
  assert.deepEqual(roots.warnings, []);
  const entry = path.join(release.dir, SERVICE_ENTRY['veneer-pro-term']);
  fs.chmodSync(path.dirname(entry), 0o755); fs.chmodSync(entry, 0o644);
  fs.writeFileSync(entry, 'changed');
  assert.throws(() => verifyRelease(data, release.id), /changed on disk/);
  roots = plistRoots({ dataDir: data, codeDir: app });
  assert.equal(roots.roots['veneer-pro-term'], app);
  assert.match(roots.warnings.join('\n'), /veneer-pro-term: active release .* failed verification/);
  assert.throws(() => activateRelease({ dataDir: data, id: release.id, services: ['veneer-pro-term'], maintenanceApproved: true }), /changed on disk/);
});

test('service plists launch through the release root token and the watchdog follows web', (t) => {
  const { app, data } = fixture(t);
  for (const plist of ['com.veneer.pro', 'com.veneer.pro.runner', 'com.veneer.pro.app-runner', 'com.veneer.pro.term', 'com.veneer.web-watchdog']) {
    const xml = fs.readFileSync(path.join(repo, 'deploy', 'launchd', `${plist}.plist`), 'utf8');
    assert.match(xml, /__SERVICE_ROOT__\/server\/dist\//, plist);
    assert.doesNotMatch(xml, /__CODE_DIR__\/server\/dist\//, plist);
  }
  const before = renderWatchdog({ node: '/node24', codeDir: app, dataDir: data, port: 3100, logDir: '/logs', serviceHome: '/service' });
  assert.ok(before.includes(`${app}/server/dist/ops/webWatchdogMain.js`));
  const release = snapshotRelease({ appRoot: app, dataDir: data });
  activateRelease({ dataDir: data, id: release.id, services: ['veneer-pro'], maintenanceApproved: true });
  const after = renderWatchdog({ node: '/node24', codeDir: app, dataDir: data, port: 3100, logDir: '/logs', serviceHome: '/service' });
  assert.ok(after.includes(`${activeLink(data, 'veneer-pro')}/server/dist/ops/webWatchdogMain.js`));
});

test('only an approved restart or approved install moves a pointer', () => {
  const restart = fs.readFileSync(path.join(repo, 'scripts', 'restart.mjs'), 'utf8');
  const body = restart.slice(restart.indexOf('async function restart(service)'));
  // Activation sits after this service's own safety recheck and before it is signalled.
  assert.ok(body.indexOf('assertRunnerRestartSafe') < body.indexOf('activateRelease('));
  assert.ok(body.indexOf('activateRelease(') < body.indexOf('const oldPid = livePid(service)'));
  const installer = fs.readFileSync(path.join(repo, 'installer', 'install-darwin.mjs'), 'utf8');
  assert.match(installer, /--activate-release deploys the current build[\s\S]*requires --maintenance-approved/);
  const cli = fs.readFileSync(path.join(repo, 'scripts', 'releases.mjs'), 'utf8');
  const main = cli.slice(cli.indexOf('if (process.argv[1]'));
  assert.doesNotMatch(main, /activateRelease\(/);
  for (const file of ['scripts/restart.mjs', 'installer/install-darwin.mjs'])
    assert.ok(fs.readFileSync(path.join(repo, file), 'utf8').includes('activateRelease('), file);
});
