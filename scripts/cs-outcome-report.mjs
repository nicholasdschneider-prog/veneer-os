#!/usr/bin/env node
// Prints the customer service outcome and readiness measurement as JSON.
// Read-only: the database is opened read-only and nothing is sent or changed.
//
//   node scripts/cs-outcome-report.mjs --business <id> --since 2026-09-22T00:00:00Z --until 2026-09-29T00:00:00Z
//
// Requires a built server (npm run build -w @veneer-pro/server).

import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const Database = require('better-sqlite3');
const { csOutcomes } = await import('../server/dist/bots/csOutcomes.js');

const { values } = parseArgs({ options: { business: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, subteam: { type: 'string' } } });
if (!values.business || !values.since || !values.until) {
  console.error('Usage: cs-outcome-report.mjs --business <id> --since <ISO> --until <ISO> [--subteam <name>]');
  process.exit(2);
}
const dataDir = process.env.DATA_DIR
  ? process.env.DATA_DIR.startsWith('~') ? path.join(os.homedir(), process.env.DATA_DIR.slice(1)) : process.env.DATA_DIR
  : path.join(os.homedir(), '.local', 'share', 'veneer-pro');
const db = new Database(path.join(dataDir, 'veneer-pro.db'), { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
try {
  const report = csOutcomes(db).report({ business_id: values.business, since: values.since, until: values.until, ...(values.subteam ? { subteam: values.subteam } : {}) });
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
}
