import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDevelopmentCommand } from '../scripts/development-lock.mjs';

test('refuses overlapping validation and releases the shared lock after a failed command', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-development-test-'));
  const lock = path.join(root, 'lock');
  try {
    const first = runDevelopmentCommand(process.execPath, ['-e', 'setTimeout(()=>process.exit(7),150)'], lock);
    await assert.rejects(runDevelopmentCommand(process.execPath, ['-e', 'process.exit(0)'], lock), /Another development job/);
    assert.equal(await first, 7);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(await runDevelopmentCommand(process.execPath, ['-e', 'process.exit(0)'], lock), 0);
    await assert.rejects(runDevelopmentCommand('/nonexistent-veneer-test-command', [], lock));
    assert.equal(fs.existsSync(lock), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
