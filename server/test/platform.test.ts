import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  availableSystemMemoryBytes,
  defaultExecPath,
  macOSAvailableMemoryBytes,
  resolveChrome,
} from '../src/platform.js';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });
}

describe('platform coupling', () => {
  // The architecture rule for cross-platform Veneer Pro: OS differences live in
  // exactly one module. If this fails, do not add a second one — either move the
  // lookup into platform.ts, or (better) remove the difference entirely, the way
  // the flock and systemctl couplings were removed rather than adapted.
  it('branches on the operating system in platform.ts and nowhere else', () => {
    const offenders = sourceFiles(srcDir)
      .filter((file) => path.relative(srcDir, file) !== 'platform.ts')
      .filter((file) => /process\.platform|os\.platform\(\)/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcDir, file));

    expect(offenders).toEqual([]);
  });
});

describe('availableSystemMemoryBytes', () => {
  const gibibyte = 1024 ** 3;

  it('converts the macOS available-memory percentage to bytes', () => {
    expect(macOSAvailableMemoryBytes(
      'The system has 17179869184 bytes.\nSystem-wide memory free percentage: 69%\n',
      16 * gibibyte,
    )).toBe(Math.round(16 * gibibyte * 0.69));
  });

  it('rejects invalid macOS available-memory output', () => {
    expect(macOSAvailableMemoryBytes('System-wide memory free percentage: 101%', 16 * gibibyte)).toBeNull();
    expect(macOSAvailableMemoryBytes('memory data unavailable', 16 * gibibyte)).toBeNull();
    expect(macOSAvailableMemoryBytes('System-wide memory free percentage: 69%', Number.NaN)).toBeNull();
  });

  it('falls back when the macOS reader fails', () => {
    expect(availableSystemMemoryBytes(16 * gibibyte, 2 * gibibyte, {
      platform: 'darwin',
      readMacOSMemoryPressure: () => {
        throw new Error('memory_pressure failed');
      },
    })).toBe(2 * gibibyte);
    expect(availableSystemMemoryBytes(16 * gibibyte, 2 * gibibyte, {
      platform: 'darwin',
      readMacOSMemoryPressure: () => 'invalid output',
    })).toBe(2 * gibibyte);
  });

  it('keeps the Linux free-memory reading without starting a macOS command', () => {
    let called = false;
    expect(availableSystemMemoryBytes(16 * gibibyte, 10 * gibibyte, {
      platform: 'linux',
      readMacOSMemoryPressure: () => {
        called = true;
        return '';
      },
    })).toBe(10 * gibibyte);
    expect(called).toBe(false);
  });
});

describe('resolveChrome', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-platform-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fakeBinary(name: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    return file;
  }

  it('honours VP_CHROME_BIN over any discovery', () => {
    expect(resolveChrome({ env: { VP_CHROME_BIN: '/custom/chrome' }, platform: 'linux' })).toBe('/custom/chrome');
  });

  it('finds google-chrome on PATH on linux', () => {
    const expected = fakeBinary('google-chrome');
    expect(resolveChrome({ platform: 'linux', env: { PATH: dir } })).toBe(expected);
  });

  it('falls back to chromium on linux, where arm64 has no google-chrome', () => {
    const expected = fakeBinary('chromium');
    expect(resolveChrome({ platform: 'linux', env: { PATH: dir } })).toBe(expected);
  });

  it('prefers chromium-browser over chromium on linux', () => {
    const expected = fakeBinary('chromium-browser');
    fakeBinary('chromium');
    expect(resolveChrome({ platform: 'linux', env: { PATH: dir } })).toBe(expected);
  });

  it('prefers the Chrome app bundle on darwin', () => {
    const bundle = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    // Pretend both the bundle and a PATH chromium exist, whatever this host has.
    fakeBinary('chromium');
    const resolved = resolveChrome({
      platform: 'darwin',
      env: { PATH: dir },
      exists: (file) => file === bundle || fs.existsSync(file),
    });

    expect(resolved).toBe(bundle);
  });

  it('falls back to PATH on darwin when no app bundle is installed', () => {
    const expected = fakeBinary('chromium');
    const resolved = resolveChrome({
      platform: 'darwin',
      env: { PATH: dir },
      exists: (file) => !file.startsWith('/Applications/') && fs.existsSync(file),
    });

    expect(resolved).toBe(expected);
  });

  it('returns null when nothing is installed', () => {
    expect(resolveChrome({ platform: 'linux', env: { PATH: dir } })).toBeNull();
  });
});

describe('defaultExecPath', () => {
  it('includes the Homebrew prefix on darwin, where node lives', () => {
    expect(defaultExecPath('darwin').split(':')).toContain('/opt/homebrew/bin');
  });

  it('stays Linux-shaped on linux', () => {
    expect(defaultExecPath('linux')).toBe('/usr/local/bin:/usr/bin:/bin');
  });
});
