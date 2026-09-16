#!/usr/bin/env node
// One-off backfill for conversations.origin_conversation_id (migration 0035).
//
// Chats created by the handoff tool before the column existed still carry the
// parentage in their transcript: the first user message ends with
// "[Handoff] … Origin chat id: <uuid>". Native session files are named
// <native_session_id>.jsonl across all providers, so for each unstamped chat we
// locate its file, scan the head of it for that marker, and stamp the column
// when the referenced origin chat still exists.
//
// Safe to re-run: only touches rows where origin_conversation_id IS NULL.
// DRY_RUN=1 prints what would change without writing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dataDir = process.env.DATA_DIR
  ? process.env.DATA_DIR.startsWith('~')
    ? path.join(os.homedir(), process.env.DATA_DIR.slice(1))
    : process.env.DATA_DIR
  : path.join(os.homedir(), '.local', 'share', 'veneer-pro');
const DRY_RUN = process.env.DRY_RUN === '1';

const db = new Database(path.join(dataDir, 'veneer-pro.db'));
db.pragma('busy_timeout = 5000');

const cols = db.pragma('table_info(conversations)').map((c) => c.name);
if (!cols.includes('origin_conversation_id')) {
  console.error('origin_conversation_id column missing — run migration 0035 first (restart web).');
  process.exit(1);
}

// Session-file roots: Claude CLI keeps per-cwd project dirs; the OpenRouter
// checkout mirrors that layout under the data dir; Codex transcripts are flat.
const roots = [
  path.join(os.homedir(), '.claude', 'projects'),
  path.join(dataDir, 'claude-openrouter', 'projects'),
  path.join(dataDir, 'codex-transcripts'),
  path.join(dataDir, 'codex-app-server-transcripts'),
];

// sessionId → file path, one recursive walk.
const sessionFiles = new Map();
function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) sessionFiles.set(e.name.slice(0, -'.jsonl'.length), p);
  }
}
for (const root of roots) walk(root);

// The marker sits in the chat's FIRST user message, so the head of the file is
// enough; 256 KiB comfortably covers big pasted tasks without reading whole logs.
function findOriginId(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, n);
    const m = /\[Handoff\][^]{0,500}?Origin chat id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(head);
    return m ? m[1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const rows = db
  .prepare('SELECT id, native_session_id, title FROM conversations WHERE origin_conversation_id IS NULL')
  .all();
const exists = db.prepare('SELECT 1 FROM conversations WHERE id = ?');
const stamp = db.prepare('UPDATE conversations SET origin_conversation_id = ? WHERE id = ?');

let stamped = 0;
let orphaned = 0;
for (const row of rows) {
  const file = sessionFiles.get(row.native_session_id);
  if (!file) continue;
  const origin = findOriginId(file);
  if (!origin || origin === row.id) continue;
  if (!exists.get(origin)) {
    orphaned++;
    continue;
  }
  console.log(`${DRY_RUN ? '[dry] ' : ''}${row.id}  ←  ${origin}  (${(row.title ?? '').slice(0, 60)})`);
  if (!DRY_RUN) stamp.run(origin, row.id);
  stamped++;
}
console.log(`${DRY_RUN ? 'Would stamp' : 'Stamped'} ${stamped} chat(s); ${orphaned} had a deleted origin (left alone).`);
