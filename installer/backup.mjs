#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const codeDir = path.resolve(here, '..');

loadEnvFile(process.env.VP_ENV_FILE || path.join(os.homedir(), '.config', 'veneer-pro', 'env'));

export function backupsToRemove(entries, keep) {
  return [...entries]
    .filter((entry) => /^veneer-pro-\d{8}T\d{6}Z\.tar\.gz$/.test(entry.name))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(keep)
    .map((entry) => entry.name);
}

export async function createBackup({
  dataDir = process.env.DATA_DIR || path.join(os.homedir(), '.local', 'share', 'veneer-pro'),
  backupDir = process.env.VP_BACKUP_DIR || path.join(os.homedir(), '.local', 'share', 'veneer-pro-backups'),
  keep = Number(process.env.VP_BACKUP_KEEP || 7),
  now = new Date(),
} = {}) {
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 100) throw new Error('VP_BACKUP_KEEP must be from 1 to 100.');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-backup-'));
  const stagedData = path.join(workDir, 'data');
  const archive = path.join(backupDir, `veneer-pro-${stamp}.tar.gz`);
  const excluded = new Set([
    'veneer-pro.db',
    'veneer-pro.db-wal',
    'veneer-pro.db-shm',
    'doppler.json',
    'hub-keyring.json',
  ]);
  try {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(stagedData, { recursive: true, mode: 0o700 });
    const dbFile = path.join(dataDir, 'veneer-pro.db');
    if (fs.existsSync(dbFile)) {
      const require = createRequire(path.join(codeDir, 'server', 'package.json'));
      const Database = require('better-sqlite3');
      const db = new Database(dbFile, { readonly: true });
      try {
        await db.backup(path.join(stagedData, 'veneer-pro.db'));
      } finally {
        db.close();
      }
    }
    if (fs.existsSync(dataDir)) {
      for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
        if (excluded.has(entry.name) || entry.name.startsWith('.hub-keyring.') && entry.name.endsWith('.tmp')) continue;
        fs.cpSync(path.join(dataDir, entry.name), path.join(stagedData, entry.name), {
          recursive: true,
          preserveTimestamps: true,
          dereference: false,
        });
      }
    }
    execFileSync('tar', ['-C', workDir, '-czf', archive, 'data'], { stdio: 'ignore' });
    fs.chmodSync(archive, 0o600);
    const entries = fs.readdirSync(backupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, mtimeMs: fs.statSync(path.join(backupDir, entry.name)).mtimeMs }));
    for (const name of backupsToRemove(entries, keep)) fs.rmSync(path.join(backupDir, name), { force: true });
    return archive;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createBackup()
    .then((archive) => process.stdout.write(`${archive}\n`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
