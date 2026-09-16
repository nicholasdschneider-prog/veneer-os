import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createClaudeConnectManager,
  extractAuthorizeUrl,
  stripAnsi,
  redactToken,
  type PtySession,
  type PtySpawner,
} from '../src/claude/setupToken.js';
import { createSecretStore } from '../src/secrets/store.js';

// A realistic `claude setup-token` banner: ANSI escapes + a URL hard-wrapped at
// terminal width (no spaces inside the URL), followed by the paste prompt.
const REAL_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=XEXQ7YcpEnaxC47sJJGLWuHTVvtuFSAkB_E_VVnp4iE&code_challenge_method=S256&state=FOyPpMqdmdyd3puuDXrIeKCfbL0azfukAkx8aqt4c9M';

function wrap(s: string, cols: number): string {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += cols) parts.push(s.slice(i, i + cols));
  return parts.join('\r\n');
}

function bannerWith(url: string): string {
  return (
    '\x1b[2J\x1b[H\x1b[?25l' +
    'Welcome to Claude Code v2.1.200\r\n\r\n' +
    '\x1b[90mOpening browser to sign in…\x1b[0m\r\n\r\n' +
    "Browser didn't open? Use the url below to sign in (c to copy)\r\n\r\n" +
    wrap(url, 120) +
    '\r\n\r\n\r\n' +
    'Paste code here if prompted > '
  );
}

class FakePty implements PtySession {
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((i: { exitCode: number }) => void) | null = null;
  killed = false;
  writes: string[] = [];
  private typed = '';
  // onSubmit fires only when Enter (\r) arrives — models the CLI's masked
  // prompt, which submits on a SEPARATE Enter keystroke, not on `code\r`.
  constructor(
    private readonly url: string,
    private readonly onSubmit: (code: string, pty: FakePty) => void,
  ) {}
  emit(s: string): void {
    this.dataCb?.(s);
  }
  exit(code: number): void {
    this.exitCb?.({ exitCode: code });
  }
  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
    queueMicrotask(() => this.emit(bannerWith(this.url)));
  }
  onExit(cb: (i: { exitCode: number }) => void): void {
    this.exitCb = cb;
  }
  write(data: string): void {
    this.writes.push(data);
    if (data.includes('\r')) {
      const code = this.typed + data.slice(0, data.indexOf('\r'));
      this.typed = '';
      this.onSubmit(code, this);
    } else {
      this.typed += data;
    }
  }
  kill(): void {
    this.killed = true;
  }
}

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vp-secrets-'));
}

const okProbe = async () => ({ ok: true, detail: 'Claude answered.' });

describe('extractAuthorizeUrl', () => {
  it('joins a terminal-wrapped URL back into a single valid URL', () => {
    const raw = bannerWith(REAL_URL);
    expect(extractAuthorizeUrl(raw)).toBe(REAL_URL);
  });

  it('does not bleed into text after the URL', () => {
    const url = extractAuthorizeUrl(bannerWith(REAL_URL))!;
    expect(url.endsWith('state=FOyPpMqdmdyd3puuDXrIeKCfbL0azfukAkx8aqt4c9M')).toBe(true);
    expect(url).not.toContain('Paste');
  });

  it('returns null when no authorize URL is present', () => {
    expect(extractAuthorizeUrl('just some banner text')).toBeNull();
  });
});

describe('stripAnsi / redactToken', () => {
  it('strips ANSI escapes and control bytes', () => {
    expect(stripAnsi('\x1b[2J\x1b[90mhello\x1b[0m\x07')).toBe('hello');
  });
  it('redacts oauth tokens', () => {
    expect(redactToken('token is sk-ant-oat01-ABC_def-123 ok')).toBe('token is sk-ant-oat01-[REDACTED] ok');
  });
});

