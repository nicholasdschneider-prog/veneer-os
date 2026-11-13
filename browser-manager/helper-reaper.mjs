// Chrome on macOS leaves two helpers behind every time a browser exits: its
// chrome_crashpad_handler and a GoogleUpdater "launcher", both reparented to
// launchd. --disable-crash-reporter and --disable-breakpad do not stop either in
// Chrome 156, so a busy week of working copies left ~800 of each holding 1.5 GB.
// This sweep kills only the orphans no live Chrome could still own.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const CHROME_MAIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CRASHPAD = /^\/Applications\/Google Chrome\.app\/Contents\/Frameworks\/Google Chrome Framework\.framework\/Versions\/[^/]+\/Helpers\/chrome_crashpad_handler(\s|$)/;
// No arguments: the updater's own "--internal" launchers are a live update, not litter.
const LAUNCHER = /\/Library\/Application Support\/Google\/GoogleUpdater\/[^/]+\/GoogleUpdater\.app\/Contents\/Helpers\/launcher$/;

// A helper starts within seconds of its browser (crashpad ~1 s, the launcher
// ~20 s), so any live Chrome that started shortly before one may still own it.
const OWNER_WINDOW_MS = { crashpad: 60_000, launcher: 120_000 };
const OWNER_SLACK_MS = 5_000;
export const DEFAULT_MIN_AGE_MS = 10 * 60_000;

// `ps -axo pid=,ppid=,uid=,lstart=,command=` under LC_ALL=C:
// "  731     1   501 Thu Oct 15 14:16:18 2026     /Applications/..."
export function parsePs(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})\s+(.+?)\s*$/);
    if (!m) continue;
    const startedAt = new Date(`${m[4]} ${m[5]} ${m[7]} ${m[6]}`).getTime();
    if (!Number.isFinite(startedAt)) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), startedAt, command: m[8] });
  }
  return rows;
}

function helperKind(command) {
  if (CRASHPAD.test(command)) return 'crashpad';
  if (LAUNCHER.test(command)) return 'launcher';
  return null;
}

export function selectOrphanHelpers(rows, { uid, now, minAgeMs = DEFAULT_MIN_AGE_MS }) {
  const liveChromeStarts = rows
    .filter((row) => (row.command === CHROME_MAIN || row.command.startsWith(`${CHROME_MAIN} `)) && !row.command.includes(' --type='))
    .map((row) => row.startedAt);
  const orphans = [];
  for (const row of rows) {
    const kind = helperKind(row.command);
    if (!kind || row.ppid !== 1 || row.uid !== uid) continue;
    if (now - row.startedAt < minAgeMs) continue;
    const owned = liveChromeStarts.some((start) =>
      start <= row.startedAt + OWNER_SLACK_MS && start >= row.startedAt - OWNER_WINDOW_MS[kind]);
    if (!owned) orphans.push({ pid: row.pid, kind });
  }
  return orphans;
}

export async function reapOrphanHelpers({ log = console.log } = {}) {
  if (process.platform !== 'darwin') return { crashpad: 0, launcher: 0 };
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,uid=,lstart=,command='], {
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: 32 * 1024 * 1024,
  });
  const orphans = selectOrphanHelpers(parsePs(stdout), { uid: process.getuid(), now: Date.now() });
  const counts = { crashpad: 0, launcher: 0 };
  for (const { pid, kind } of orphans) {
    try { process.kill(pid, 'SIGTERM'); counts[kind] += 1; } catch {}
  }
  if (counts.crashpad || counts.launcher) {
    log(`[veneer-browser] reaped orphaned Chrome helpers: ${counts.crashpad} crashpad, ${counts.launcher} updater launcher`);
  }
  return counts;
}
