#!/usr/bin/env node
// Encrypted offsite copy of the newest nightly backup to Cloudflare R2.
// age encrypts on this Mac with a public key; the private key lives only in
// Doppler, so this Mac cannot decrypt its own offsite copies. Runs as its own
// launchd job: any failure here never touches the local backups.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';

export const ARCHIVE_RE = /^veneer-pro-\d{8}T\d{6}Z\.tar\.gz$/;
const OBJECT_RE = /^veneer-pro-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.tar\.gz\.age$/;
const SETTLE_MS = 2 * 60 * 1000;
const HISTORY = 40;
const SECRET_KEYS = ['VP_BACKUP_OFFSITE_ACCESS_KEY_ID', 'VP_BACKUP_OFFSITE_SECRET_ACCESS_KEY'];
const REQUIRED = ['VP_BACKUP_OFFSITE_ACCOUNT_ID', ...SECRET_KEYS, 'VP_BACKUP_OFFSITE_AGE_RECIPIENT'];
const bin = (name) => [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].find((file) => fs.existsSync(file)) ?? name;

export function readConfig(env = process.env) {
  const backupDir = env.VP_BACKUP_DIR || path.join(os.homedir(), '.local', 'share', 'veneer-pro-backups');
  return {
    missing: REQUIRED.filter((key) => !env[key]),
    backupDir,
    bucket: env.VP_BACKUP_OFFSITE_BUCKET || 'veneer-backups',
    accountId: env.VP_BACKUP_OFFSITE_ACCOUNT_ID,
    accessKeyId: env.VP_BACKUP_OFFSITE_ACCESS_KEY_ID,
    secretAccessKey: env.VP_BACKUP_OFFSITE_SECRET_ACCESS_KEY,
    recipient: env.VP_BACKUP_OFFSITE_AGE_RECIPIENT,
    statePath: env.VP_BACKUP_OFFSITE_STATE || path.join(backupDir, 'offsite-state.json'),
  };
}

/** Newest archive by name, ignoring anything modified in the last two minutes (still being written). */
export function pickNewestArchive(entries, now = Date.now()) {
  return entries
    .filter((entry) => ARCHIVE_RE.test(entry.name) && now - entry.mtimeMs >= SETTLE_MS)
    .map((entry) => entry.name)
    .sort()
    .at(-1) ?? null;
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return `${d.getUTCFullYear()}-W${Math.ceil(((d - yearStart) / 86400000 + 1) / 7)}`;
}

/** Offsite objects to delete: keep the newest `daily`, then the newest of each of the next `weekly` ISO weeks. */
export function offsiteToRemove(objectNames, { daily = 7, weekly = 4 } = {}) {
  const dated = objectNames
    .map((name) => ({ name, match: OBJECT_RE.exec(name) }))
    .filter(({ match }) => match)
    .map(({ name, match: m }) => ({ name, at: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) }))
    .sort((a, b) => b.at - a.at);
  const keep = new Set(dated.slice(0, daily).map((o) => o.name));
  const weeks = new Set();
  for (const object of dated.slice(daily)) {
    const week = isoWeek(object.at);
    if (weeks.has(week)) continue;
    if (weeks.size >= weekly) break;
    weeks.add(week);
    keep.add(object.name);
  }
  return dated.filter((o) => !keep.has(o.name)).map((o) => o.name);
}

export function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(file, state) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function redact(message, config) {
  let text = String(message ?? '').slice(0, 500);
  for (const value of [config.accessKeyId, config.secretAccessKey]) if (value) text = text.split(value).join('[redacted]');
  return text;
}

function rcloneEnv(config) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: os.homedir(),
    RCLONE_S3_PROVIDER: 'Cloudflare',
    RCLONE_S3_ACCESS_KEY_ID: config.accessKeyId,
    RCLONE_S3_SECRET_ACCESS_KEY: config.secretAccessKey,
    RCLONE_S3_ENDPOINT: `https://${config.accountId}.r2.cloudflarestorage.com`,
    RCLONE_S3_REGION: 'auto',
    RCLONE_S3_NO_CHECK_BUCKET: 'true',
    RCLONE_S3_CHUNK_SIZE: '64M',
    // Daytime uploads must not saturate the uplink the public tunnel shares.
    RCLONE_BWLIMIT: process.env.VP_BACKUP_OFFSITE_BWLIMIT || '06:00,2M 23:00,off',
  };
}

