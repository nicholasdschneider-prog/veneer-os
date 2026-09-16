import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppServerClient } from '../src/providers/codexAppServer/protocol.js';
import { createCodexUsageReader } from '../src/usage/codex.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const live = { rateLimits: { planType: 'plus', secondary: { usedPercent: 62, windowDurationMins: 10080 } } };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  dirs.push(dir);
  const authFile = path.join(dir, 'auth.json');
  fs.writeFileSync(authFile, '{}');
  const request = vi.fn().mockResolvedValue(live);
  const reader = createCodexUsageReader({
    codexBin: 'unused', authFile, sessionsDir: dir,
    client: { request } as unknown as AppServerClient,
    log: { warn: vi.fn(), error: vi.fn() },
  });
  const session = (timestamp: string) => fs.writeFileSync(path.join(dir, 'session.jsonl'), JSON.stringify({
    timestamp,
    payload: { type: 'token_count', rate_limits: { plan_type: 'plus', secondary: { used_percent: 91, window_minutes: 10080 } } },
  }));
  return { reader, request, authFile, session };
}

describe('Codex usage account lifecycle', () => {
  it('clears a cached reading immediately on logout, even with old sessions present', async () => {
    const { reader, request, authFile, session } = setup();
    expect((await reader.read()).windows[0]?.usedPercent).toBe(62);
    expect((await reader.read()).connected).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    session(new Date().toISOString());
    fs.unlinkSync(authFile);
    expect(await reader.read()).toMatchObject({ connected: false, windows: [], planType: null, capturedAt: null });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not infer a login from session history on a fresh reader', async () => {
    const { reader, request, authFile, session } = setup();
    session(new Date().toISOString());
    fs.unlinkSync(authFile);
    expect((await reader.read()).connected).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('discards an RPC that finishes after logout', async () => {
    const { reader, request, authFile } = setup();
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = reader.read();
    fs.unlinkSync(authFile);
    finish(live);
    expect((await pending).connected).toBe(false);
    expect((await reader.read()).windows).toEqual([]);
  });

  it('bypasses the old cache when a different login replaces auth.json', async () => {
    const { reader, request, authFile } = setup();
    await reader.read();
    fs.writeFileSync(authFile, '{"testAccount":2}');
    request.mockResolvedValueOnce({ rateLimits: { planType: 'pro', secondary: { usedPercent: 4, windowDurationMins: 10080 } } });
    expect(await reader.read()).toMatchObject({ connected: true, planType: 'pro', windows: [{ usedPercent: 4 }] });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('coalesces simultaneous reads for the same account', async () => {
    const { reader, request } = setup();
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = reader.read();
    const second = reader.read();
    expect(request).toHaveBeenCalledTimes(1);
    finish(live);
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].windows[0]?.usedPercent).toBe(62);
  });

  it('does not let an old account overwrite the new account or clear its pending read', async () => {
    const { reader, request, authFile } = setup();
    let finishOld!: (value: unknown) => void;
    let finishNew!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
    const old = reader.read();
    fs.writeFileSync(authFile, '{"testAccount":2}');
    const replacement = reader.read();
    finishOld(live);
    expect((await old).connected).toBe(false);
    const another = reader.read();
    expect(request).toHaveBeenCalledTimes(2);
    finishNew({ rateLimits: { planType: 'pro', secondary: { usedPercent: 4, windowDurationMins: 10080 } } });
    for (const result of await Promise.all([replacement, another, reader.read()])) {
      expect(result.windows[0]?.usedPercent).toBe(4);
    }
    expect((await reader.read()).windows[0]?.usedPercent).toBe(4);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('replaces its owned app server on account changes and reaps it on logout', async () => {
    const { authFile } = setup();
    const request = vi.spyOn(AppServerClient.prototype, 'request').mockResolvedValue(live);
    const shutdown = vi.spyOn(AppServerClient.prototype, 'shutdown').mockImplementation(() => {});
    const reader = createCodexUsageReader({ codexBin: 'unused', authFile });
    await reader.read();
    const originalClient = request.mock.instances[0];
    fs.writeFileSync(authFile, '{"testAccount":2}');
    await reader.read();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown.mock.instances[0]).toBe(originalClient);
    expect(request.mock.instances[1]).not.toBe(originalClient);
    fs.unlinkSync(authFile);
    expect((await reader.read()).connected).toBe(false);
    expect(shutdown).toHaveBeenCalledTimes(2);
  });

  it('uses an explicitly relocated Codex profile for the credential check', async () => {
    const { authFile } = setup();
    vi.stubEnv('CODEX_HOME', path.dirname(authFile));
    const request = vi.fn().mockResolvedValue(live);
    const reader = createCodexUsageReader({
      codexBin: 'unused', client: { request } as unknown as AppServerClient,
    });
    expect((await reader.read()).windows[0]?.usedPercent).toBe(62);
    fs.unlinkSync(authFile);
    expect((await reader.read()).connected).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects a prior login’s session fallback', async () => {
    const { reader, request, session } = setup();
    session('2020-01-01T00:00:00Z');
    request.mockRejectedValue(new Error('offline'));
    expect((await reader.read()).connected).toBe(false);
  });

  it('still allows session telemetry captured after the current login', async () => {
    const { reader, request, authFile, session } = setup();
    fs.utimesSync(authFile, new Date('2020-01-01'), new Date('2020-01-01'));
    session(new Date().toISOString());
    request.mockRejectedValue(new Error('offline'));
    expect(await reader.read()).toMatchObject({ connected: true, source: 'sessions', windows: [{ usedPercent: 91 }] });
  });
});
