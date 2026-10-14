import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { armActivation, casArm, readArm, renderActivationPlist, runArmedActivation } from './activation-job.mjs';
import { createReceipt } from './backup-receipt.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const serverPackage = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'server', 'package.json');
const Database = createRequire(serverPackage)('better-sqlite3');
import { activateRelease, snapshotRelease, SERVICE_ENTRY } from '../scripts/releases.mjs';
import { execFileSync } from 'node:child_process';

const JOBS = ['com.veneer.pro', 'com.veneer.web-watchdog', 'com.veneer.pro.app-runner', 'com.veneer.pro.term', 'com.veneer.pro.runner'];

// Each setup anchors the clock 1 s after its own fresh backup.
let T0 = 0;
const iso = (ms) => new Date(ms).toISOString();

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
  // A real verified backup and receipt, taken "now".
  const backup = path.join(root, 'backup.db');
  const db = new Database(backup); db.exec('create table t(x)'); db.close();
  const receipt = `${backup}.receipt.json`;
  const made = createReceipt(backup);
  fs.writeFileSync(receipt, JSON.stringify(made));
  T0 = Date.parse(made.taken_at) + 1000;
  let fingerprint = 'source-1';
  const binding = ({ releaseId }) => {
    const meta = JSON.parse(fs.readFileSync(path.join(data, 'releases', releaseId, 'release.json'), 'utf8'));
    return { release_manifest: meta.manifest_sha256, dist_manifest: meta.manifest_sha256, source_fingerprint: fingerprint };
  };
  const arm = (extra = {}) => armActivation({
    dataDir: data, codeDir: app, approvalRef: 'Nick 2026-10-14 own words, msg 123', releaseId: release.id, sourceSha: 'abc1234', jobs: JOBS,
    deadline: iso(T0 + 3 * 3600_000), maintenanceApproved: true, now: new Date(T0), binding, matches: () => true, bootstrap: () => {},
    backupReceipt: receipt, ...extra,
  });
  return { data, app, release, arm, binding, backup, receipt, setFingerprint: (v) => { fingerprint = v; } };
}

function clock(start, stepMs) {
  let t = start;
  return { now: () => new Date(t), sleep: async (ms) => { t += ms ?? stepMs; }, advance: (ms) => { t += ms; } };
}

const quiet = { readPending: () => 0, readOccupancy: async () => ({ installed: false }), log: () => {} };

test('arming needs the approval flag, a reference and a fresh verified backup, and refuses a second different arm', (t) => {
  const { arm, data } = setup(t);
  assert.throws(() => arm({ maintenanceApproved: false }), /needs --maintenance-approved/);
  assert.throws(() => arm({ approvalRef: ' ' }), /--approval-ref/);
  assert.throws(() => arm({ deadline: iso(T0 - 1000) }), /deadline/);
  assert.throws(() => arm({ jobs: ['com.veneer.chrome'] }), /release jobs/);
  assert.throws(() => arm({ backupReceipt: '/nowhere/receipt.json' }), /refused_stale_backup.*missing/);
  assert.throws(() => arm({ now: new Date(T0 + 16 * 60_000), deadline: iso(T0 + 3 * 3600_000) }), /refused_stale_backup.*min old/);
  assert.equal(readArm(data), null);
  const first = arm();
  assert.equal(first.state, 'armed');
  assert.equal(first.backup.backup_sha256.length, 64);
  assert.equal(arm().arm_id, first.arm_id);
  assert.equal(arm().reused, true);
  assert.throws(() => arm({ deadline: iso(T0 + 2 * 3600_000) }), /another activation is armed/);
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
  let installs = 0;
  const code = await runArmedActivation({ dataDir: data, codeDir: app, ...clock(T0 + 3 * 3600_000 - 10_000, 2000), binding, ...quiet, readPending: () => 1, runInstaller: () => { installs += 1; return 0; } });
  assert.equal(code, 1);
  assert.equal(installs, 0);
  assert.equal(readArm(data).state, 'refused_deadline');
});

