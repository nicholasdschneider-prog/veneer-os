import { describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import {
  REAP_DETACHED_AFTER_MS,
  SEND_HIGH_WATER,
  STALE_ATTACHED_MS,
  createSessionStore,
  trimReplay,
  type ServerFrame,
  type TermClient,
} from '../src/terminalService/sessions.js';

// A pty stand-in: node-pty spawns a real shell, which these lifecycle tests
// neither need nor want. Only the surface the store touches is modelled.
function fakePty() {
  let onData: (data: string) => void = () => {};
  let onExit: (e: { exitCode: number }) => void = () => {};
  const pty = {
    written: [] as string[],
    resized: [] as [number, number][],
    killed: false,
    paused: false,
    onData: (fn: (data: string) => void) => {
      onData = fn;
      return { dispose() {} };
    },
    onExit: (fn: (e: { exitCode: number }) => void) => {
      onExit = fn;
      return { dispose() {} };
    },
    write: (data: string) => pty.written.push(data),
    resize: (cols: number, rows: number) => pty.resized.push([cols, rows]),
    kill: () => {
      pty.killed = true;
    },
    pause: () => {
      pty.paused = true;
    },
    resume: () => {
      pty.paused = false;
    },
    emit: (data: string) => onData(data),
    exit: (code: number) => onExit({ exitCode: code }),
  };
  return pty;
}

function fakeClient() {
  const client = {
    frames: [] as ServerFrame[],
    closed: false,
    terminated: false,
    bufferedAmount: 0,
    isOpen: true,
    send: (frame: ServerFrame) => client.frames.push(frame),
    close: () => {
      client.closed = true;
    },
    terminate: () => {
      client.terminated = true;
    },
  };
  return client as TermClient & typeof client;
}

function storeWith(ptys: ReturnType<typeof fakePty>[] = []) {
  let clock = 1_000;
  const spawned: ReturnType<typeof fakePty>[] = [];
  const store = createSessionStore({
    now: () => clock,
    log: { log: () => {}, error: () => {} } as unknown as Console,
    spawnPty: () => {
      const pty = ptys[spawned.length] ?? fakePty();
      spawned.push(pty);
      return pty as unknown as IPty;
    },
  });
  return {
    store,
    spawned,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('terminal session store', () => {
  it('keeps one shell per key and replays buffered output on reattach', () => {
    const { store, spawned } = storeWith();
    const first = fakeClient();
    expect(store.attach('u1:universal', first, '/tmp', 80, 24)).toEqual({ replay: '' });

    spawned[0]!.emit('hello ');
    spawned[0]!.emit('world');
    expect(first.frames).toEqual([
      { t: 'output', data: 'hello ' },
      { t: 'output', data: 'world' },
    ]);

    // Tab closed: the shell must stay alive and keep collecting output.
    store.detach('u1:universal', first);
    spawned[0]!.emit(' again');
    expect(spawned[0]!.killed).toBe(false);

    const second = fakeClient();
    expect(store.attach('u1:universal', second, '/tmp', 80, 24)).toEqual({ replay: 'hello world again' });
    expect(spawned).toHaveLength(1);
    expect(store.size()).toBe(1);
  });

  it('hands the shell to the newest client and tells the old one why', () => {
    const { store, spawned } = storeWith();
    const first = fakeClient();
    const second = fakeClient();
    store.attach('u1:universal', first, '/tmp', 80, 24);
    store.attach('u1:universal', second, '/tmp', 80, 24);

    expect(first.frames).toContainEqual({ t: 'error', message: 'Terminal opened elsewhere' });
    expect(first.closed).toBe(true);
    expect(spawned).toHaveLength(1);

    // Only the attached client drives the shell.
    store.write('u1:universal', first, 'ignored');
    store.write('u1:universal', second, 'ls\n');
    expect(spawned[0]!.written).toEqual(['ls\n']);
  });

  it('gives each user and scope its own shell', () => {
    const { store } = storeWith();
    store.attach('u1:universal', fakeClient(), '/tmp', 80, 24);
    store.attach('u2:universal', fakeClient(), '/tmp', 80, 24);
    store.attach('u1:project:p1', fakeClient(), '/tmp', 80, 24);

    expect(store.size()).toBe(3);
  });

  it('restart kills the old shell and starts a clean one', () => {
    const { store, spawned } = storeWith();
    const client = fakeClient();
    store.attach('u1:universal', client, '/tmp', 80, 24);
    spawned[0]!.emit('old output');

    expect(store.restart('u1:universal', client, '/tmp', 80, 24)).toEqual({ replay: '' });
    expect(spawned[0]!.killed).toBe(true);
    expect(spawned).toHaveLength(2);
    // The dying pty's late output must not reach the client.
    spawned[0]!.emit('late');
    expect(client.frames).not.toContainEqual({ t: 'output', data: 'late' });
  });

  it('reports an exited shell instead of leaving a dead session behind', () => {
    const { store, spawned } = storeWith();
    const client = fakeClient();
    store.attach('u1:universal', client, '/tmp', 80, 24);

    spawned[0]!.exit(0);
    expect(client.frames).toContainEqual({ t: 'exit', code: 0 });
    expect(store.size()).toBe(0);
  });

  it('pauses the shell when a client stops draining, and resumes when it does', async () => {
    vi.useFakeTimers();
    try {
      const { store, spawned } = storeWith();
      const client = fakeClient();
      store.attach('u1:universal', client, '/tmp', 80, 24);

      client.bufferedAmount = SEND_HIGH_WATER + 1;
      spawned[0]!.emit('flood');
      expect(spawned[0]!.paused).toBe(true);

      client.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(200);
      expect(spawned[0]!.paused).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a silent client but leaves its shell running', () => {
    const { store, spawned, advance } = storeWith();
    const client = fakeClient();
    store.attach('u1:universal', client, '/tmp', 80, 24);

    advance(STALE_ATTACHED_MS + 1);
    store.reap();

    expect(client.terminated).toBe(true);
    expect(spawned[0]!.killed).toBe(false);
    expect(store.size()).toBe(1);
  });

  it('reaps a shell only after a long detach', () => {
    const { store, spawned, advance } = storeWith();
    const client = fakeClient();
    store.attach('u1:universal', client, '/tmp', 80, 24);
    store.detach('u1:universal', client);

    advance(REAP_DETACHED_AFTER_MS - 1);
    store.reap();
    expect(store.size()).toBe(1);

    advance(2);
    store.reap();
    expect(spawned[0]!.killed).toBe(true);
    expect(store.size()).toBe(0);
  });
});

describe('replay trimming', () => {
  it('cuts to a line boundary so a reattach never starts mid-escape', () => {
    const trimmed = trimReplay(`${'x'.repeat(50)}\n${'y'.repeat(200_000)}`);

    expect(trimmed.startsWith('y')).toBe(true);
    expect(trimmed.length).toBeLessThanOrEqual(200_000);
  });
});
