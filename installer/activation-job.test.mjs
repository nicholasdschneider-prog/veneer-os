import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { armActivation, armFile, readArm, renderActivationPlist, runArmedActivation } from './activation-job.mjs';
import { activateRelease, snapshotRelease, SERVICE_ENTRY } from '../scripts/releases.mjs';
import { execFileSync } from 'node:child_process';

const JOBS = ['com.veneer.pro', 'com.veneer.web-watchdog', 'com.veneer.pro.app-runner', 'com.veneer.pro.term', 'com.veneer.pro.runner'];

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-job-'));
  t.after(() => { execFileSync('chmod', ['-R', 'u+w', root]); fs.rmSync(root, { recursive: true, force: true }); });
  const app = path.join(root, 'app');
  for (const entry of Object.values(SERVICE_ENTRY)) { fs.mkdirSync(path.dirname(path.join(app, entry)), { recursive: true }); fs.writeFileSync(path.join(app, entry), '// A\n'); }
  fs.mkdirSync(path.join(app, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(app, 'web', 'dist', 'index.html'), 'A');
  const data = path.join(root, 'data');
  const release = snapshotRelease({ appRoot: app, dataDir: data });
  // The fixture is not a git checkout; give its release the source identity a real one records.
  const metaFile = path.join(release.dir, 'release.json');
  fs.chmodSync(release.dir, 0o755); fs.chmodSync(metaFile, 0o644);
  fs.writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaFile, 'utf8')), git_sha: 'abc1234def5678', git_dirty: false }));
  fs.chmodSync(metaFile, 0o444); fs.chmodSync(release.dir, 0o555);
  let fingerprint = 'source-1';
  const binding = ({ releaseId }) => {
    const meta = JSON.parse(fs.readFileSync(path.join(data, 'releases', releaseId, 'release.json'), 'utf8'));
    return { release_manifest: meta.manifest_sha256, dist_manifest: meta.manifest_sha256, source_fingerprint: fingerprint };
  };
  const now = new Date('2026-10-14T02:00:00Z');
  const arm = (extra = {}) => armActivation({
    dataDir: data, codeDir: app, approvalRef: 'Nick 2026-10-14 own words, msg 123', releaseId: release.id, sourceSha: 'abc1234', jobs: JOBS,
    deadline: '2026-10-14T05:00:00Z', maintenanceApproved: true, now, binding, matches: () => true, bootstrap: () => {}, ...extra,
  });
  return { data, app, release, arm, binding, setFingerprint: (v) => { fingerprint = v; } };
}

function clock(start, stepMs) {
  let t = Date.parse(start);
  return { now: () => new Date(t), sleep: async (ms) => { t += ms ?? stepMs; } };
}

test('arming needs the approval flag and a reference, and refuses a second different arm', (t) => {
  const { arm, data } = setup(t);
  assert.throws(() => arm({ maintenanceApproved: false }), /needs --maintenance-approved/);
  assert.throws(() => arm({ approvalRef: ' ' }), /--approval-ref/);
  assert.throws(() => arm({ deadline: '2026-10-14T01:00:00Z' }), /deadline/);
  assert.throws(() => arm({ jobs: ['com.veneer.chrome'] }), /release jobs/);
  const first = arm();
  assert.equal(first.state, 'armed');
  // Arming is idempotent for the identical request ...
  assert.equal(arm().arm_id, first.arm_id);
  assert.equal(arm().reused, true);
  // ... and refuses anything else while one is live.
  assert.throws(() => arm({ deadline: '2026-10-14T04:00:00Z' }), /another activation is armed/);
  assert.equal(readArm(data).arm_id, first.arm_id);
});

test('arming refuses a release not built from the named clean source, or a changed checkout', (t) => {
  const { arm } = setup(t);
  assert.throws(() => arm({ sourceSha: 'fff0000' }), /not built from a clean fff0000/);
  assert.throws(() => arm({ matches: () => false }), /shipped source differs/);
  assert.throws(() => arm({ binding: () => ({ release_manifest: 'a', dist_manifest: 'b', source_fingerprint: 'x' }) }), /checkout dist is not the build/);
  assert.throws(() => arm({ bootstrap: () => { throw new Error('launchctl refused'); } }), /Arming failed; nothing will run/);
});

