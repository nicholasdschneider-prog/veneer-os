import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { proCodexHome, serviceHome } from '../src/homes.js';
import {
  createCodexConnectManager,
  codexLoginStatus,
  codexLogout,
  installCodex,
  type CodexSpawner,
} from '../src/codex/deviceAuth.js';

// A realistic `codex login --device-auth` banner (with ANSI), fixed URL plus a
// one-time code, streamed on stdout.
const BANNER =
  '\r\nWelcome to Codex [v\x1b[90m0.142.5\x1b[0m]\r\n\x1b[90mOpenAI\'s command-line coding agent\x1b[0m\r\n\r\n' +
  'Follow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n' +
  '1. Open this link in your browser and sign in to your account\r\n' +
  '   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n\r\n' +
  '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n' +
  '   \x1b[94mNUUJ-ZH546\x1b[0m\r\n';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  killed: boolean;
  kill(signal?: string): boolean;
  emitOut(s: string): void;
  close(code: number): void;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    if (child.exitCode === null) child.exitCode = -1;
    return true;
  };
  child.emitOut = (s) => child.stdout.emit('data', Buffer.from(s));
  child.close = (code) => {
    child.exitCode = code;
    child.emit('close', code);
  };
  return child;
}

function makeManager(child: FakeChild, extra: Record<string, unknown> = {}) {
  const spawnFn: CodexSpawner = () => {
    queueMicrotask(() => child.emitOut(BANNER));
    return child as unknown as ChildProcess;
  };
  return createCodexConnectManager({
    codexBin: 'codex',
    spawnFn,
    statusFn: async () => ({ connected: false, method: null, detail: 'Not logged in.' }),
    timeouts: { startMs: 2000, expiryMs: 5000 },
    log: { warn: () => {}, error: () => {} },
    ...extra,
  });
}

describe('createCodexConnectManager', () => {
  it('start() scrapes the verification URL and one-time code', async () => {
    const manager = makeManager(makeFakeChild());
    const r = await manager.start();
    expect(r.verificationUrl).toBe('https://auth.openai.com/codex/device');
    expect(r.userCode).toBe('NUUJ-ZH546');
    expect(r.attemptId).toBeTruthy();
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
    manager.shutdown();
  });

  it('poll() is pending until the child exits 0, then success', async () => {
    const child = makeFakeChild();
    const manager = makeManager(child);
    const r = await manager.start();
    expect((await manager.poll(r.attemptId)).state).toBe('pending');
    child.close(0);
    expect((await manager.poll(r.attemptId)).state).toBe('success');
    expect(manager.hasAttempt()).toBe(false);
  });

  it('poll() reports error when the child exits non-zero', async () => {
    const child = makeFakeChild();
    const manager = makeManager(child);
    const r = await manager.start();
    child.emitOut('\r\nError: authorization denied\r\n');
    child.close(1);
    const res = await manager.poll(r.attemptId);
    expect(res.state).toBe('error');
    expect(res.detail).toMatch(/denied/i);
  });

  it('a second start cancels the first (single in-flight attempt)', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    let n = 0;
    const spawnFn: CodexSpawner = () => {
      const c = n++ === 0 ? first : second;
      queueMicrotask(() => c.emitOut(BANNER));
      return c as unknown as ChildProcess;
    };
    const manager = createCodexConnectManager({
      codexBin: 'codex',
      spawnFn,
      statusFn: async () => ({ connected: false, method: null, detail: '' }),
      timeouts: { startMs: 2000, expiryMs: 5000 },
      log: { warn: () => {}, error: () => {} },
    });
    await manager.start();
    await manager.start();
    expect(first.killed).toBe(true);
    manager.shutdown();
  });

  it('cancel() kills the child and clears the attempt', async () => {
    const child = makeFakeChild();
    const manager = makeManager(child);
    const r = await manager.start();
    expect(manager.hasAttempt()).toBe(true);
    expect(manager.cancel(r.attemptId).cancelled).toBe(true);
    expect(child.killed).toBe(true);
    expect(manager.hasAttempt()).toBe(false);
  });

  it('hard-expires the attempt and kills the child', async () => {
    const child = makeFakeChild();
    const manager = makeManager(child, { timeouts: { startMs: 2000, expiryMs: 120 } });
    const r = await manager.start();
    await new Promise((res) => setTimeout(res, 220));
    expect(child.killed).toBe(true);
    expect((await manager.poll(r.attemptId)).state).toMatch(/expired|no_attempt/);
  });
});

describe('codexLoginStatus', () => {
  type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
  const fakeExec = (out: string, err: Error | null = null) =>
    ((_bin: string, _args: string[], _opts: unknown, cb: ExecCb) => cb(err, out, '')) as unknown as typeof import('node:child_process').execFile;

  it('treats "Not logged in" as disconnected (not a false positive)', async () => {
    expect(await codexLoginStatus('codex', fakeExec('Not logged in'))).toMatchObject({ connected: false, method: null });
  });
  it('recognises a ChatGPT login', async () => {
    expect(await codexLoginStatus('codex', fakeExec('Logged in using ChatGPT'))).toMatchObject({ connected: true, method: 'chatgpt' });
  });
  it('recognises an API-key login', async () => {
    expect(await codexLoginStatus('codex', fakeExec('Logged in using an API key'))).toMatchObject({ connected: true, method: 'apikey' });
  });
  it('treats a non-zero exit as disconnected', async () => {
    const r = await codexLoginStatus('codex', fakeExec('', new Error('exit 1')));
    expect(r.connected).toBe(false);
    expect(r.installed).toBe(true);
  });
  it('treats ENOENT as not installed, distinct from logged out', async () => {
    const enoent = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    const r = await codexLoginStatus('codex', fakeExec('', enoent));
    expect(r).toMatchObject({ connected: false, method: null, installed: false });
  });
});

describe('Codex account profile isolation', () => {
  it.each(['status', 'logout'] as const)('pins %s to the same profile as login and usage', async (operation) => {
    vi.stubEnv('CODEX_HOME', '');
    try {
      const exec = vi.fn((_bin, _args, options, callback) => {
        expect(options.env.CODEX_HOME).toBe(proCodexHome());
        expect(options.cwd).toBe(serviceHome());
        callback(null, operation === 'status' ? 'Not logged in' : 'Logged out', '');
      });
      const run = operation === 'status' ? codexLoginStatus : codexLogout;
      await run('codex', exec as unknown as typeof import('node:child_process').execFile);
      expect(exec).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('installCodex', () => {
  it('runs the shared pinned provisioner and resolves ok on a clean exit', async () => {
    const child = makeFakeChild();
    let seen: string[] = [];
    const spawnFn: CodexSpawner = (bin, args) => {
      seen = [bin, ...args];
      queueMicrotask(() => child.close(0));
      return child as unknown as ChildProcess;
    };
    const r = await installCodex(spawnFn);
    expect(r.ok).toBe(true);
    expect(seen.join(' ')).toContain('provider-runtimes.mjs');
    expect(seen).toContain('codex');
    expect(seen).not.toContain('sudo');
  });

  it('surfaces the last output line on a failing exit', async () => {
    const child = makeFakeChild();
    const spawnFn: CodexSpawner = () => {
      queueMicrotask(() => {
        child.emitOut('npm ERR! network timeout\n');
        child.close(1);
      });
      return child as unknown as ChildProcess;
    };
    const r = await installCodex(spawnFn);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/network timeout/i);
  });
});
