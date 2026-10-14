import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RunningRelease {
  id: string | null;
  git_sha: string | null;
  manifest_sha256: string | null;
}

let cached: RunningRelease | undefined;

/**
 * The immutable release this process was started from (scripts/releases.mjs),
 * or id null when it runs the checkout's in-place build. Read once: the bytes a
 * process runs cannot change under it, so neither does the answer.
 */
export function runningRelease(distRoot?: string): RunningRelease {
  if (!distRoot && cached) return cached;
  const root = distRoot ?? path.dirname(fileURLToPath(import.meta.url));
  let result: RunningRelease = { id: null, git_sha: null, manifest_sha256: null };
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(root, '..', '..', 'release.json'), 'utf8')) as Partial<RunningRelease>;
    if (typeof meta.id === 'string') result = { id: meta.id, git_sha: meta.git_sha ?? null, manifest_sha256: meta.manifest_sha256 ?? null };
  } catch {
    /* no release.json: started from the checkout build */
  }
  if (!distRoot) cached = result;
  return result;
}

/** One boot line naming the bytes this service runs. */
export function logRunningRelease(service: string): void {
  const release = runningRelease();
  if (release.id) console.log(`[release] ${service} running release ${release.id}`);
  else console.warn(`[release] ${service} running the checkout build in place: a rebuild is deployed by the next crash or respawn. Install release-mode plists in an approved window (scripts/releases.mjs).`);
}
