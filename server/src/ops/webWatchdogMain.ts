import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { freshWebLoopDelay, observeWeb, recordWebSample, watchdogPersistenceFailure } from './webWatchdog.js';

const args = process.argv.slice(2);
const argument = (name: string) => args[args.indexOf(name) + 1];
const dataDir = argument('--data-dir'), port = Number(argument('--port'));
if (!dataDir || !path.isAbsolute(dataDir) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Explicit absolute data directory and loopback web port required');
const db = new Database(path.join(dataDir, 'veneer-pro.db'), { fileMustExist: true });
db.pragma('busy_timeout=1000'); db.pragma('foreign_keys=ON');
let previous: { pid: number; started: string; time: number; at: number } | null = null;
let stopped = false;
let missingOwnerSamples = 0;
const tick = async () => {
  const sample = await observeWeb(port);
  // HTTP is health evidence only. PID and loop metrics require independent
  // listener attribution and fresh telemetry, including after a restart.
  sample.pid = null; sample.cpu = null; sample.eventLoop = null;
  try {
    const pid = Number(fs.readFileSync(path.join(dataDir, 'run', 'veneer-pro.pid'), 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid advisory PID');
    const listener = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 }).trim();
    // Confirm that the advisory PID actually owns this loopback listener, even
    // if its event loop cannot answer HTTP. Never inspect process arguments.
    if (listener.split('\n').filter(line => line.startsWith('p')).join('\n') === `p${pid}`) {
      sample.pid = pid;
      const output = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'time=,lstart='], { encoding: 'utf8', timeout: 1000 }).trim();
      const fields = /^(\S+)\s+(.+)$/.exec(output);
      const started = fields?.[2] ?? '';
      const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(fields?.[1] ?? '');
      if (match) {
        const time = Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4]);
        const at = performance.now();
        if (previous?.pid === pid && previous.started === started && time >= previous.time) sample.cpu = 100000 * (time - previous.time) / (at - previous.at);
        previous = { pid, started, time, at };
      }
      try {
        const telemetry: unknown = JSON.parse(fs.readFileSync(path.join(dataDir, 'ops/web-event-loop.json'), 'utf8'));
        sample.eventLoop = freshWebLoopDelay(telemetry, pid, sample.at);
      } catch { sample.eventLoop = null; }
    } else previous = null;
  } catch { previous = null; }
  if (stopped) return;
  try {
    const result = recordWebSample(db, sample);
    if (result.notification) console.info(`[web-watchdog] ${result.notification}`);
    else if (!result.ownerReady && missingOwnerSamples++ % 10 === 0) console.warn('[web-watchdog] Repair chat missing, archived or inaccessible; samples retained, wake unavailable');
  } catch (error) { console.warn(`[web-watchdog] Sample persistence unavailable (${watchdogPersistenceFailure(error)}); retrying on next bounded pass`); }
  if (!stopped) setTimeout(() => void tick(), 30000);
};
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { stopped = true; db.close(); process.exit(0); });
void tick();
