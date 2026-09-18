import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

// Applying a migration can take a while, and every other service booting at the
// same moment waits behind it. The connection's normal busy_timeout (5s) is
// sized for ordinary queries, so raise it for the migration loop only — a
// waiter that gives up would crash-loop its whole service on first boot.
const MIGRATION_BUSY_TIMEOUT_MS = 60_000;

/**
 * Numbered .sql migration runner (ported from Veneer's services/db.js concept).
 * Files named NNNN_name.sql run in lexical order, each in a transaction,
 * recorded in the `migrations` table.
 *
 * All four services call this at boot against the same file, so on a fresh
 * install they migrate concurrently. Each file is therefore applied inside a
 * BEGIN IMMEDIATE transaction that takes SQLite's write lock BEFORE re-reading
 * whether the file is already recorded: the first process in applies it, and
 * the others — which queued on that lock — then see the row and skip. A plain
 * deferred transaction reads before it locks, so two processes could both find
 * a file unapplied and both run it (observed as "duplicate column name" on a
 * first boot). The database is the lock; no extra lock file is involved.
 */
export function migrate(db: Database.Database, migrationsDir: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  ensureContentHashColumn(db);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  checkDrift(db, migrationsDir, files);
  // Cheap pre-filter so an already-migrated boot (the normal case) takes no
  // write lock at all. Anything it lists is re-checked under the lock below.
  const applied = new Set(
    (db.prepare('SELECT name FROM migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) return;

  const previousBusyTimeout = db.pragma('busy_timeout', { simple: true }) as number;
  db.pragma(`busy_timeout = ${MIGRATION_BUSY_TIMEOUT_MS}`);
  try {
    applyPending(db, migrationsDir, pending);
  } finally {
    db.pragma(`busy_timeout = ${previousBusyTimeout}`);
  }
}

function contentHash(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

function ensureContentHashColumn(db: Database.Database): void {
  const columns = db.pragma('table_info(migrations)') as { name: string }[];
  if (!columns.some((c) => c.name === 'content_hash')) {
    // Several services can observe the legacy schema together. Recheck after
    // taking the write lock, just as applyPending does for numbered migrations.
    db.transaction(() => {
      const fresh = db.pragma('table_info(migrations)') as { name: string }[];
      if (!fresh.some((c) => c.name === 'content_hash')) {
        db.exec('ALTER TABLE migrations ADD COLUMN content_hash TEXT');
      }
    }).immediate();
  }
}

/**
 * Editing a migration file after it has been applied is a silent schema-drift
 * hazard: the recorded copy already ran, so the edits never execute here, and
 * code shipped against the edited version fails much later with confusing
 * errors (seen 2026-08-13: conversation_wakeups missing a column added to an
 * already-applied 0080). Warn loudly rather than throw — refusing to boot would
 * take down fleet clients over a legitimately amended old migration.
 */
function checkDrift(db: Database.Database, migrationsDir: string, files: string[]): void {
  const recorded = new Map(
    (db.prepare('SELECT name, content_hash FROM migrations').all() as {
      name: string;
      content_hash: string | null;
    }[]).map((r) => [r.name, r.content_hash]),
  );
  const backfill = db.prepare('UPDATE migrations SET content_hash = ? WHERE name = ? AND content_hash IS NULL');
  for (const file of files) {
    if (!recorded.has(file)) continue;
    let hash: string;
    try {
      hash = contentHash(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    } catch {
      continue;
    }
    const known = recorded.get(file);
    if (known === null || known === undefined) {
      // Applied before hashes existed: trust the current file once.
      backfill.run(hash, file);
    } else if (known !== hash) {
      console.error(
        [
          '='.repeat(72),
          `[migrate] DRIFT: ${file} was edited after being applied on this machine.`,
          '[migrate] The recorded copy differs; its later edits never ran here.',
          '[migrate] Create a NEW numbered migration for the change.',
          '='.repeat(72),
        ].join('\n'),
      );
    }
  }
}

function applyPending(db: Database.Database, migrationsDir: string, pending: string[]): void {
  const isApplied = db.prepare('SELECT 1 FROM migrations WHERE name = ?');
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // Table-rebuild migrations DROP/recreate a table. With foreign_keys ON,
    // dropping a parent table cascade-deletes child rows (ON DELETE CASCADE)
    // before the data is re-inserted. Per SQLite's recommended table-rebuild
    // pattern we disable FK enforcement around each migration. `PRAGMA
    // foreign_keys` is a no-op inside a transaction, so it must be toggled
    // outside the transaction, then restored (in finally, so an error can't
    // leave FKs off). A post-migration foreign_key_check catches any migration
    // that genuinely left dangling references.
    const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
    db.pragma('foreign_keys = OFF');
    let ranHere = false;
    try {
      // .immediate() = BEGIN IMMEDIATE: the write lock is held before the
      // isApplied check, so a process that queued here sees the winner's row
      // and skips instead of applying the same file a second time.
      const run = db.transaction(() => {
        if (isApplied.get(file)) return false;
        db.exec(sql);
        db.prepare('INSERT INTO migrations (name, content_hash) VALUES (?, ?)').run(file, contentHash(sql));
        return true;
      });
      ranHere = run.immediate() as boolean;
    } finally {
      if (fkWasOn) db.pragma('foreign_keys = ON');
    }
    // Only the process that applied the file checks it. The others already
    // waited on the lock and would just repeat the winner's work.
    if (!ranHere) continue;
    // With enforcement restored, verify the migration didn't leave dangling
    // references; a genuinely broken migration is caught here rather than
    // silently corrupting data.
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new Error(`Migration ${file} left foreign key violations: ${JSON.stringify(violations)}`);
    }
  }
}
