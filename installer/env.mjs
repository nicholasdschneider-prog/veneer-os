import fs from 'node:fs';
import path from 'node:path';

export function parseEnv(contents) {
  const values = {};
  for (const line of String(contents ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        continue;
      }
    } else {
      const quoted = /^'([\s\S]*)'$/.exec(value);
      if (quoted) value = quoted[1];
    }
    values[match[1]] = value;
  }
  return values;
}

export function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function loadEnvFile(file, { override = false } = {}) {
  const values = readEnvFile(file);
  for (const [key, value] of Object.entries(values)) {
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
  return values;
}

export function formatEnv(values) {
  return `${Object.entries(values)
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join('\n')}\n`;
}

export function writeEnvFile(file, values, { fsImpl = fs } = {}) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(temp, formatEnv(values), { mode: 0o600 });
  fsImpl.chmodSync(temp, 0o600);
  fsImpl.renameSync(temp, file);
}

/**
 * Append-or-replace a handful of keys in a shell-style env file, leaving every
 * other line (comments, ordering, unrelated keys) exactly as it was.
 *
 * `onlyIfMissing` is for values the operator is allowed to override: the key is
 * written only when the file does not already define it with a non-empty value.
 * `mode` is applied on every write, not just on create, so a re-install cannot
 * silently keep wider permissions on a file that holds a bearer token.
 */
export function upsertEnvValues(file, values, { onlyIfMissing = false, mode } = {}) {
  let contents = '';
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const existing = parseEnv(contents);
  const updates = new Map(
    Object.entries(values).filter(([key]) => !onlyIfMissing || !existing[key]),
  );
  const seen = new Set();
  const lines = contents
    .split('\n')
    .filter((line) => {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (!match || !updates.has(match[1])) return true;
      // Keep the first occurrence as the slot to rewrite; drop later duplicates.
      if (seen.has(match[1])) return false;
      seen.add(match[1]);
      return true;
    })
    .map((line) => {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return match && updates.has(match[1])
        ? `${match[1]}=${JSON.stringify(String(updates.get(match[1])))}`
        : line;
    });
  // Trailing blank lines are an artifact of the file's final newline; appending
  // after them would grow a gap on every install.
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  for (const [key, value] of updates) {
    if (!seen.has(key)) lines.push(`${key}=${JSON.stringify(String(value))}`);
  }
  const body = lines.join('\n');
  fs.writeFileSync(file, `${body}\n`, mode === undefined ? undefined : { mode });
  if (mode !== undefined) fs.chmodSync(file, mode);
}

/**
 * Preflight the env file the installer is about to hand the services.
 *
 * `server/src/config.ts` rejects VP_IDENTITY=cloudflare without both Access
 * settings, but it only does so once launchd has already started the web
 * service — which surfaces as a service that boot-loops minutes after a
 * "successful" install. Checking the same rule here fails the install itself,
 * while the operator is still at the terminal.
 *
 * Pure: takes the parsed env values, returns what is wrong. Callers decide
 * whether to exit.
 */
export function validateInstallEnv(values = {}) {
  const problems = [];
  const warnings = [];
  const get = (key) => {
    const value = values[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  // Unset means cloudflare: that is the schema default, so an env file that
  // simply never mentions VP_IDENTITY still needs the Access settings.
  const identity = get('VP_IDENTITY') || 'cloudflare';
  if (identity === 'cloudflare') {
    const missing = ['VP_CF_TEAM_DOMAIN', 'VP_CF_AUD'].filter((key) => !get(key));
    if (missing.length) {
      problems.push(
        `VP_IDENTITY=${get('VP_IDENTITY') ? 'cloudflare' : 'cloudflare (unset, the default)'} `
          + `requires ${missing.join(' and ')}. Set ${missing.length > 1 ? 'them' : 'it'} to the `
          + 'Cloudflare Access team domain (e.g. your-team.cloudflareaccess.com) and the '
          + 'application AUD tag from the Access application, or set VP_IDENTITY=dev to run '
          + 'this Mac without Access.',
      );
    }
  }
  if (!get('DATA_DIR')) {
    warnings.push('DATA_DIR is unset — the database and uploads will land in the built-in default path.');
  }
  if (!get('VP_SOURCE_DIR')) {
    warnings.push('VP_SOURCE_DIR is unset — agents will fall back to the default workspace root.');
  }
  return { problems, warnings };
}
