import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The ONE module that may branch on the host operating system.
 *
 * Veneer Pro runs the same code on Linux and macOS. Where the two genuinely
 * differ — where a binary lives, what a bare `PATH` should contain — the lookup
 * belongs here and nowhere else, so the per-OS surface stays small enough to
 * read in one sitting. `platform.test.ts` enforces that: it fails if
 * `process.platform` or `os.platform()` appears anywhere else under `src/`.
 *
 * Restart supervision, file locking, and process control are deliberately NOT
 * here — they were made platform-neutral rather than adapted per OS. Prefer
 * that: delete the difference before you encode it.
 */

export type Platform = 'darwin' | 'linux' | (string & {});

/** The host platform. The single read of `process.platform` in the app. */
export function currentPlatform(): Platform {
  return process.platform;
}

/**
 * The one macOS test callers outside this module may use. Features that exist
 * only on the operator's Mac (the Messages database behind fill_sms_code, for one) ask
 * here rather than reading `process.platform` and adding a second OS branch.
 */
export function isMacOS(platform: Platform = currentPlatform()): boolean {
  return platform === 'darwin';
}

export function macOSAvailableMemoryBytes(output: string, totalMemoryBytes: number): number | null {
  const match = output.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i);
  if (!match || !Number.isFinite(totalMemoryBytes) || totalMemoryBytes < 0) return null;
  const percent = Number(match[1]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return Math.round(totalMemoryBytes * percent / 100);
}

function readMacOSMemoryPressure(): string {
  return execFileSync('/usr/bin/memory_pressure', ['-Q'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1_000,
  });
}

/**
 * Node reports only completely unused pages as free memory on macOS. The
 * system memory-pressure reading also includes pages macOS can immediately
 * reclaim. Linux already reports available memory through os.freemem().
 */
export function availableSystemMemoryBytes(
  totalMemoryBytes: number,
  fallbackFreeMemoryBytes: number,
  options: {
    platform?: Platform;
    readMacOSMemoryPressure?: () => string;
  } = {},
): number {
  if (!isMacOS(options.platform ?? currentPlatform())) return fallbackFreeMemoryBytes;
  try {
    return macOSAvailableMemoryBytes(
      (options.readMacOSMemoryPressure ?? readMacOSMemoryPressure)(),
      totalMemoryBytes,
    ) ?? fallbackFreeMemoryBytes;
  } catch {
    return fallbackFreeMemoryBytes;
  }
}

/**
 * Chrome/Chromium for the shared desktop browser (CDP). Absolute paths are
 * probed directly; bare names are searched on PATH — on Linux the package name
 * varies by distro and architecture (`chromium` on arm64 Debian, where
 * `google-chrome` does not exist at all).
 *
 * `VP_CHROME_BIN` overrides everything, matching VP_CLAUDE_BIN / VP_CODEX_BIN.
 */
export function resolveChrome(
  options: {
    platform?: Platform;
    env?: NodeJS.ProcessEnv;
    /** Test seam: decides whether a candidate path is a runnable binary. */
    exists?: (file: string) => boolean;
  } = {},
): string | null {
  const env = options.env ?? process.env;
  const override = env.VP_CHROME_BIN?.trim();
  if (override) return override;
  const exists = options.exists ?? isExecutable;

  for (const candidate of chromeCandidates(options.platform ?? currentPlatform())) {
    const resolved = path.isAbsolute(candidate)
      ? exists(candidate)
        ? candidate
        : null
      : findOnPath(candidate, env, exists);
    if (resolved) return resolved;
  }
  return null;
}

function chromeCandidates(platform: Platform): string[] {
  if (isMacOS(platform)) {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      'google-chrome',
      'chromium',
    ];
  }
  return ['google-chrome', 'chromium-browser', 'chromium'];
}

/**
 * PATH for a spawned child when the parent has none. Homebrew's prefix differs
 * by architecture and is where node/npm live on a Mac, so a Linux-shaped default
 * would leave a Mini App unable to find its own runtime.
 */
export function defaultExecPath(platform: Platform = currentPlatform()): string {
  return isMacOS(platform)
    ? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
    : '/usr/local/bin:/usr/bin:/bin';
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findOnPath(name: string, env: NodeJS.ProcessEnv, exists: (file: string) => boolean): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}
