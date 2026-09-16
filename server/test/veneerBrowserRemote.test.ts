import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  createVeneerBrowserRemote,
  VeneerBrowserRemoteError,
} from '../src/veneerBrowser/remoteClient.js';

const TUNNEL = 'https://localhost:7301';
const LAN = 'https://browser.lan.test:8443';

interface RecordedCall {
  url: string;
  pinned: boolean;
}

interface RecordedBody {
  url: string;
  body: unknown;
}

describe('Veneer Browser remote routing', () => {
  let home: string;
  let caFile: string;
  let calls: RecordedCall[];
  let bodies: RecordedBody[];
  const original = {
    clientId: process.env.VP_VENEER_BROWSER_CLIENT_ID,
    token: process.env.VP_VENEER_BROWSER_TOKEN,
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  // The LAN dispatcher is the only thing that separates the two routes here, so
  // the stub records whether one was attached rather than inspecting sockets.
  const recorder = (
    handler: (url: string, pinned: boolean) => Promise<Response>,
  ): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const pinned = Boolean((init as { dispatcher?: unknown } | undefined)?.dispatcher);
    calls.push({ url, pinned });
    bodies.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    return handler(url, pinned);
  }) as never;

  // What node's fetch actually throws when nothing is listening: a wrapper whose
  // cause carries the socket-level code.
  const connectFailure = (code: string): Error =>
    new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code}`), { code }) });

  const remoteWithLan = (fetchImpl: typeof fetch) => createVeneerBrowserRemote({
    baseUrl: TUNNEL,
    lanUrl: LAN,
    lanCaFile: caFile,
    fetchImpl,
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-browser-remote-'));
    caFile = path.join(home, 'lan-ca.pem');
    fs.writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n', { mode: 0o600 });
    calls = [];
    bodies = [];
    process.env.VP_VENEER_BROWSER_CLIENT_ID = 'client-a';
    process.env.VP_VENEER_BROWSER_TOKEN = 'browser-token';
  });

  afterEach(() => {
    if (original.clientId === undefined) delete process.env.VP_VENEER_BROWSER_CLIENT_ID;
    else process.env.VP_VENEER_BROWSER_CLIENT_ID = original.clientId;
    if (original.token === undefined) delete process.env.VP_VENEER_BROWSER_TOKEN;
    else process.env.VP_VENEER_BROWSER_TOKEN = original.token;
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('tries the LAN listener first and falls back to the tunnel when it is unreachable', async () => {
    const remote = remoteWithLan(recorder(async (url) => {
      if (url.startsWith(LAN)) throw connectFailure('ECONNREFUSED');
      return json({ active: true, status: 'running', runtimeId: 'runtime-1' });
    }));

    await expect(remote.status('project-1', 'copy-1')).resolves.toMatchObject({ active: true });
    expect(calls).toEqual([
      { url: `${LAN}/v1/profiles/copy-1?projectId=project-1`, pinned: true },
      { url: `${TUNNEL}/v1/profiles/copy-1?projectId=project-1`, pinned: false },
    ]);
  });

  it('falls back for every way the LAN connection can fail to be established', async () => {
    for (const code of ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
      calls = [];
      const remote = remoteWithLan(recorder(async (url) => {
        if (url.startsWith(LAN)) throw connectFailure(code);
        return json({ active: true, status: 'running' });
      }));
      await expect(remote.status('project-1', 'copy-1')).resolves.toMatchObject({ active: true });
      expect(calls.map((call) => call.pinned)).toEqual([true, false]);
    }

    // undici's own connect timeout is recognised by name as well as by code.
    calls = [];
    const named = remoteWithLan(recorder(async (url) => {
      if (url.startsWith(LAN)) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('Connect Timeout Error'), { name: 'ConnectTimeoutError' }),
        });
      }
      return json({ active: true, status: 'running' });
    }));
    await expect(named.status('project-1', 'copy-1')).resolves.toMatchObject({ active: true });
    expect(calls.map((call) => call.pinned)).toEqual([true, false]);
  });

  it('never re-sends over the tunnel a request the LAN may already have run', async () => {
    // The abort lands after the POST went out, so the promotion may have already
    // happened. Replaying it would answer 409 and report a failure that was not.
    const remote = remoteWithLan(recorder(async (url) => {
      if (url.startsWith(LAN)) throw Object.assign(new Error('This operation was aborted'), { name: 'TimeoutError' });
      return json({ profile: { generation: 4 } });
    }));

    await expect(remote.promote('project-1', 'profile-1', 'copy-1', 3)).rejects.toThrow('aborted');
    expect(calls).toEqual([{ url: `${LAN}/v1/profiles/profile-1/promote`, pinned: true }]);
  });

  it('never re-sends a request that was cut off mid-flight, and keeps the LAN route', async () => {
    let cut = true;
    const remote = remoteWithLan(recorder(async (url) => {
      if (url.startsWith(LAN) && cut) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        });
      }
      return json({ profile: { generation: 2 } });
    }));

    await expect(remote.saveTemporary('project-1', 'copy-1', 'profile-9', 'Saved')).rejects.toThrow('fetch failed');
    expect(calls).toEqual([{ url: `${LAN}/v1/profiles/copy-1/save`, pinned: true }]);
    // A reset says nothing about reachability, so the LAN is not written off.
    cut = false;
    calls = [];
    await remote.saveTemporary('project-1', 'copy-1', 'profile-9', 'Saved');
    expect(calls).toEqual([{ url: `${LAN}/v1/profiles/copy-1/save`, pinned: true }]);
  });

  it('gives the LAN attempt the caller’s whole budget, not the probe’s', async () => {
    // Starting a copy is docker plus Chrome: a five-second cap would abort every
    // cold start on the LAN and write the route off for a minute each time.
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const remote = remoteWithLan(recorder(async () => json({
      active: true,
      status: 'running',
      cdpUrl: 'wss://browser.lan.test:8443/cdp/t/ws',
      viewerUrl: 'https://browser.lan.test:8443/cdp/t',
      expiresAt: '2099-01-01T00:00:00Z',
    })));

    await remote.start('project-1', 'copy-1');
    expect(timeout).toHaveBeenLastCalledWith(45_000);
    await remote.open('project-1', 'profile-1', 'copy-1', 'agent');
    expect(timeout).toHaveBeenLastCalledWith(3 * 60_000);
    expect(timeout.mock.calls.every(([ms]) => ms > 5_000)).toBe(true);
  });

  it('treats an HTTP status from the LAN listener as the manager’s own answer', async () => {
    const remote = remoteWithLan(recorder(async (url) => {
      if (url.startsWith(LAN)) return json({ error: 'conflict' }, 409);
      return json({ active: true, status: 'running' });
    }));

    await expect(remote.open('project-1', 'profile-1', 'copy-1', 'agent')).rejects
      .toBeInstanceOf(VeneerBrowserRemoteError);
    expect(calls).toEqual([
      { url: `${LAN}/v1/profiles/profile-1/open`, pinned: true },
    ]);
  });

  it('remembers a LAN failure so the next call goes straight to the tunnel', async () => {
    const remote = remoteWithLan(recorder(async (url) => {
      if (url.startsWith(LAN)) throw connectFailure('ECONNREFUSED');
      return json({ active: true, status: 'running' });
    }));

    await remote.status('project-1', 'copy-1');
    calls = [];
    await remote.status('project-1', 'copy-1');
    await remote.status('project-1', 'copy-1');
    expect(calls.every((call) => call.url.startsWith(TUNNEL) && !call.pinned)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('always mints tickets over the tunnel, whoever they are for', async () => {
    const remote = remoteWithLan(recorder(async () => json({
      cdpUrl: 'wss://localhost:7301/cdp/t/ws',
      viewerUrl: 'https://localhost:7301/cdp/t',
      expiresAt: '2099-01-01T00:00:00Z',
    })));

    // Every address in a ticket follows the host that was asked, and neither
    // consumer can reach a LAN one: the viewer runs in the user's own browser,
    // and the agent-browser CLI trusts only the roots it was built with.
    await remote.ticket('project-1', 'copy-1', 'viewer');
    await remote.ticket('project-1', 'copy-1', 'agent');
    expect(calls).toEqual([
      { url: `${TUNNEL}/v1/profiles/copy-1/ticket`, pinned: false },
      { url: `${TUNNEL}/v1/profiles/copy-1/ticket`, pinned: false },
    ]);
    expect(calls.some((call) => call.url.startsWith(LAN))).toBe(false);
  });

  it('mints the server’s own viewer connection over the LAN and pins its certificate', async () => {
    const remote = remoteWithLan(recorder(async (url) => json({
      cdpUrl: `${url.startsWith(LAN) ? LAN.replace('https:', 'wss:') : TUNNEL.replace('https:', 'wss:')}/cdp/t/ws`,
      viewerUrl: `${url.startsWith(LAN) ? LAN : TUNNEL}/cdp/t`,
      expiresAt: '2099-01-01T00:00:00Z',
    })));

    // The screencast connection is made by this server, which holds the pinned
    // certificate, so unlike ticket() it takes the LAN shortcut when it is up.
    const lan = await remote.viewerConnection('project-1', 'copy-1');
    expect(calls).toEqual([{ url: `${LAN}/v1/profiles/copy-1/ticket`, pinned: true }]);
    expect(bodies[0]?.body).toEqual({ projectId: 'project-1', purpose: 'viewer' });
    expect(lan).toEqual({
      cdpUrl: `${LAN.replace('https:', 'wss:')}/cdp/t/ws`,
      viewerUrl: `${LAN}/cdp/t`,
      expiresAt: '2099-01-01T00:00:00Z',
      caFile,
    });
  });

  it('falls back to a tunnel viewer connection, unpinned, when the LAN is down', async () => {
    const remote = remoteWithLan(recorder(async (url) => {
      if (url.startsWith(LAN)) throw connectFailure('EHOSTUNREACH');
      return json({
        cdpUrl: `${TUNNEL.replace('https:', 'wss:')}/cdp/t/ws`,
        viewerUrl: `${TUNNEL}/cdp/t`,
        expiresAt: '2099-01-01T00:00:00Z',
      });
    }));

    const tunnel = await remote.viewerConnection('project-1', 'copy-1');
    expect(calls.map((call) => call.pinned)).toEqual([true, false]);
    expect(tunnel.viewerUrl).toBe(`${TUNNEL}/cdp/t`);
    expect(tunnel.caFile).toBeNull();
  });

  it('reports the working copy the manager actually used', async () => {
    const remote = remoteWithLan(recorder(async () => json({
      ok: true,
      cloneProfileId: 'warm-copy-9',
      adopted: true,
      sourceGeneration: 3,
      active: true,
      runtimeId: 'runtime-9',
      cdpUrl: 'wss://browser.lan.test:8443/cdp/t/ws',
      viewerUrl: 'https://browser.lan.test:8443/cdp/t',
      expiresAt: '2099-01-01T00:00:00Z',
    })));

    await expect(remote.open('project-1', 'profile-1', 'offered-copy', 'agent')).resolves.toEqual({
      cloneProfileId: 'warm-copy-9',
      adopted: true,
      sourceGeneration: 3,
      runtimeId: 'runtime-9',
      cdpUrl: 'wss://browser.lan.test:8443/cdp/t/ws',
      viewerUrl: 'https://browser.lan.test:8443/cdp/t',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    expect(bodies[0]?.body).toEqual({
      projectId: 'project-1',
      cloneProfileId: 'offered-copy',
      purpose: 'agent',
    });
    // Opening is the expensive call, so it is the one that takes the shortcut.
    expect(calls).toEqual([{ url: `${LAN}/v1/profiles/profile-1/open`, pinned: true }]);
  });

  it('pins the certificate for a LAN address only', async () => {
    const remote = remoteWithLan(recorder(async () => json({ active: true, status: 'running' })));
    expect(remote.cdpCaFile('wss://browser.lan.test:8443/cdp/t/ws')).toBe(caFile);
    expect(remote.cdpCaFile('wss://localhost:7301/cdp/t/ws')).toBeNull();
    expect(remote.configured()).toBe(true);
    expect(remote.clientScope()).toBe('client-a');
    // A ticket naming some host we never pinned gets nothing: the private root
    // only ever travels to the listener it belongs to.
    expect(remote.cdpCaFile('wss://attacker.example/cdp/t/ws')).toBeNull();
  });

  // Veneer OS: the manager is this Mac's own self-signed listener and there is
  // no second address, so the pinned certificate is the base URL's own.
  describe('when the base URL is itself the pinned listener', () => {
    const localRemote = (fetchImpl: typeof fetch) => createVeneerBrowserRemote({
      baseUrl: TUNNEL,
      lanCaFile: caFile,
      fetchImpl,
    });

    it('dials the base URL through a dispatcher that trusts the pinned certificate', async () => {
      const remote = localRemote(recorder(async () => json({ active: true, status: 'running' })));
      await expect(remote.status('project-1', 'copy-1')).resolves.toMatchObject({ active: true });
      expect(calls).toEqual([
        { url: `${TUNNEL}/v1/profiles/copy-1?projectId=project-1`, pinned: true },
      ]);
    });

    it('pins the base URL’s own host for CDP and viewer connections', async () => {
      const remote = localRemote(recorder(async () => json({
        cdpUrl: `${TUNNEL.replace('https:', 'wss:')}/cdp/t/ws`,
        viewerUrl: `${TUNNEL}/cdp/t`,
        expiresAt: '2099-01-01T00:00:00Z',
      })));

      expect(remote.cdpCaFile(`${TUNNEL.replace('https:', 'wss:')}/cdp/t/ws`)).toBe(caFile);
      expect(remote.cdpCaFile()).toBe(caFile);
      await expect(remote.viewerConnection('project-1', 'copy-1')).resolves.toMatchObject({ caFile });
    });

    it('still refuses to hand the certificate to any other host, or to a cleartext address', async () => {
      const remote = localRemote(recorder(async () => json({ active: true, status: 'running' })));
      expect(remote.cdpCaFile('wss://browser.lan.test:8443/cdp/t/ws')).toBeNull();
      expect(remote.cdpCaFile('wss://attacker.example/cdp/t/ws')).toBeNull();
      expect(remote.cdpCaFile('ws://localhost:7301/cdp/t/ws')).toBeNull();
      expect(remote.cdpCaFile('not a url')).toBeNull();
    });

    it('leaves the base URL unpinned when no certificate is configured at all', async () => {
      const remote = createVeneerBrowserRemote({
        baseUrl: TUNNEL,
        fetchImpl: recorder(async () => json({ active: true, status: 'running' })),
      });
      await remote.status('project-1', 'copy-1');
      expect(calls).toEqual([
        { url: `${TUNNEL}/v1/profiles/copy-1?projectId=project-1`, pinned: false },
      ]);
      expect(remote.cdpCaFile(`${TUNNEL.replace('https:', 'wss:')}/cdp/t/ws`)).toBeNull();
    });
  });

  it('keeps the single tunnel route when the pinned certificate is missing, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const absent = path.join(home, 'absent.pem');
    const remote = createVeneerBrowserRemote({
      baseUrl: TUNNEL,
      lanUrl: LAN,
      lanCaFile: absent,
      fetchImpl: recorder(async () => json({ active: true, status: 'running' })),
    });

    await remote.status('project-1', 'copy-1');
    expect(calls).toEqual([{ url: `${TUNNEL}/v1/profiles/copy-1?projectId=project-1`, pinned: false }]);
    expect(remote.cdpCaFile('wss://browser.lan.test:8443/cdp/t/ws')).toBeNull();
    // Once, at construction, and never carrying the bearer identity.
    expect(warn).toHaveBeenCalledOnce();
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain(absent);
    expect(message).not.toContain('browser-token');
    expect(message).not.toContain('client-a');
  });
});

describe('Veneer Browser LAN configuration', () => {
  it('refuses a cleartext LAN origin, which would carry the client token in the open', () => {
    expect(() =>
      loadConfig({ VP_IDENTITY: 'dev', VP_VENEER_BROWSER_LAN_URL: 'http://browser.lan.test:8443' }),
    ).toThrow(/must start with https/);
    expect(
      loadConfig({ VP_IDENTITY: 'dev', VP_VENEER_BROWSER_LAN_URL: 'https://browser.lan.test:8443/' })
        .veneerBrowserLanUrl,
    ).toBe('https://browser.lan.test:8443');
    expect(loadConfig({ VP_IDENTITY: 'dev' }).veneerBrowserLanUrl).toBeNull();
  });
});
