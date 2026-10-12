import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clearStoppedChromeCaches } from './cache-cleanup.mjs';

test('clears only disposable caches and preserves saved site data and symlink targets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veneer-cache-test-'));
  const chrome = path.join(root, 'chrome');
  try {
    for (const name of ['Cache', 'Default/Code Cache', 'Profile 1/GPUCache', 'Default/IndexedDB/site/Cache', 'Default/Service Worker/CacheStorage', 'outside/Cache']) {
      await fs.mkdir(path.join(chrome, name), { recursive: true });
      await fs.writeFile(path.join(chrome, name, 'data'), 'keep');
    }
    await fs.writeFile(path.join(chrome, 'Default', 'Cookies'), 'cookies');
    await fs.symlink(path.join(chrome, 'outside'), path.join(chrome, 'Profile 2'));
    await clearStoppedChromeCaches(chrome);
    for (const name of ['Cache', 'Default/Code Cache', 'Profile 1/GPUCache']) {
      await assert.rejects(fs.stat(path.join(chrome, name)), { code: 'ENOENT' });
    }
    for (const name of ['Default/IndexedDB/site/Cache/data', 'Default/Service Worker/CacheStorage/data', 'outside/Cache/data', 'Default/Cookies']) {
      assert.ok((await fs.readFile(path.join(chrome, name))).length);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
