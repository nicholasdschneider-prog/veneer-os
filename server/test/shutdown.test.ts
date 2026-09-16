import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../src/shutdown.js';
import { isRunning, pidFilePath, readPidFile, writePidFile } from '../src/servicePid.js';

describe('service pid files', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-pid-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('records this process and reads it back', () => {
    const clear = writePidFile(dataDir, 'veneer-pro-runner');

    expect(readPidFile(dataDir, 'veneer-pro-runner')).toBe(process.pid);
    expect(isRunning(process.pid)).toBe(true);

    clear();
    expect(readPidFile(dataDir, 'veneer-pro-runner')).toBeNull();
  });

  it('leaves a pid file that a respawn already claimed', () => {
    const clear = writePidFile(dataDir, 'veneer-pro');
    // Simulate the supervisor bringing a replacement up before we cleaned up.
    fs.writeFileSync(pidFilePath(dataDir, 'veneer-pro'), '999999\n');

    clear();

    expect(readPidFile(dataDir, 'veneer-pro')).toBe(999999);
  });

  it('reports a malformed pid file as absent', () => {
    fs.mkdirSync(path.join(dataDir, 'run'), { recursive: true });
    fs.writeFileSync(pidFilePath(dataDir, 'veneer-pro'), 'not-a-pid\n');

    expect(readPidFile(dataDir, 'veneer-pro')).toBeNull();
  });

  it('reports a dead pid as not running', () => {
    // A pid that cannot exist: max pid on both darwin and linux is far below.
    expect(isRunning(0x7ffffff0)).toBe(false);
  });
});

describe('graceful drain', () => {
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation(((): never => undefined as never));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function listening(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { server, url: `http://127.0.0.1:${port}` };
  }

  it('lets an in-flight request finish before releasing resources', async () => {
    let release!: () => void;
    const requestReached = new Promise<void>((resolve) => {
      release = resolve;
    });
    let released = false;
    let responseEnded = false;
    let releasedBeforeResponseEnded = false;

    const { server, url } = await listening((_req, res) => {
      release();
      setTimeout(() => {
        responseEnded = true;
        res.end('done');
      }, 120);
    });
    const shutdown = createShutdown({
      name: 'test',
      server,
      release: () => {
        releasedBeforeResponseEnded = !responseEnded;
        released = true;
      },
    });

    const inFlight = fetch(`${url}/slow`).then((r) => r.text());
    await requestReached;
    shutdown.drainAndExit('test');

    // The client may observe the completed body before or after the server's
    // close event, so assert the real invariant inside the release callback.
    await expect(inFlight).resolves.toBe('done');
    await vi.waitFor(() => expect(released).toBe(true));
    expect(releasedBeforeResponseEnded).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('stops accepting new requests once draining', async () => {
    const { server, url } = await listening((_req, res) => res.end('ok'));
    const shutdown = createShutdown({ name: 'test', server, release: () => {} });

    await expect(fetch(url).then((r) => r.text())).resolves.toBe('ok');
    shutdown.drainAndExit('test');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    await expect(fetch(url)).rejects.toThrow();
  });

  it('forces the exit when a request outlives the drain budget', async () => {
    const { server, url } = await listening((_req, res) => {
      // Never responds: this is the hung-request case the budget exists for.
      setTimeout(() => res.end('too late'), 10_000).unref();
    });
    const shutdown = createShutdown({ name: 'test', server, release: () => {}, drainTimeoutMs: 60 });

    const hung = fetch(`${url}/hang`).catch(() => 'aborted');
    await vi.waitFor(() => expect(server.listening).toBe(true));
    // Give the request a moment to actually reach the handler.
    await new Promise((resolve) => setTimeout(resolve, 30));
    shutdown.drainAndExit('test');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 2_000 });
    await hung;
  });

  it('is idempotent when a signal races a restart request', async () => {
    const { server } = await listening((_req, res) => res.end('ok'));
    let releases = 0;
    const shutdown = createShutdown({
      name: 'test',
      server,
      release: () => {
        releases += 1;
      },
    });

    shutdown.drainAndExit('sigterm');
    shutdown.drainAndExit('restart request');
    await vi.waitFor(() => expect(releases).toBe(1));
  });
});
