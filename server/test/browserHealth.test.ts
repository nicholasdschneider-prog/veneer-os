import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_BROWSER_VERSION, agentBrowserPaths } from '../../installer/agent-browser.mjs';
import { browserHealth } from '../../installer/browser-health.mjs';

describe('fleet browser health', () => {
  let serviceHome: string;

  beforeEach(() => {
    serviceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-browser-health-'));
  });

  afterEach(() => {
    fs.rmSync(serviceHome, { recursive: true, force: true });
  });

  function installFixture() {
    const paths = agentBrowserPaths(serviceHome);
    const chrome = path.join(paths.browsers, 'chrome-151', 'chrome-linux64', 'chrome');
    fs.mkdirSync(path.dirname(paths.binary), { recursive: true });
    fs.mkdirSync(path.dirname(paths.packageJson), { recursive: true });
    fs.mkdirSync(path.dirname(chrome), { recursive: true });
    fs.mkdirSync(path.dirname(paths.config), { recursive: true });
    fs.writeFileSync(paths.binary, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(paths.packageJson, JSON.stringify({ version: AGENT_BROWSER_VERSION }));
    fs.writeFileSync(chrome, 'chrome', { mode: 0o755 });
    fs.writeFileSync(paths.config, JSON.stringify({ executablePath: chrome }));
  }

  it('reports both installation and loopback CDP readiness', async () => {
    installFixture();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      Browser: 'Chrome/151.0.7922.47',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/test',
    }), { status: 200 }));

    await expect(browserHealth({
      serviceHome,
      cdpPort: 9333,
      fetchImpl,
      expectedBrowserArgs: null,
    })).resolves.toEqual({
      agentBrowserReady: true,
      sharedCdpReady: true,
      cdpPort: 9333,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9333/json/version',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('reports missing installation and unavailable CDP without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    });

    await expect(browserHealth({
      serviceHome,
      fetchImpl,
      expectedBrowserArgs: null,
    })).resolves.toEqual({
      agentBrowserReady: false,
      sharedCdpReady: false,
      cdpPort: 9223,
    });
  });

  it('does not accept an unrelated HTTP service as shared CDP', async () => {
    installFixture();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

    await expect(browserHealth({
      serviceHome,
      fetchImpl,
      expectedBrowserArgs: null,
    })).resolves.toMatchObject({ sharedCdpReady: false });
  });
});
