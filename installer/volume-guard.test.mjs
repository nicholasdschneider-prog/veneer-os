import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveVolumeGuard } from './volume-guard.mjs';
test('preserves the mount guard while adopting updated service arguments', () => {
  const fresh = '<dict><key>ProgramArguments</key><array><string>/new/node</string><string>/new/server.js</string></array></dict>';
  const old = '<dict><key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>/Users/test/.local/lib/veneer-volume/ensure-mounted.py</string><string>--exec</string><string>/old/node</string><string>/old/server.js</string></array><key>VeneerOriginalProgramArguments</key><array><string>/old/node</string></array></dict>';
  assert.equal(preserveVolumeGuard(fresh, null), fresh);
  const result = preserveVolumeGuard(fresh, old);
  assert.match(result, /ensure-mounted\.py/);
  assert.equal((result.match(/\/new\/server\.js/g) || []).length, 2);
  assert.doesNotMatch(result, /\/old\//);
  assert.throws(() => preserveVolumeGuard(fresh, old.replace('ensure-mounted.py','unexpected.py')), /refusing/);
});