describe('ClaudeConnectManager', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = tmpDataDir();
  });

  function makeManager(spawnPty: PtySpawner, extra: Record<string, unknown> = {}) {
    const secrets = createSecretStore(dataDir, {});
    const manager = createClaudeConnectManager({
      claudeBin: 'claude',
      secrets,
      spawnPty,
      probe: okProbe,
      timeouts: { authorizeUrlMs: 2000, completeMs: 500, hardExpiryMs: 5000 },
      log: { warn: () => {}, error: () => {} },
      ...extra,
    });
    return { secrets, manager };
  }

  it('start() returns a parsed authorize URL (scopes widened for usage telemetry) and an expiry', async () => {
    const spawnPty: PtySpawner = () => new FakePty(REAL_URL, () => {});
    const { manager } = makeManager(spawnPty);
    const r = await manager.start();
    // The CLI requests only user:inference; we add user:profile so the minted
    // token can read GET /api/oauth/usage (see widenScopes).
    expect(r.authorizeUrl).toBe(REAL_URL.replace('scope=user%3Ainference', 'scope=user%3Ainference%20user%3Aprofile'));
    expect(r.attemptId).toBeTruthy();
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
    manager.shutdown();
  });

  it('complete() with a good code stores the token (0600) and runs the probe', async () => {
    const spawnPty: PtySpawner = () =>
      new FakePty(REAL_URL, (code, pty) => {
        if (code === 'GOODCODE#state') pty.emit('\r\nsk-ant-oat01-REALTOKEN_abc123DEF-xyz\r\n');
      });
    const { manager, secrets } = makeManager(spawnPty);
    const start = await manager.start();
    const res = await manager.complete(start.attemptId, 'GOODCODE#state');
    expect(res.probe.ok).toBe(true);
    expect(secrets.getClaudeToken()).toBe('sk-ant-oat01-REALTOKEN_abc123DEF-xyz');
    const mode = fs.statSync(path.join(dataDir, 'secrets.json')).mode & 0o777;
    expect(mode).toBe(0o600);
    const st = secrets.status();
    expect(st.connected).toBe(true);
    expect(st.source).toBe('app');
    expect(st.connectedAt).toBeTruthy();
  });

  it('complete() with a bad code errors and stores nothing', async () => {
    const spawnPty: PtySpawner = () =>
      new FakePty(REAL_URL, (code, pty) => {
        // Wrong code: CLI stays alive and re-prompts, never emits a token.
        if (code === 'GOODCODE#state') pty.emit('\r\nsk-ant-oat01-REALTOKEN\r\n');
      });
    const { manager, secrets } = makeManager(spawnPty);
    const start = await manager.start();
    await expect(manager.complete(start.attemptId, 'WRONG#state')).rejects.toThrow(/did not work/i);
    expect(secrets.getClaudeToken()).toBeNull();
  });

  it('submits the code then Enter as SEPARATE writes (not one code\\r chunk)', async () => {
    let captured: FakePty | null = null;
    const spawnPty: PtySpawner = () => {
      captured = new FakePty(REAL_URL, (code, pty) => {
        if (code === 'GOODCODE#state') pty.emit('\r\nsk-ant-oat01-OKTOKEN_1\r\n');
      });
      return captured;
    };
    const { manager, secrets } = makeManager(spawnPty);
    const start = await manager.start();
    await manager.complete(start.attemptId, 'GOODCODE#state');
    expect(secrets.getClaudeToken()).toBe('sk-ant-oat01-OKTOKEN_1');
    // The code must NOT be sent glued to \r; Enter is its own write.
    const w = captured!.writes;
    expect(w.some((x) => x.includes('\r') && x.replace(/[\r\n]/g, '').length > 0)).toBe(false);
    expect(w).toContain('\r');
    expect(w.join('')).toContain('GOODCODE#state');
  });

  it('fails fast (bad_code) on an explicit OAuth error, without waiting the full timeout', async () => {
    const spawnPty: PtySpawner = () =>
      new FakePty(REAL_URL, (_code, pty) => pty.emit('\r\nOAuth error: Request failed with status code 400\r\n'));
    // Long completeMs — if we waited it out the test would be slow; fail-fast keeps it snappy.
    const { manager, secrets } = makeManager(spawnPty, { timeouts: { authorizeUrlMs: 2000, completeMs: 10_000, hardExpiryMs: 20_000 } });
    const start = await manager.start();
    const t0 = Date.now();
    await expect(manager.complete(start.attemptId, 'WRONG#state')).rejects.toThrow(/did not work/i);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(secrets.getClaudeToken()).toBeNull();
  });

  it('redacts the token if the verify probe throws it back', async () => {
    const spawnPty: PtySpawner = () =>
      new FakePty(REAL_URL, (_code, pty) => pty.emit('\r\nsk-ant-oat01-SECRET_abc123\r\n'));
    const throwingProbe = async () => {
      throw new Error('auth failed for sk-ant-oat01-SECRET_abc123 badly');
    };
    const { manager } = makeManager(spawnPty, { probe: throwingProbe });
    const start = await manager.start();
    const res = await manager.complete(start.attemptId, 'x#y');
    expect(res.probe.ok).toBe(false);
    expect(res.probe.detail).not.toContain('sk-ant-oat01-SECRET_abc123');
    expect(res.probe.detail).toContain('[REDACTED]');
    manager.shutdown();
  });

  it('enforces a single in-flight attempt (second start cancels the first)', async () => {
    const spawned: FakePty[] = [];
    const spawnPty: PtySpawner = () => {
      const p = new FakePty(REAL_URL, () => {});
      spawned.push(p);
      return p;
    };
    const { manager } = makeManager(spawnPty);
    const first = await manager.start();
    const second = await manager.start();
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(spawned[0]!.killed).toBe(true);
    // Completing the stale attempt fails.
    await expect(manager.complete(first.attemptId, 'x#y')).rejects.toThrow(/expired/i);
    manager.shutdown();
  });

  it('hard-expires an attempt and kills the child', async () => {
    const p = new FakePty(REAL_URL, () => {});
    const spawnPty: PtySpawner = () => p;
    const { manager } = makeManager(spawnPty, { timeouts: { authorizeUrlMs: 2000, completeMs: 500, hardExpiryMs: 120 } });
    const start = await manager.start();
    await new Promise((r) => setTimeout(r, 250));
    expect(p.killed).toBe(true);
    await expect(manager.complete(start.attemptId, 'x#y')).rejects.toThrow(/expired/i);
  });

  it('cancel() kills the child and clears the attempt', async () => {
    const p = new FakePty(REAL_URL, () => {});
    const spawnPty: PtySpawner = () => p;
    const { manager } = makeManager(spawnPty);
    const start = await manager.start();
    expect(manager.hasAttempt()).toBe(true);
    const r = manager.cancel(start.attemptId);
    expect(r.cancelled).toBe(true);
    expect(p.killed).toBe(true);
    expect(manager.hasAttempt()).toBe(false);
  });
});

describe('secret store precedence', () => {
  it('app token beats env; status reports the right source', () => {
    const dataDir = tmpDataDir();
    const withEnv = createSecretStore(dataDir, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-ENVTOKEN' });
    // env fallback only
    expect(withEnv.status()).toMatchObject({ connected: true, source: 'env' });
    expect(withEnv.getClaudeToken()).toBeNull(); // app store is empty
    // app token now present
    withEnv.addClaudeAccount({ token: 'sk-ant-oat01-APPTOKEN' });
    expect(withEnv.getClaudeToken()).toBe('sk-ant-oat01-APPTOKEN');
    expect(withEnv.status()).toMatchObject({ connected: true, source: 'app' });
    // clear → falls back to env
    withEnv.clearClaudeToken();
    expect(withEnv.status()).toMatchObject({ connected: true, source: 'env' });
    // no env, no app → disconnected
    const bare = createSecretStore(tmpDataDir(), {});
    expect(bare.status()).toMatchObject({ connected: false, source: null });
  });
});