test('it acts only after N consecutive quiet reads, exactly once, with the window and backup bound', async (t) => {
  const { arm, data, app, binding, receipt } = setup(t);
  arm();
  const pending = [1, 1, 0, 0, 0, 0, 0, 0, 0];
  const browsers = [0, 0, 0, 1, 0, 0, 0, 0, 0];
  let reads = 0;
  const installed = [];
  const code = await runArmedActivation({
    dataDir: data, codeDir: app, ...clock(T0 + 60_000, 2000), binding,
    readPending: () => pending[reads],
    readOccupancy: async () => ({ installed: true, active: browsers[reads++], waiting: 0 }),
    runInstaller: (args) => { installed.push(args); assert.equal(readArm(data).state, 'running'); return 0; },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.equal(reads, 9);
  assert.equal(installed.length, 1);
  const a = readArm(data);
  assert.deepEqual(installed[0], ['--activate-release', '--release-services-only', '--maintenance-approved', '--release', a.release_id, '--source-sha', 'abc1234', '--expect-manifest', a.binding.release_manifest,
    '--expect-jobs', JOBS.join(','), '--deadline', a.deadline, '--backup-receipt', path.resolve(receipt)]);
  assert.doesNotMatch(installed[0].join(' '), /allow-active-turns/);
  assert.equal(a.state, 'completed');
  assert.equal(await runArmedActivation({ dataDir: data, codeDir: app, ...clock(T0, 2000), binding, ...quiet, runInstaller: () => { throw new Error('must not run'); } }), 0);
});

// Everything that lands during the LAST read before the commit must win.
for (const [name, during, state, code] of [
  ['the deadline crossing', (s, c) => c.advance(3 * 3600_000), 'refused_deadline', 1],
  ['a disarm', (s) => casArm(s.data, { armId: readArm(s.data).arm_id, state: 'armed' }, (a) => ({ ...a, state: 'disarmed' })), 'disarmed', 0],
  ['a binding change', (s) => s.setFingerprint('source-2'), 'refused_changed', 1],
  ['the backup going stale', (s, c) => c.advance(16 * 60_000), 'refused_stale_backup', 1],
  ['the backup file changing', (s) => fs.appendFileSync(s.backup, 'x'), 'refused_stale_backup', 1],
]) {
  test(`${name} during the last read stops the commit; nothing is activated`, async (t) => {
    const s = setup(t);
    s.arm();
    const c = clock(T0 + 1000, 1);
    let reads = 0;
    let installs = 0;
    const result = await runArmedActivation({
      dataDir: s.data, codeDir: s.app, ...c, binding: s.binding, readPending: () => 0, log: () => {},
      readOccupancy: async () => { if (++reads === 5) during(s, c); return { installed: false }; },
      runInstaller: () => { installs += 1; return 0; },
    });
    assert.equal(installs, 0);
    assert.equal(readArm(s.data).state, state);
    assert.equal(result, code);
  });
}

test('the running commit is a compare-and-set that a disarm at the last moment wins', async (t) => {
  const s = setup(t);
  s.arm();
  let installs = 0;
  const result = await runArmedActivation({
    dataDir: s.data, codeDir: s.app, ...clock(T0 + 1000, 1), binding: s.binding, ...quiet,
    beforeCommit: () => { casArm(s.data, { armId: readArm(s.data).arm_id, state: 'armed' }, (a) => ({ ...a, state: 'disarmed' })); },
    runInstaller: () => { installs += 1; return 0; },
  });
  assert.equal(result, 0);
  assert.equal(installs, 0);
  assert.equal(readArm(s.data).state, 'disarmed');
  // A held lock makes a concurrent writer lose loudly rather than wait.
  fs.mkdirSync(path.join(s.data, 'releases', 'arm', 'arm.lock'));
  fs.writeFileSync(path.join(s.data, 'releases', 'arm', 'arm.lock', 'pid'), String(process.pid));
  assert.throws(() => casArm(s.data, { armId: readArm(s.data).arm_id, state: 'disarmed' }, (a) => a), /locked by pid/);
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
    const code = await runArmedActivation({ dataDir: s.data, codeDir: s.app, ...clock(T0 + 1000, 2000), binding: s.binding, ...quiet, runInstaller: () => { installs += 1; return 0; } });
    assert.equal(code, 1, what);
    assert.equal(installs, 0, what);
    assert.equal(readArm(s.data).state, 'refused_changed', what);
  }
});

test('an installer refusal after the start is recorded and never retried', async (t) => {
  const { arm, data, app, binding } = setup(t);
  arm();
  let installs = 0;
  const code = await runArmedActivation({ dataDir: data, codeDir: app, ...clock(T0 + 1000, 2000), binding, ...quiet, runInstaller: () => { installs += 1; return 1; } });
  assert.equal(code, 1);
  assert.equal(installs, 1);
  assert.equal(readArm(data).state, 'failed');
  assert.equal(readArm(data).exit_code, 1);
});

test('the activation job is a one-shot launchd job', () => {
  const xml = renderActivationPlist({ nodeBin: '/node', scriptPath: '/code/installer/activation-job.mjs', armPath: '/data/arm.json', logPath: '/logs/a.log', codeDir: '/code', home: '/Users/x' });
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(xml, /KeepAlive/);
  assert.match(xml, /<string>run<\/string><string>--arm<\/string><string>\/data\/arm.json<\/string>/);
  void activateRelease;
});
