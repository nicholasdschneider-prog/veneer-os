import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'veneer-volume');

test('ensure-mounted.py retry logic passes its Python unit tests', { skip: process.platform !== 'darwin' }, () => {
  const run = spawnSync('/usr/bin/python3', ['-I', path.join(dir, 'test_ensure_mounted.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
