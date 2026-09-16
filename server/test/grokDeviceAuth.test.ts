import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  createGrokConnectManager,
  grokLoginStatus,
  installGrok,
  readGrokAuth,
  scrapeUserCode,
  grokChildEnv,
  type GrokSpawner,
} from '../src/grok/deviceAuth.js';

// The real `grok login --device-auth` banner (grok 1.0.3 alpha), including the
// gray ANSI warning line the CLI prints above it.
const BANNER =
  '\x1b[90mwarning: alpha build, expect rough edges\x1b[0m\r\n\r\n' +
  'To sign in, open this URL in your browser:\r\n\r\n' +
  '  https://accounts.x.ai/oauth2/device?user_code=TKFH-86AH\r\n\r\n' +
  'Confirm this code in your browser:\r\n\r\n' +
  '  TKFH-86AH\r\n\r\n' +
  'Waiting for authorization...\r\n';

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
  const spawnFn: GrokSpawner = () => {
    queueMicrotask(() => child.emitOut(BANNER));
    return child as unknown as ChildProcess;
  };
  return createGrokConnectManager({
    grokBin: 'grok',
    spawnFn,
    statusFn: async () => ({ connected: false, method: null, installed: true, detail: 'Not signed in.' }),
    timeouts: { startMs: 2000, expiryMs: 5000 },
    log: { warn: () => {}, error: () => {} },
    ...extra,
  });
}

