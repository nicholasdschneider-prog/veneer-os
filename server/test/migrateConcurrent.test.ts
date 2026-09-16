import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(here, '..');
const CHILD = path.join(here, 'migrateConcurrent.child.ts');
const CHILD_COUNT = 5;

// ALTER TABLE ADD COLUMN is the exact shape that failed on a first boot: the
// second process to run it reports "duplicate column name".
//
// The first file is deliberately slow. The winner then holds the write lock
// long enough for the other processes to read "nothing applied yet" before it
// commits — which is the race. With a fast first file they mostly finish one
// after another and the test proves nothing.
const MIGRATIONS = {
  '0001_widget.sql': `
    CREATE TABLE widget (id INTEGER PRIMARY KEY);
    CREATE TABLE bulk (i INTEGER);
    INSERT INTO bulk (i)
      WITH RECURSIVE counter(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM counter WHERE i < 400000)
      SELECT i FROM counter;
  `,
  '0002_widget_pin_order.sql': 'ALTER TABLE widget ADD COLUMN pin_order INTEGER;',
  '0003_widget_label.sql': 'ALTER TABLE widget ADD COLUMN label TEXT;',
};

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function migrationsDir(): string {
  const dir = tempDir('veneer-migrate-conc-');
  for (const [name, sql] of Object.entries(MIGRATIONS)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

async function waitFor(predicate: () => boolean, message: string, budgetMs = 60_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function childStderrNoise(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => {
      const text = line.trim();
      return text && !/NO_COLOR|trace-warnings/i.test(text);
    })
    .join('\n')
    .trim();
}

function runChild(dataDir: string, migrations: string, barrier: string) {
  // --import tsx: the child runs the real TypeScript source, so this exercises
  // openDb/migrate exactly as a booting service does.
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, dataDir, migrations, barrier], {
    cwd: serverDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('concurrent first boot', () => {
  it('lets every service migrate the same fresh database at once', async () => {
    const dataDir = tempDir('veneer-migrate-data-');
    const migrations = migrationsDir();
    const barrier = path.join(dataDir, 'go');

    const children = Array.from({ length: CHILD_COUNT }, () => runChild(dataDir, migrations, barrier));
    // Release them together, once every child has announced it reached its wait
    // loop. A fixed sleep here is a guess at how long `node --import tsx` takes
    // to boot, and when the suite loads the machine that guess runs short: the
    // stragglers then arrive after the winner has already finished and the
    // concurrency this test exists to exercise never happens.
    await waitFor(
      () => fs.readdirSync(dataDir).filter((name) => name.startsWith('go.ready.')).length === CHILD_COUNT,
      'not every migrating child reached the barrier',
    );
    fs.writeFileSync(barrier, 'go');
    const results = await Promise.all(children);

    for (const result of results) {
      expect(result.code, `child exited ${result.code}: ${result.stderr}`).toBe(0);
      expect(childStderrNoise(result.stderr)).toBe('');
    }
    // Every child sees the full set of migrations, each applied exactly once.
    for (const result of results) {
      const seen = JSON.parse(result.stdout) as { names: string[]; columns: string[] };
      expect(seen.names).toEqual(Object.keys(MIGRATIONS));
      expect(seen.columns).toEqual(['id', 'pin_order', 'label']);
    }

    const db = new Database(path.join(dataDir, 'veneer-pro.db'));
    const rows = db.prepare('SELECT name, COUNT(*) AS n FROM migrations GROUP BY name').all() as {
      name: string;
      n: number;
    }[];
    db.close();
    expect(rows.map((row) => row.n)).toEqual([1, 1, 1]);
  }, 180_000);

  it('skips a file another connection already recorded', () => {
    const dataDir = tempDir('veneer-migrate-raced-');
    const migrations = migrationsDir();
    const file = path.join(dataDir, 'veneer-pro.db');

    const winner = new Database(file);
    migrate(winner, migrations);
    winner.close();

    // The loser of the race reaches the apply step with the file already
    // recorded. Re-running it would throw "duplicate column name".
    const loser = new Database(file);
    expect(() => migrate(loser, migrations)).not.toThrow();
    const columns = (loser.pragma('table_info(widget)') as { name: string }[]).map((c) => c.name);
    loser.close();

    expect(columns).toEqual(['id', 'pin_order', 'label']);
  });

  it('still applies a pending migration when the table already exists', () => {
    const dataDir = tempDir('veneer-migrate-partial-');
    const migrations = migrationsDir();
    const file = path.join(dataDir, 'veneer-pro.db');

    const first = new Database(file);
    migrate(first, migrations);
    first.close();

    // A later release adds a migration: the already-migrated fast path must not
    // swallow it.
    fs.writeFileSync(path.join(migrations, '0004_widget_note.sql'), 'ALTER TABLE widget ADD COLUMN note TEXT;');
    const second = new Database(file);
    migrate(second, migrations);
    const columns = (second.pragma('table_info(widget)') as { name: string }[]).map((c) => c.name);
    second.close();

    expect(columns).toEqual(['id', 'pin_order', 'label', 'note']);
  });
});
