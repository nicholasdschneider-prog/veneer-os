import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readSharedChromeConfig,
  sharedChromeArgs,
  startSharedChrome,
} from '../../installer/shared-chrome.mjs';

describe('Linux shared Chrome service', () => {
  let serviceHome: string;
  let chromeBin: string;

  beforeEach(() => {
    serviceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-shared-chrome-'));
    chromeBin = path.join(serviceHome, '.agent-browser', 'browsers', 'chrome', 'chrome-linux64', 'chrome');
    fs.mkdirSync(path.dirname(chromeBin), { recursive: true });
    fs.writeFileSync(chromeBin, 'chrome', { mode: 0o755 });
    fs.writeFileSync(
      path.join(serviceHome, '.agent-browser', 'config.json'),
      JSON.stringify({ executablePath: chromeBin, args: '--no-sandbox' }),
    );
  });

  afterEach(() => {
    fs.rmSync(serviceHome, { recursive: true, force: true });
  });

  it('binds CDP to loopback with the configured port and durable profile', () => {
    const args = sharedChromeArgs({
      serviceHome,
      config: readSharedChromeConfig({ serviceHome }),
      port: 9333,
    });

    expect(args).toContain('--no-sandbox');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--disable-dev-shm-usage');
    expect(args).toContain('--remote-debugging-port=9333');
    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(args).toContain(`--user-data-dir=${path.join(serviceHome, '.veneer-chrome')}`);
    expect(args).not.toContain('--remote-debugging-address=0.0.0.0');
  });

  it('starts the configured executable without a shell', () => {
    const child = {
      once: vi.fn(),
      kill: vi.fn(),
    };
    const spawnImpl = vi.fn(() => child);

    startSharedChrome({ serviceHome, port: 9223, spawnImpl });

    expect(spawnImpl).toHaveBeenCalledWith(
      chromeBin,
      expect.arrayContaining([
        '--remote-debugging-port=9223',
        '--remote-debugging-address=127.0.0.1',
      ]),
      expect.objectContaining({
        cwd: serviceHome,
        stdio: 'inherit',
      }),
    );
    expect(fs.statSync(path.join(serviceHome, '.veneer-chrome')).mode & 0o777).toBe(0o700);
  });

  it('rejects missing trusted Chrome and invalid ports', () => {
    fs.unlinkSync(chromeBin);
    expect(() => readSharedChromeConfig({ serviceHome })).toThrow('no executable Chrome');
    expect(() =>
      sharedChromeArgs({
        serviceHome,
        config: { executablePath: '/chrome' },
        port: 70_000,
      }),
    ).toThrow('Invalid shared Chrome CDP port');
  });

  it('rejects Chrome without execute permission', () => {
    fs.chmodSync(chromeBin, 0o600);
    expect(() => readSharedChromeConfig({ serviceHome })).toThrow('no executable Chrome');
  });
});
