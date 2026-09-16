// Child process for migrateConcurrent.test.ts: one service booting. It waits
// for the barrier file so every child opens the same fresh database at
// effectively the same moment, which is what a first boot of all four services
// does.
import fs from 'node:fs';
import { openDb } from '../src/db/db.js';

const [dataDir, migrationsDir, barrier] = process.argv.slice(2) as [string, string, string];

// Tell the parent this process is loaded and about to spin, so it can release
// every child the moment the slowest one is ready instead of guessing at a
// sleep. Under a loaded machine `node --import tsx` can take seconds to get
// here, and a parent that guesses short releases the barrier before the
// stragglers exist — they then migrate alone and the test proves nothing.
fs.writeFileSync(`${barrier}.ready.${process.pid}`, '');

const deadline = Date.now() + 120_000;
while (!fs.existsSync(barrier)) {
  if (Date.now() > deadline) throw new Error('barrier never appeared');
  // Busy-wait: this file must not import anything async before openDb, or the
  // children stop overlapping and the test stops testing anything.
}

const db = openDb(dataDir, migrationsDir);
const names = (db.prepare('SELECT name FROM migrations ORDER BY name').all() as { name: string }[]).map(
  (row) => row.name,
);
const columns = (db.pragma('table_info(widget)') as { name: string }[]).map((column) => column.name);
db.close();
process.stdout.write(JSON.stringify({ names, columns }));