describe('createGrokConnectManager', () => {
  it('start() scrapes the verification URL and one-time code past the ANSI line', async () => {
    const manager = makeManager(makeFakeChild());
    const r = await manager.start();
    expect(r.verificationUrl).toBe('https://accounts.x.ai/oauth2/device?user_code=TKFH-86AH');
    expect(r.userCode).toBe('TKFH-86AH');
    expect(r.attemptId).toBeTruthy();
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
    manager.shutdown();
  });

  it('passes `login --device-auth` to the binary', async () => {
    const child = makeFakeChild();
    let seen: string[] = [];
    const spawnFn: GrokSpawner = (bin, args) => {
      seen = [bin, ...args];
      queueMicrotask(() => child.emitOut(BANNER));
      return child as unknown as ChildProcess;
    };
    const manager = createGrokConnectManager({
      grokBin: '/opt/grok',
      spawnFn,
      statusFn: async () => ({ connected: false, method: null, installed: true, detail: '' }),
      timeouts: { startMs: 2000, expiryMs: 5000 },
      log: { warn: () => {}, error: () => {} },
    });
    await manager.start();
    expect(seen).toEqual(['/opt/grok', 'login', '--device-auth']);
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

  it('poll() after teardown falls back to the real login state', async () => {
    const child = makeFakeChild();
    const manager = makeManager(child, {
      statusFn: async () => ({ connected: true, method: 'xai', installed: true, detail: 'Signed in.' }),
    });
    const r = await manager.start();
    manager.cancel(r.attemptId);
    expect((await manager.poll(r.attemptId)).state).toBe('success');
  });

  it('start() fails cleanly when the CLI never prints a code', async () => {
    const child = makeFakeChild();
    const spawnFn: GrokSpawner = () => {
      queueMicrotask(() => {
        child.emitOut('grok: unknown flag --device-auth\n');
        child.close(2);
      });
      return child as unknown as ChildProcess;
    };
    const manager = createGrokConnectManager({
      grokBin: 'grok',
      spawnFn,
      statusFn: async () => ({ connected: false, method: null, installed: true, detail: '' }),
      timeouts: { startMs: 500, expiryMs: 5000 },
      log: { warn: () => {}, error: () => {} },
    });
    await expect(manager.start()).rejects.toThrow(/sign-in code/i);
    expect(manager.hasAttempt()).toBe(false);
  });

  it('a second start cancels the first (single in-flight attempt)', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    let n = 0;
    const spawnFn: GrokSpawner = () => {
      const c = n++ === 0 ? first : second;
      queueMicrotask(() => c.emitOut(BANNER));
      return c as unknown as ChildProcess;
    };
    const manager = createGrokConnectManager({
      grokBin: 'grok',
      spawnFn,
      statusFn: async () => ({ connected: false, method: null, installed: true, detail: '' }),
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

describe('scrapeUserCode', () => {
  it('prefers the user_code query parameter', () => {
    expect(scrapeUserCode('https://accounts.x.ai/oauth2/device?user_code=TKFH-86AH')).toBe('TKFH-86AH');
  });
  it('falls back to the echoed code line', () => {
    expect(scrapeUserCode('Confirm this code in your browser:\n\n  9XA2-B7QQ\n')).toBe('9XA2-B7QQ');
  });
  it('returns null when there is no code', () => {
    expect(scrapeUserCode('Waiting for authorization...')).toBeNull();
  });
});

describe('grokChildEnv', () => {
  it('strips XAI_API_KEY (it silently hijacks subscription auth) and pins the home', () => {
    const env = grokChildEnv({ XAI_API_KEY: 'xai-secret', PATH: '/usr/bin' });
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.GROK_HOME).toBeTruthy();
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe('1');
    expect(env.PATH).toBe('/usr/bin');
  });
  it('keeps an explicitly-set GROK_HOME', () => {
    expect(grokChildEnv({ GROK_HOME: '/tmp/pinned' }).GROK_HOME).toBe('/tmp/pinned');
  });
});

describe('readGrokAuth', () => {
  const missing = () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };

  it('reports disconnected when auth.json is missing', () => {
    expect(readGrokAuth(missing)).toEqual({ connected: false, account: null });
  });

  it('reports disconnected for a trivial file', () => {
    expect(readGrokAuth(() => '{}')).toEqual({ connected: false, account: null });
    expect(readGrokAuth(() => '   ')).toEqual({ connected: false, account: null });
    expect(readGrokAuth(() => '{"token": ""}')).toEqual({ connected: false, account: null });
  });

  it('reports connected with no account when the file is unparseable', () => {
    expect(readGrokAuth(() => 'not json at all, but substantial')).toEqual({ connected: true, account: null });
  });

  it('reads plain top-level identity fields', () => {
    const r = readGrokAuth(() => JSON.stringify({ email: 'owner@example.com', handle: 'jc', plan: 'SuperGrok' }));
    expect(r.connected).toBe(true);
    expect(r.account).toEqual({ email: 'owner@example.com', handle: 'jc', plan: 'SuperGrok' });
  });

  it('decodes a JWT-ish token payload for identity claims', () => {
    const claims = { email: 'agent@example.com', screen_name: 'veneer', subscription_tier: 'premium' };
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const jwt = `${'a'.repeat(20)}.${payload}.${'b'.repeat(20)}`;
    const r = readGrokAuth(() => JSON.stringify({ tokens: { access_token: jwt } }));
    expect(r.connected).toBe(true);
    expect(r.account).toEqual({ email: 'agent@example.com', handle: 'veneer', plan: 'premium' });
  });

  it('stays connected with a null account when nothing is decodable', () => {
    const r = readGrokAuth(() => JSON.stringify({ refresh: 'opaque-blob-value' }));
    expect(r).toEqual({ connected: true, account: null });
  });
});

describe('grokLoginStatus', () => {
  type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
  const fakeExec = (out: string, err: Error | null = null) =>
    ((_bin: string, _args: string[], _opts: unknown, cb: ExecCb) =>
      cb(err, out, '')) as unknown as typeof import('node:child_process').execFile;

  it('treats ENOENT as not installed, distinct from logged out', async () => {
    const enoent = Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' });
    const r = await grokLoginStatus('grok', fakeExec('', enoent), () => ({ connected: true, account: null }));
    expect(r).toMatchObject({ connected: false, method: null, installed: false });
  });

  it('reports installed-but-disconnected when there is no auth file', async () => {
    const r = await grokLoginStatus('grok', fakeExec('grok 1.0.3'), () => ({ connected: false, account: null }));
    expect(r).toMatchObject({ connected: false, method: null, installed: true });
    expect(r.detail).toMatch(/1\.0\.3/);
  });

  it('reports a subscription login with the account identity', async () => {
    const account = { email: 'owner@example.com', handle: 'jc', plan: 'SuperGrok' };
    const r = await grokLoginStatus('grok', fakeExec('grok 1.0.3'), () => ({ connected: true, account }));
    expect(r).toMatchObject({ connected: true, method: 'xai', installed: true, account });
    expect(r.detail).toBe('Signed in as @jc.');
  });

  it('still reports connected when the account is unreadable', async () => {
    const r = await grokLoginStatus('grok', fakeExec('grok 1.0.3'), () => ({ connected: true, account: null }));
    expect(r).toMatchObject({ connected: true, method: 'xai', account: null });
    expect(r.detail).toBe('Signed in to Grok.');
  });
});

describe('installGrok', () => {
  it('runs the shared pinned provisioner and resolves ok on a clean exit', async () => {
    const child = makeFakeChild();
    let seen: string[] = [];
    const spawnFn: GrokSpawner = (bin, args) => {
      seen = [bin, ...args];
      queueMicrotask(() => child.close(0));
      return child as unknown as ChildProcess;
    };
    const r = await installGrok(spawnFn);
    expect(r.ok).toBe(true);
    expect(seen.join(' ')).toContain('provider-runtimes.mjs');
    expect(seen).toContain('grok');
    expect(seen.join(' ')).not.toMatch(/sudo/);
  });

  it('surfaces the last output line on a failing exit', async () => {
    const child = makeFakeChild();
    const spawnFn: GrokSpawner = () => {
      queueMicrotask(() => {
        child.emitOut('curl: (6) could not resolve host\n');
        child.close(1);
      });
      return child as unknown as ChildProcess;
    };
    const r = await installGrok(spawnFn);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/could not resolve host/i);
  });
});
