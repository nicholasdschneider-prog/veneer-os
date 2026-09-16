import fs from 'node:fs';
import path from 'node:path';

/**
 * Pid files under DATA_DIR/run, so a restart can be triggered the same way on
 * every platform: signal the process and let its supervisor respawn it. This is
 * what replaces `systemctl --user restart` — `process.kill` and POSIX signals
 * exist on macOS and Linux alike, `systemctl` does not.
 *
 * The file is advisory. A stale one (killed -9, crash) is detected by signalling
 * pid 0 before use.
 */

export type ServiceName =
  | 'veneer-pro'
  | 'veneer-pro-runner'
  | 'veneer-pro-app-runner'
  | 'veneer-pro-term';

export const SERVICE_NAMES: readonly ServiceName[] = [
  'veneer-pro',
  'veneer-pro-runner',
  'veneer-pro-app-runner',
  'veneer-pro-term',
];

export function pidFilePath(dataDir: string, service: ServiceName): string {
  return path.join(dataDir, 'run', `${service}.pid`);
}

/** Record this process as `service`. Returns a cleanup to call on shutdown. */
export function writePidFile(dataDir: string, service: ServiceName): () => void {
  const file = pidFilePath(dataDir, service);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${process.pid}\n`, { mode: 0o600 });
  return () => {
    try {
      // Only remove our own entry: a respawn may already have claimed the file.
      if (readPidFile(dataDir, service) === process.pid) fs.rmSync(file, { force: true });
    } catch {
      /* best-effort */
    }
  };
}

/** The recorded pid, or null when absent/unreadable/malformed. */
export function readPidFile(dataDir: string, service: ServiceName): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFilePath(dataDir, service), 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Whether a pid is a live process this user may signal. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
