import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, runSweep, scanDir, selectCandidates } from './disk-sweep.mjs';

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 10, 17, 12);
const config = { roots: [{ source: '/src', target: '/Volumes/X/out' }], minBytes: 100, ageHours: 48, skipNames: ['state'] };

// Fake tree: dir path -> { dirs: [...names], scan: {files, bytes, newest} }
function fakeFs(tree) {
  return {
    listDirs: (dir) => tree[dir]?.dirs ?? [],
    scanDir: (dir) => tree[dir].scan,
  };
}
const old = NOW - 72 * HOUR;
const fresh = NOW - 1 * HOUR;

test('selection: stale top level, active top level with stale child, skipNames, small and symlinked folders', () => {
  const tree = {
    '/src': { dirs: ['stale', 'active', 'small', 'leftover.relocating'] },
    '/src/stale': { dirs: ['inner'], scan: { files: 3, bytes: 500, newest: old } },
    '/src/active': { dirs: ['oldchild', 'state', 'newchild', 'tinychild'], scan: { files: 9, bytes: 900, newest: fresh } },
    '/src/active/oldchild': { scan: { files: 2, bytes: 200, newest: old } },
    '/src/active/state': { scan: { files: 2, bytes: 200, newest: old } },
    '/src/active/newchild': { scan: { files: 2, bytes: 200, newest: fresh } },
    '/src/active/tinychild': { scan: { files: 1, bytes: 10, newest: old } },
    '/src/small': { scan: { files: 1, bytes: 50, newest: old } },
  };
  const picked = selectCandidates(config, NOW, fakeFs(tree)).map((c) => c.path);
  assert.deepEqual(picked, ['/src/stale', '/src/active/oldchild']);
});

test('real listing ignores symlinked folders and scan does not follow links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sweep-scan-'));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'real'), { recursive: true });
    fs.writeFileSync(path.join(src, 'real', 'a.bin'), Buffer.alloc(300));
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.writeFileSync(path.join(root, 'elsewhere', 'big.bin'), Buffer.alloc(5000));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(src, 'linked'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(src, 'real', 'inner-link'));
    const past = new Date(NOW - 72 * HOUR);
    fs.utimesSync(path.join(src, 'real', 'a.bin'), past, past);
    fs.lutimesSync(path.join(src, 'real', 'inner-link'), past, past);
    fs.utimesSync(path.join(src, 'real'), past, past);
    const scan = scanDir(path.join(src, 'real'));
    assert.equal(scan.files, 2);
    assert.ok(scan.bytes < 1000);
    const picked = selectCandidates({ ...config, roots: [{ source: src, target: '/Volumes/X/out' }] }, NOW).map((c) => path.basename(c.path));
    assert.deepEqual(picked, ['real']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply refuses everything when the target volume is not mounted', () => {
  assert.throws(() => runSweep({ apply: true, config, isMounted: () => false, log: () => {}, fsx: fakeFs({}) }), /not mounted/);
});

test('apply moves a stale folder, leaves a symlink, logs, and skips busy and existing targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sweep-apply-'));
  try {
    const src = path.join(root, 'src');
    const dst = path.join(root, 'dst');
    for (const name of ['move', 'busy', 'exists']) {
      fs.mkdirSync(path.join(src, name, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(src, name, 'sub', 'f.bin'), Buffer.alloc(400));
    }
    fs.mkdirSync(path.join(dst, 'exists'), { recursive: true });
    const past = new Date(NOW - 72 * HOUR);
    for (const name of ['move', 'busy', 'exists']) {
      for (const p of [path.join(src, name, 'sub', 'f.bin'), path.join(src, name, 'sub'), path.join(src, name)]) fs.utimesSync(p, past, past);
    }
    const logFile = path.join(root, 'sweep-log.jsonl');
    const lines = [];
    const run = (command, args) => {
      if (command.endsWith('lsof')) return { status: 0, stdout: args[1].endsWith('busy') ? 'node 123 x\n' : '' };
      const result = spawnSync(command, args, { encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout };
    };
    const result = runSweep({
      apply: true, now: NOW, run, isMounted: () => true, logFile, log: (line) => lines.push(line),
      config: { ...config, roots: [{ source: src, target: dst }] },
    });
    assert.deepEqual({ ...result, bytes: undefined }, { moved: 1, bytes: undefined, busy: 1, failed: 1 });
    assert.equal(fs.lstatSync(path.join(src, 'move')).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(src, 'move')), path.join(dst, 'move'));
    assert.equal(fs.readFileSync(path.join(src, 'move', 'sub', 'f.bin')).length, 400);
    assert.equal(fs.existsSync(path.join(src, 'move.relocating')), false);
    assert.equal(fs.lstatSync(path.join(src, 'busy')).isDirectory(), true);
    assert.equal(fs.lstatSync(path.join(src, 'exists')).isDirectory(), true);
    const logged = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(logged.length, 1);
    assert.equal(logged[0].files, 1);
    assert.match(lines.at(-1), /^TOTAL .* in 1 folders, 1 skipped busy, 1 failed$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed copy leaves the source in place and the run continues', () => {
  const tree = {
    '/src': { dirs: ['a', 'b'] },
    '/src/a': { dirs: [], scan: { files: 1, bytes: 500, newest: old } },
    '/src/b': { dirs: [], scan: { files: 1, bytes: 500, newest: old } },
  };
  const calls = [];
  const run = (command, args) => { calls.push([command, ...args]); return command.endsWith('lsof') ? { status: 1, stdout: '' } : { status: 23, stdout: '' }; };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sweep-fail-'));
  try {
    const result = runSweep({
      apply: true, now: NOW, run, isMounted: () => true, fsx: fakeFs(tree), log: () => {},
      config: { ...config, roots: [{ source: '/src', target: path.join(root, 'dst') }] }, logFile: path.join(root, 'log'),
    });
    assert.deepEqual(result, { moved: 0, bytes: 0, busy: 0, failed: 2 });
    assert.equal(calls.filter((c) => c[0].endsWith('rsync')).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing config file falls back to defaults; bad config is rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sweep-config-'));
  try {
    assert.equal(loadConfig(path.join(root, 'none.json')).ageHours, 48);
    fs.writeFileSync(path.join(root, 'bad.json'), JSON.stringify({ roots: [{ source: 'relative', target: '/x' }] }));
    assert.throws(() => loadConfig(path.join(root, 'bad.json')), /absolute/);
    fs.writeFileSync(path.join(root, 'ok.json'), JSON.stringify({ roots: [{ source: '/a', target: '/Volumes/V/b' }], ageHours: 24 }));
    assert.deepEqual(loadConfig(path.join(root, 'ok.json')).skipNames, ['state']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
