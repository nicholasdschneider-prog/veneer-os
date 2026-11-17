import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { offsiteToRemove, pickNewestArchive, readState, runOffsite, statusSummary } from './backup-offsite.mjs';

const objectFor = (date) => `veneer-pro-${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.tar.gz.age`;
const days = (count) => Array.from({ length: count }, (_, i) => objectFor(new Date(Date.UTC(2026, 9, 1 + i, 8, 20, 10))));

test('retention keeps everything when there are seven or fewer objects', () => {
  assert.deepEqual(offsiteToRemove(days(3)), []);
  assert.deepEqual(offsiteToRemove(days(7)), []);
});

test('retention over 30 consecutive days keeps 7 daily plus the newest of 4 older ISO weeks', () => {
  const all = days(30); // 2026-10-01 .. 2026-10-30
  const removed = offsiteToRemove(all);
  const kept = all.filter((name) => !removed.includes(name));
  assert.equal(kept.length, 11);
  // Daily: Oct 24..30. Weekly (newest of each older ISO week): Oct 23 (W43), Oct 18 (W42), Oct 11 (W41), Oct 4 (W40).
  for (const day of [24, 25, 26, 27, 28, 29, 30, 23, 18, 11, 4]) {
    assert.ok(kept.includes(objectFor(new Date(Date.UTC(2026, 9, day, 8, 20, 10)))), `Oct ${day} kept`);
  }
});

test('retention never removes unrelated object names', () => {
  const unrelated = ['notes.txt', 'veneer-pro-20261001T082010Z.tar.gz', 'other/veneer-pro-20261001T082010Z.tar.gz.age'];
  const removed = offsiteToRemove([...days(30), ...unrelated]);
  for (const name of unrelated) assert.equal(removed.includes(name), false);
  assert.equal(removed.length, 19);
});

test('newest archive is picked by name and ignores files still being written', () => {
  const now = Date.UTC(2026, 10, 17, 9);
  const entries = [
    { name: 'veneer-pro-20261115T082007Z.tar.gz', mtimeMs: now - 3600e3 },
    { name: 'veneer-pro-20261116T082007Z.tar.gz', mtimeMs: now - 3600e3 },
    { name: 'veneer-pro-20261117T082007Z.tar.gz', mtimeMs: now - 30e3 },
    { name: 'offsite-state.json', mtimeMs: now - 3600e3 },
    { name: 'veneer-pro-20261199T999999Z.tar.gz.partial', mtimeMs: 0 },
  ];
  assert.equal(pickNewestArchive(entries, now), 'veneer-pro-20261116T082007Z.tar.gz');
  assert.equal(pickNewestArchive([], now), null);
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-offsite-test-'));
  const archive = 'veneer-pro-20261116T082007Z.tar.gz';
  fs.writeFileSync(path.join(dir, archive), 'data');
  const old = new Date(Date.now() - 3600e3);
  fs.utimesSync(path.join(dir, archive), old, old);
  const env = {
    VP_BACKUP_DIR: dir,
    VP_BACKUP_OFFSITE_ACCOUNT_ID: 'acct',
    VP_BACKUP_OFFSITE_ACCESS_KEY_ID: 'AKIDSECRET',
    VP_BACKUP_OFFSITE_SECRET_ACCESS_KEY: 'SUPERSECRET',
    VP_BACKUP_OFFSITE_AGE_RECIPIENT: 'age1example',
  };
  return { dir, archive, env };
}

function fakeCommands({ remoteObjects = [], sizeDelta = 0, uploadError = null } = {}) {
  const calls = [];
  return {
    calls,
    upload: async (file, remote) => {
      calls.push(['upload', remote]);
      if (uploadError) throw new Error(uploadError);
      return { bytes: 100, sha256: 'abc' };
    },
    lsjson: async (remote) => {
      calls.push(['lsjson', remote]);
      if (remote.endsWith('.age')) return [{ Name: path.basename(remote), Size: 100 + sizeDelta }];
      return remoteObjects.map((Name) => ({ Name, Size: 1 }));
    },
    deleteFile: async (remote) => { calls.push(['delete', remote]); },
  };
}

test('upload verifies size, writes state, applies retention, then skips the same archive', async () => {
  const { dir, archive, env } = fixture();
  try {
    const commands = fakeCommands({ remoteObjects: [...days(30), `${archive}.age`] });
    const first = await runOffsite({ env, commands, log: () => {} });
    assert.equal(first.status, 'uploaded');
    const state = readState(path.join(dir, 'offsite-state.json'));
    assert.equal(state.lastUploaded.name, archive);
    assert.equal(state.lastUploaded.bytes, 100);
    assert.equal(state.lastError, null);
    assert.equal((fs.statSync(path.join(dir, 'offsite-state.json')).mode & 0o777), 0o600);
    assert.equal(commands.calls.filter((c) => c[0] === 'delete').length, 20);
    assert.equal(commands.calls.some((c) => c[0] === 'delete' && c[1].endsWith(`${archive}.age`)), false);
    const again = fakeCommands();
    assert.equal((await runOffsite({ env, commands: again, log: () => {} })).status, 'skipped');
    assert.deepEqual(again.calls, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a size mismatch or upload failure records lastError without secrets and keeps lastUploaded', async () => {
  const { dir, env } = fixture();
  try {
    const statePath = path.join(dir, 'offsite-state.json');
    fs.writeFileSync(statePath, JSON.stringify({ lastUploaded: { name: 'older', at: 'x' }, lastError: null, history: [] }));
    const mismatch = await runOffsite({ env, commands: fakeCommands({ sizeDelta: 1 }), log: () => {} });
    assert.equal(mismatch.status, 'error');
    assert.match(readState(statePath).lastError.message, /verify failed/);
    const lines = [];
    await runOffsite({ env, commands: fakeCommands({ uploadError: 'denied for SUPERSECRET AKIDSECRET' }), log: (l) => lines.push(l) });
    const state = readState(statePath);
    assert.equal(state.lastUploaded.name, 'older');
    assert.doesNotMatch(fs.readFileSync(statePath, 'utf8') + lines.join('\n'), /SUPERSECRET|AKIDSECRET/);
    assert.equal(state.history.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing configuration names the missing keys, records the error and makes no calls', async () => {
  const { dir, env } = fixture();
  try {
    delete env.VP_BACKUP_OFFSITE_SECRET_ACCESS_KEY;
    delete env.VP_BACKUP_OFFSITE_AGE_RECIPIENT;
    const commands = fakeCommands();
    const lines = [];
    const result = await runOffsite({ env, commands, log: (l) => lines.push(l) });
    assert.equal(result.status, 'not_configured');
    assert.match(lines[0], /missing VP_BACKUP_OFFSITE_SECRET_ACCESS_KEY, VP_BACKUP_OFFSITE_AGE_RECIPIENT/);
    assert.deepEqual(commands.calls, []);
    const summary = statusSummary(readState(path.join(dir, 'offsite-state.json')));
    assert.equal(summary.name, null);
    assert.match(summary.lastError.message, /not configured/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