function exited(child, name) {
  let stderr = '';
  child.stderr?.on('data', (chunk) => { if (stderr.length < 2000) stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}: ${stderr.trim()}`))));
  });
}

/** The real command layer: streams age -> rclone rcat, and the rclone list/delete calls. */
export function realCommands(config) {
  const env = rcloneEnv(config);
  const rclone = (args) => new Promise((resolve, reject) => {
    execFile(bin('rclone'), args, { env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`rclone ${args[0]} failed: ${String(stderr || error.message).trim()}`));
      else resolve(stdout);
    });
  });
  return {
    async upload(archive, remote) {
      const age = spawn(bin('age'), ['-r', config.recipient, archive], { env: { PATH: env.PATH, HOME: env.HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
      const rcat = spawn(bin('rclone'), ['rcat', remote], { env, stdio: ['pipe', 'ignore', 'pipe'] });
      const hash = createHash('sha256');
      let bytes = 0;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await Promise.all([pipeline(age.stdout, meter, rcat.stdin), exited(age, 'age'), exited(rcat, 'rclone rcat')]);
      } catch (error) {
        age.kill();
        rcat.kill();
        throw error;
      }
      return { bytes, sha256: hash.digest('hex') };
    },
    async lsjson(remote) {
      return JSON.parse(await rclone(['lsjson', remote]) || '[]');
    },
    async deleteFile(remote) {
      await rclone(['deletefile', remote]);
    },
  };
}

function pushHistory(state, entry) {
  return [...(state?.history ?? []), entry].slice(-HISTORY);
}

/** One offsite run. Returns { status: 'uploaded' | 'skipped' | 'not_configured' | 'error', ... }. */
export async function runOffsite({
  env = process.env,
  now = Date.now(),
  commands = null,
  log = (line) => console.log(line),
} = {}) {
  const config = readConfig(env);
  const previous = readState(config.statePath) ?? { lastUploaded: null, lastError: null, history: [] };
  const at = new Date(now).toISOString();
  const fail = (message, status = 'error') => {
    const clean = redact(message, config);
    log(`backup-offsite: ${clean}`);
    try {
      writeState(config.statePath, { ...previous, lastError: { at, message: clean }, history: pushHistory(previous, { at, ok: false, message: clean }) });
    } catch { /* the backup dir itself may be unavailable */ }
    return { status, message: clean };
  };
  if (config.missing.length) return fail(`not configured; missing ${config.missing.join(', ')}`, 'not_configured');

  let entries;
  try {
    entries = fs.readdirSync(config.backupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, mtimeMs: fs.statSync(path.join(config.backupDir, entry.name)).mtimeMs }));
  } catch (error) {
    return fail(`cannot read backup directory: ${error.message}`);
  }
  const name = pickNewestArchive(entries, now);
  if (!name) return fail('no finished backup archive found');
  if (previous.lastUploaded?.name === name) return { status: 'skipped', name };

  const objectName = `${name}.age`;
  const remote = `:s3:${config.bucket}/${objectName}`;
  const run = commands ?? realCommands(config);
  let uploaded;
  try {
    uploaded = await run.upload(path.join(config.backupDir, name), remote);
    const [listed] = await run.lsjson(remote);
    if (!listed || listed.Size !== uploaded.bytes) {
      throw new Error(`verify failed: remote size ${listed?.Size ?? 'missing'}, sent ${uploaded.bytes} bytes`);
    }
  } catch (error) {
    return fail(`upload of ${name} failed: ${error.message}`);
  }
  const lastUploaded = { name, object: objectName, bytes: uploaded.bytes, sha256: uploaded.sha256, at };
  let state = { lastUploaded, lastError: null, history: pushHistory(previous, { at, ok: true, name, bytes: uploaded.bytes }) };
  writeState(config.statePath, state);
  log(`backup-offsite: uploaded ${objectName} (${uploaded.bytes} bytes) and verified`);

  try {
    const objects = (await run.lsjson(`:s3:${config.bucket}`)).map((entry) => entry.Name ?? entry.Path);
    for (const old of offsiteToRemove(objects).filter((object) => object !== objectName)) {
      await run.deleteFile(`:s3:${config.bucket}/${old}`);
      log(`backup-offsite: retention removed ${old}`);
    }
  } catch (error) {
    const message = redact(`retention failed after a verified upload: ${error.message}`, config);
    state = { ...state, lastError: { at, message } };
    writeState(config.statePath, state);
    log(`backup-offsite: ${message}`);
    return { status: 'error', message, name };
  }
  return { status: 'uploaded', name, bytes: uploaded.bytes };
}

export function statusSummary(state) {
  if (!state) return { name: null, at: null, bytes: null, lastError: null };
  const { name = null, at = null, bytes = null } = state.lastUploaded ?? {};
  return { name, at, bytes, lastError: state.lastError ?? null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFile(process.env.VP_ENV_FILE || path.join(os.homedir(), '.config', 'veneer-pro', 'env'));
  if (process.argv.includes('--status')) {
    console.log(JSON.stringify(statusSummary(readState(readConfig().statePath)), null, 2));
  } else {
    runOffsite()
      .then((result) => process.exit(result.status === 'error' ? 1 : 0))
      .catch((error) => {
        console.error(`backup-offsite: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
  }
}
