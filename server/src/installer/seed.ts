import path from 'node:path';
import { openDb } from '../db/db.js';

interface Args {
  dataDir: string;
  ownerEmail: string;
  ownerName: string;
  consultants: Array<{ email: string; name: string }>;
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near ${flag ?? 'end'}.`);
    const key = flag.slice(2);
    values.set(key, [...(values.get(key) ?? []), value]);
  }

  const ownerEmail = required(values.get('owner-email')?.at(-1), '--owner-email').toLowerCase();
  const consultants = (values.get('consultant') ?? []).map((entry) => {
    const separator = entry.indexOf(':');
    if (separator < 1) throw new Error('--consultant must use email:display-name.');
    return { email: entry.slice(0, separator).trim().toLowerCase(), name: entry.slice(separator + 1).trim() };
  });
  return {
    dataDir: path.resolve(required(values.get('data-dir')?.at(-1), '--data-dir')),
    ownerEmail,
    ownerName: required(values.get('owner-name')?.at(-1), '--owner-name'),
    consultants: consultants.filter((entry) => entry.email !== ownerEmail),
  };
}

const args = parseArgs(process.argv.slice(2));
const db = openDb(args.dataDir);
const upsert = db.prepare(`
  INSERT INTO users (email, display_name, role, status)
  VALUES (?, ?, ?, 'active')
  ON CONFLICT(email) DO UPDATE SET
    display_name = excluded.display_name,
    role = excluded.role,
    status = 'active'
`);

const seed = db.transaction(() => {
  upsert.run(args.ownerEmail, args.ownerName, 'owner');
  for (const consultant of args.consultants) upsert.run(consultant.email, consultant.name, 'consultant');
});

try {
  seed();
  process.stdout.write(`Seeded owner and ${args.consultants.length} consultant account(s).\n`);
} finally {
  db.close();
}
