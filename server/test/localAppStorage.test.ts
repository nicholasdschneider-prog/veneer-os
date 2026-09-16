import { fork } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalAppStorage, createLocalAppServer } from '../src/appRunner/child.js';
import { localAppEnvironment, localAppExecArgv } from '../src/appRunner/manager.js';

describe('local Mini App storage', () => {
  const dirs: string[] = [];

  function workspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-local-app-storage-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stores JSON values by copy and reports missing keys as undefined', async () => {
    const dir = workspace();
    const storage = createLocalAppStorage(path.join(dir, 'storage'));

    await expect(storage.get('missing')).resolves.toBeUndefined();
    const value = { owner: 'client-a', tags: ['a'] };
    await storage.put('state', value);
    value.owner = 'mutated-after-put';
    await expect(storage.get('state')).resolves.toEqual({ owner: 'client-a', tags: ['a'] });

    const read = (await storage.get('state')) as { owner: string };
    read.owner = 'mutated-after-get';
    await expect(storage.get('state')).resolves.toMatchObject({ owner: 'client-a' });

    await storage.set('other', 1);
    await expect(storage.delete('other')).resolves.toBe(true);
    await expect(storage.delete('other')).resolves.toBe(false);
    await expect(storage.get('other')).resolves.toBeUndefined();

    // Values survive a restart of the app process.
    const reopened = createLocalAppStorage(path.join(dir, 'storage'));
    await expect(reopened.get('state')).resolves.toEqual({ owner: 'client-a', tags: ['a'] });
  });

  it('serializes transactions and rolls back when the callback throws', async () => {
    const dir = workspace();
    const storage = createLocalAppStorage(path.join(dir, 'storage'));
    await storage.put('count', 0);

    const increments = Array.from({ length: 5 }, () =>
      storage.transaction(async (transaction) => {
        const current = ((await transaction.get('count')) as number) ?? 0;
        await new Promise((resolve) => setTimeout(resolve, 1));
        await transaction.put('count', current + 1);
      }),
    );
    await Promise.all(increments);
    await expect(storage.get('count')).resolves.toBe(5);

    await expect(
      storage.transaction(async (transaction) => {
        await transaction.put('count', 99);
        await transaction.delete('count');
        throw new Error('app failed mid-transaction');
      }),
    ).rejects.toThrow('app failed mid-transaction');
    await expect(storage.get('count')).resolves.toBe(5);
    await expect(createLocalAppStorage(path.join(dir, 'storage')).get('count')).resolves.toBe(5);
  });

  it('exposes storage to a local app through the request context', async () => {
    const dir = workspace();
    const modulePath = path.join(dir, 'app.mjs');
    fs.writeFileSync(
      modulePath,
      `export async function handle(request, context) {
        const owner = await request.text();
        const status = await context.storage.transaction(async (storage) => {
          const state = (await storage.get('state')) ?? { owner: null };
          if (state.owner) return 409;
          state.owner = owner;
          await storage.put('state', state);
          return 200;
        });
        return Response.json(await context.storage.get('state'), { status });
      }`,
    );
    const server = await createLocalAppServer(modulePath, {
      appId: 'app-1',
      tenant: 'lps',
      publicPath: '/tools/pipeline',
      publicUrl: 'https://lps.veneer.app/tools/pipeline/',
      appsUrl: 'https://lps.veneer.app/#/apps',
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      const reserve = (owner: string) =>
        fetch(`http://127.0.0.1:${port}/reserve`, { method: 'POST', body: owner });

      const [first, second] = await Promise.all([reserve('client-a'), reserve('client-b')]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      const stored = JSON.parse(fs.readFileSync(path.join(dir, 'storage', 'data.json'), 'utf8')) as {
        state: { owner: string };
      };
      expect(['client-a', 'client-b']).toContain(stored.state.owner);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('can write storage but not the app module inside the permission sandbox', async () => {
    const dir = workspace();
    const appDir = path.join(dir, 'mini-app');
    const childEntry = path.join(dir, 'sandbox-child.mjs');
    fs.mkdirSync(path.join(appDir, 'storage'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'app.mjs'), 'export function handle() {}');
    fs.writeFileSync(
      childEntry,
      [
        "import fs from 'node:fs';",
        'const appDir = process.argv[2];',
        'const result = {};',
        'try { fs.writeFileSync(appDir + "/storage/data.json", "{}"); result.wroteStorage = true; } catch (error) { result.wroteStorage = error.code; }',
        'try { fs.writeFileSync(appDir + "/app.mjs", "hijacked"); result.wroteModule = true; } catch (error) { result.wroteModule = error.code; }',
        'process.send?.(result);',
      ].join('\n'),
    );

    const result = await new Promise<{ wroteStorage: unknown; wroteModule: unknown }>((resolve, reject) => {
      const child = fork(fs.realpathSync(childEntry), [fs.realpathSync(appDir)], {
        cwd: appDir,
        env: localAppEnvironment(),
        execArgv: localAppExecArgv(childEntry, appDir),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('message', (message) => resolve(message as { wroteStorage: unknown; wroteModule: unknown }));
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code && code !== 0) reject(new Error(`sandbox child exited ${code}: ${stderr.trim()}`));
      });
    });

    expect(result).toEqual({ wroteStorage: true, wroteModule: 'ERR_ACCESS_DENIED' });
  });
});
