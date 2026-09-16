import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const homes = vi.hoisted(() => ({ service: '', login: '' }));

vi.mock('../src/homes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/homes.js')>();
  return { ...actual, serviceHome: () => homes.service, loginHome: () => homes.login };
});

import { readBrowserIdentity } from '../src/veneerBrowser/remoteClient.js';

const IDENTITY_KEYS = [
  'VP_VENEER_BROWSER_CLIENT_ID',
  'VP_VENEER_BROWSER_TOKEN',
  'VP_VENEER_BROWSER_IDENTITY_FILE',
] as const;

function writeBrowserEnv(home: string, clientId: string, mode = 0o600): string {
  const dir = path.join(home, '.config', 'veneer-pro');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'browser.env');
  fs.writeFileSync(
    file,
    `VP_VENEER_BROWSER_CLIENT_ID=${clientId}\nVP_VENEER_BROWSER_TOKEN=browser-token-${clientId}\n`,
    { mode },
  );
  return file;
}

describe('Veneer Browser identity lookup', () => {
  let root: string;
  const saved: Partial<Record<(typeof IDENTITY_KEYS)[number], string>> = {};

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-browser-identity-'));
    homes.service = path.join(root, 'service-home');
    homes.login = path.join(root, 'login-home');
    fs.mkdirSync(homes.service, { recursive: true });
    fs.mkdirSync(homes.login, { recursive: true });
    for (const key of IDENTITY_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of IDENTITY_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds browser.env under the login home when the service home has none (split-home service)', () => {
    writeBrowserEnv(homes.login, '8');
    expect(readBrowserIdentity(null)).toEqual({ clientId: '8', token: 'browser-token-8' });
  });

  it('prefers the service home when both homes carry an identity', () => {
    writeBrowserEnv(homes.service, 'svc');
    writeBrowserEnv(homes.login, 'login');
    expect(readBrowserIdentity(null)?.clientId).toBe('svc');
  });

  it('still rejects a login-home identity file that other users can read', () => {
    writeBrowserEnv(homes.login, '8', 0o644);
    expect(readBrowserIdentity(null)).toBeNull();
  });

  it('reports not configured when neither home has an identity', () => {
    expect(readBrowserIdentity(null)).toBeNull();
  });
});
