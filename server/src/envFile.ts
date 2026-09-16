import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Loads the service env file into `process.env`.
 *
 * systemd has `EnvironmentFile=`; launchd has no equivalent. The alternative on
 * macOS would be to wrap each service in a shell that sources the file, which
 * would quietly make the file's syntax shell-dependent — a value containing a
 * space or a quote would then parse differently on the two platforms. Instead
 * every service loads the file itself, so there is one file, one format, and
 * one parser everywhere.
 *
 * Variables already present in the environment always win: systemd injects them
 * before exec on Linux and stays authoritative there, and an operator can
 * override any single value for a one-off run.
 */

export function defaultEnvFilePath(): string {
  return process.env.VP_ENV_FILE || path.join(os.homedir(), '.config', 'veneer-pro', 'env');
}

/** Returns the names it set, for a lifecycle log line. Never logs values. */
export function loadEnvFile(file: string = defaultEnvFilePath()): string[] {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // No env file is normal in dev and in tests.
  }

  const applied: string[] = [];
  for (const line of contents.split('\n')) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (process.env[parsed.key] !== undefined) continue;
    process.env[parsed.key] = parsed.value;
    applied.push(parsed.key);
  }
  return applied;
}

function parseLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
  if (!match) return null;
  let value = match[2]!.trim();
  if (value.startsWith('"')) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      return null;
    }
  } else {
    const quoted = /^'([\s\S]*)'$/.exec(value);
    if (quoted) value = quoted[1]!;
  }
  return { key: match[1]!, value };
}
