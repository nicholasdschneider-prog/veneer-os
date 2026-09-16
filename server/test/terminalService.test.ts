import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IPty } from 'node-pty';
import { createTerminalServer } from '../src/terminalService/server.js';
import { createSessionStore } from '../src/terminalService/sessions.js';

// The loopback IPC surface the web relay talks to. Real sockets, real frames,
// fake pty — the point is the protocol, not the shell.

function fakePty() {
  let onData: (data: string) => void = () => {};
  const pty = {
    written: [] as string[],
    onData: (fn: (data: string) => void) => {
      onData = fn;
      return { dispose() {} };
    },
    onExit: () => ({ dispose() {} }),
    write: (data: string) => {
      pty.written.push(data);
      onData(`echo:${data}`);
    },
    resize: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
  };
  return pty;
}

const stubDb = { prepare: () => ({ get: () => undefined }) } as unknown as Database.Database;

describe('terminal service IPC', () => {
  let terminals: ReturnType<typeof createTerminalServer>;
  let ptys: ReturnType<typeof fakePty>[];
  let port: number;

  beforeEach(async () => {
    ptys = [];
    const store = createSessionStore({
      log: { log: () => {}, error: () => {} } as unknown as Console,
      spawnPty: () => {
        const pty = fakePty();
        ptys.push(pty);
        return pty as unknown as IPty;
      },
    });
    terminals = createTerminalServer({ db: stubDb, dataDir: '/tmp', store });
    await new Promise<void>((resolve) => terminals.server.listen(0, '127.0.0.1', resolve));
    port = (terminals.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    terminals.shutdown();
    await new Promise<void>((resolve) => terminals.server.close(() => resolve()));
  });

  const connect = (query = 'user=1&scope=universal&cols=80&rows=24') =>
    new WebSocket(`ws://127.0.0.1:${port}/attach?${query}`);

  function frames(ws: WebSocket): { next(): Promise<Record<string, unknown>> } {
    const queue: Record<string, unknown>[] = [];
    const waiters: ((frame: Record<string, unknown>) => void)[] = [];
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else queue.push(frame);
    });
    return {
      next: () =>
        new Promise((resolve) => {
          const queued = queue.shift();
          if (queued) resolve(queued);
          else waiters.push(resolve);
        }),
    };
  }

  it('answers health checks so the supervisor can see it', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);

    expect(res.status).toBe(200);
  });

  it('opens a shell, relays input back as output, and answers pings', async () => {
    const ws = connect();
    const rx = frames(ws);
    await new Promise((resolve) => ws.on('open', resolve));

    expect(await rx.next()).toEqual({ t: 'ready', replay: '', cols: 80, rows: 24 });

    ws.send(JSON.stringify({ t: 'input', data: 'ls\n' }));
    expect(await rx.next()).toEqual({ t: 'output', data: 'echo:ls\n' });
    expect(ptys[0]!.written).toEqual(['ls\n']);

    ws.send(JSON.stringify({ t: 'ping' }));
    expect(await rx.next()).toEqual({ t: 'pong' });
    ws.close();
  });

  it('keeps the shell across a disconnect and replays it to the next client', async () => {
    const first = connect();
    const firstRx = frames(first);
    await new Promise((resolve) => first.on('open', resolve));
    await firstRx.next();
    first.send(JSON.stringify({ t: 'input', data: 'whoami\n' }));
    await firstRx.next();
    await new Promise<void>((resolve) => {
      first.on('close', () => resolve());
      first.close();
    });

    const second = connect();
    const secondRx = frames(second);
    await new Promise((resolve) => second.on('open', resolve));

    expect(await secondRx.next()).toEqual({ t: 'ready', replay: 'echo:whoami\n', cols: 80, rows: 24 });
    // Same shell, not a second one — this is what survives a web restart.
    expect(ptys).toHaveLength(1);
    second.close();
  });

  it('refuses a request with no usable scope', async () => {
    const ws = connect('user=1&scope=nonsense');
    const rx = frames(ws);
    await new Promise((resolve) => ws.on('open', resolve));

    expect(await rx.next()).toEqual({ t: 'error', message: 'Invalid scope' });
  });
});
