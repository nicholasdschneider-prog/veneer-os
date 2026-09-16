import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-install shared secret for the runner's loopback IPC (runner/ipcServer.ts
 * ↔ runner/client.ts). The 127.0.0.1 bind is not a real trust boundary: any
 * page in a browser on this host can POST to it, so every /rpc/* request and
 * the /events upgrade must carry this secret in `x-vp-ipc-secret`.
 *
 * Both processes derive the file from the shared dataDir and provision it
 * lazily, so whichever boots first mints it.
 */

export const IPC_SECRET_HEADER = 'x-vp-ipc-secret';

export function ipcSecretPath(dataDir: string): string {
  return path.join(dataDir, 'runner-ipc-secret');
}

/** Read the shared secret, minting it on first need. Never log the result. */
export function ensureIpcSecret(dataDir: string): string {
  const file = ipcSecretPath(dataDir);
  const existing = readSecretFile(file);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const minted = crypto.randomBytes(32).toString('hex');
  try {
    // Exclusive create: runner and web boot concurrently and both bootstrap
    // this file. The loser of the race must adopt the winner's secret rather
    // than overwrite it, or the two processes end up with different secrets.
    fs.writeFileSync(file, `${minted}\n`, { mode: 0o600, flag: 'wx' });
    return minted;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const written = readSecretFile(file);
    if (!written) throw new Error('runner IPC secret file exists but is empty');
    return written;
  }
}

function readSecretFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Constant-time compare of a request header against the expected secret. */
export function ipcSecretMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || !provided) return false;
  // Hash both sides so the compare is fixed-width regardless of header length.
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
