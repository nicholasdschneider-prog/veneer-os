import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePs, selectOrphanHelpers } from './helper-reaper.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HANDLER = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/156.0.8078.80/Helpers/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler --database=/x';
const LAUNCHER = '/Users/u/Library/Application Support/Google/GoogleUpdater/Current/GoogleUpdater.app/Contents/Helpers/launcher';
const TESTING = '/Users/u/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/149.0/Helpers/chrome_crashpad_handler --x';

const snapshot = [
  '  635     1   501 Thu Oct 15 14:16:17 2026     ' + CHROME + ' --headless=new --remote-debugging-port=9223',
  '  640   635   501 Thu Oct 15 14:16:18 2026     ' + CHROME.replace('MacOS/Google Chrome', 'Frameworks/x/Helpers/Google Chrome Helper') + ' --type=renderer',
  '  731     1   501 Thu Oct 15 14:16:18 2026     ' + HANDLER.replace('156.0.8078.80', '155.0.8059.40'),
  '  800     1   501 Thu Nov 12 20:04:11 2026     ' + HANDLER,
  '  801     1   501 Thu Nov 12 20:04:30 2026     ' + LAUNCHER,
  '  802   635   501 Thu Nov  5 11:01:50 2026     ' + LAUNCHER,
  '  803 43876   501 Thu Nov  5 08:03:39 2026     ' + LAUNCHER + ' --internal',
  '  804     1   501 Thu Nov  5 08:03:39 2026     ' + LAUNCHER + ' --internal',
  '  805     1   501 Wed Nov  4 12:44:18 2026     ' + TESTING,
  '  806     1     0 Thu Nov 12 20:04:11 2026     ' + HANDLER,
  ' 1000 92961   501 Thu Nov 12 22:00:00 2026     ' + CHROME + ' --user-data-dir=/store/a',
  ' 1001     1   501 Thu Nov 12 22:00:01 2026     ' + HANDLER,
  ' 1002     1   501 Thu Nov 12 22:00:19 2026     ' + LAUNCHER,
  ' 1003     1   501 Thu Nov 12 22:25:00 2026     ' + HANDLER,
].join('\n');

const rows = parsePs(snapshot);
const now = new Date('Nov 12 2026 22:30:00').getTime();

test('parses every ps row with its start time and full command', () => {
  assert.equal(rows.length, 14);
  assert.equal(rows[2].pid, 731);
  assert.equal(rows[2].startedAt, new Date('Oct 15 2026 14:16:18').getTime());
  assert.ok(rows[4].command.endsWith('Helpers/launcher'));
});

test('reaps only aged, user-owned, launchd-parented helpers no live Chrome could own', () => {
  const picked = selectOrphanHelpers(rows, { uid: 501, now }).map((o) => `${o.pid}:${o.kind}`).sort();
  assert.deepEqual(picked, ['800:crashpad', '801:launcher']);
});

test('keeps helpers started alongside a live Chrome, including the long-lived headless one', () => {
  const pids = selectOrphanHelpers(rows, { uid: 501, now }).map((o) => o.pid);
  for (const kept of [731, 1001, 1002]) assert.ok(!pids.includes(kept), `${kept} belongs to a live Chrome`);
});

test('never touches Chrome for Testing, internal updater launchers, other users, or young helpers', () => {
  const pids = selectOrphanHelpers(rows, { uid: 501, now }).map((o) => o.pid);
  for (const kept of [802, 803, 804, 805, 806, 1003]) assert.ok(!pids.includes(kept), `${kept} must be kept`);
});

test('a helper whose Chrome has exited becomes reapable', () => {
  const withoutBrowser = rows.filter((row) => row.pid !== 1000);
  const pids = selectOrphanHelpers(withoutBrowser, { uid: 501, now }).map((o) => o.pid).sort((a, b) => a - b);
  assert.deepEqual(pids, [800, 801, 1001, 1002]);
});