test('at the deadline the job exits without acting', async (t) => {
  const { arm, data, app, binding } = setup(t);
  arm();
  const c = clock('2026-10-14T04:59:50Z', 2000);
  let installs = 0;
  const code = await runArmedActivation({ dataDir: data, codeDir: app, ...c, binding, readPending: () => 1, readOccupancy: async () => ({ installed: false }), runInstaller: () => { installs += 1; return 0; }, log: () => {} });
  assert.equal(code, 1);
  assert.equal(installs, 0);
  assert.equal(readArm(data).state, 'refused_deadline');
  assert.match(readArm(data).detail, /nothing was activated/);
});

test('it acts only after N consecutive zero-pending, idle reads, exactly once', async (t) => {
  const { arm, data, app, binding } = setup(t);
  arm();
  const c = clock('2026-10-14T02:00:00Z', 2000);
  // The arming turn is still pending at first, then a browser is busy once, then quiet.
  const pending = [1, 1, 0, 0, 0, 0, 0, 0, 0];
  const browsers = [0, 0, 0, 1, 0, 0, 0, 0, 0];
  let reads = 0;
  const installed = [];
  const code = await runArmedActivation({
    dataDir: data, codeDir: app, ...c, binding,
    readPending: () => pending[reads],
    readOccupancy: async () => ({ installed: true, active: browsers[reads++], waiting: 0 }),
    runInstaller: (args) => { installed.push(args); assert.equal(readArm(data).state, 'running'); return 0; },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.equal(reads, 9); // 2 pending + reset by a busy browser + 5 consecutive quiet reads
  assert.equal(installed.length, 1);
  assert.deepEqual(installed[0], ['--activate-release', '--release-services-only', '--maintenance-approved', '--release', readArm(data).release_id, '--expect-jobs', JOBS.join(',')]);
  assert.doesNotMatch(installed[0].join(' '), /allow-active-turns/);
  assert.equal(readArm(data).state, 'completed');
  // A relaunch finds nothing armed and does nothing.
  assert.equal(await runArmedActivation({ dataDir: data, codeDir: app, ...c, binding, readPending: () => 0, readOccupancy: async () => ({ installed: false }), runInstaller: () => { throw new Error('must not run'); }, log: () => {} }), 0);
});

test('a source, dist or release change since arming refuses without acting', async (t) => {
  for (const [what, mutate] of [
    ['source', (s) => s.setFingerprint('source-2')],
    ['dist', (s) => { s.binding = (args) => ({ ...s.binding0(args), dist_manifest: 'rebuilt' }); }],
    ['release', (s) => { s.binding = () => { throw new Error('release changed on disk'); }; }],
  ]) {
    const s = setup(t);
    s.binding0 = s.binding;
    s.arm();
    mutate(s);
    let installs = 0;
    const code = await runArmedActivation({ dataDir: s.data, codeDir: s.app, ...clock('2026-10-14T02:00:00Z', 2000), binding: s.binding, readPending: () => 0, readOccupancy: async () => ({ installed: false }), runInstaller: () => { installs += 1; return 0; }, log: () => {} });
    assert.equal(code, 1, what);
    assert.equal(installs, 0, what);
    assert.equal(readArm(s.data).state, 'refused_changed', what);
  }
});

test('an installer refusal after the start is recorded and never retried', async (t) => {
  const { arm, data, app, binding } = setup(t);
  arm();
  let installs = 0;
  const code = await runArmedActivation({ dataDir: data, codeDir: app, ...clock('2026-10-14T02:00:00Z', 2000), binding, readPending: () => 0, readOccupancy: async () => ({ installed: false }), runInstaller: () => { installs += 1; return 1; }, log: () => {} });
  assert.equal(code, 1);
  assert.equal(installs, 1);
  assert.equal(readArm(data).state, 'failed');
  assert.equal(readArm(data).exit_code, 1);
  assert.ok(fs.statSync(armFile(data)).mode & 0o600);
});

test('the activation job is a one-shot launchd job', () => {
  const xml = renderActivationPlist({ nodeBin: '/node', scriptPath: '/code/installer/activation-job.mjs', armPath: '/data/arm.json', logPath: '/logs/a.log', codeDir: '/code', home: '/Users/x' });
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(xml, /KeepAlive/);
  assert.match(xml, /<string>run<\/string><string>--arm<\/string><string>\/data\/arm.json<\/string>/);
  void activateRelease;
});
