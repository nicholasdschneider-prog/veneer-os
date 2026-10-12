import fs from 'node:fs/promises';
import path from 'node:path';

// Only disposable render caches, never cookies, IndexedDB or service workers.
const caches = ['Cache', 'Code Cache', 'GPUCache'];
export async function clearStoppedChromeCaches(chromeDir) {
  const stat = await fs.lstat(chromeDir).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
  const profiles = (await fs.readdir(chromeDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name))
    .map(entry => path.join(chromeDir, entry.name));
  for (const dir of [chromeDir, ...profiles]) {
    for (const name of caches) {
      await fs.rm(path.join(dir, name), { recursive: true, force: true });
    }
  }
}
