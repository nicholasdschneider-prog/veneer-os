#!/usr/bin/env node
// Remove duplicate search documents left by history renames before 9b66b7f.
//
//   node scripts/dedupe-search-documents.mjs            # dry run: counts only
//   node scripts/dedupe-search-documents.mjs --apply    # delete in small batches
//
// A duplicate is a document with the same chat, kind, time and text as another.
// One row per group stays: the one whose id the current indexer produces (so the
// next index pass finds it and writes nothing), else the newest. Search documents
// are derived from chat history, so nothing here is source data. Deletes run in
// transactions of BATCH rows with pauses, so the write lock is never held long;
// the table's delete trigger keeps the full-text index in sync.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const Database = require('better-sqlite3');
const apply = process.argv.includes('--apply');
const BATCH = 500;
const PAUSE_MS = 250;
const dataDir = (process.env.DATA_DIR ?? path.join(os.homedir(), '.local/share/veneer-pro')).replace(/^~/, os.homedir());
const db = new Database(path.join(dataDir, 'veneer-pro.db'), apply ? {} : { readonly: true });
db.pragma('busy_timeout = 5000');

const NAMESPACE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:)+/i;
/** The id indexConversation gives this message today, from the anchor in its link. */
function currentId(row) {
  const match = /[?&]message=([^&]+)$/.exec(row.href ?? '');
  if (!match) return null;
  let anchor;
  try { anchor = JSON.parse(decodeURIComponent(match[1]).replace(/^search:/, '')); } catch { return null; }
  if (!anchor || typeof anchor.turn !== 'string') return null;
  const stable = JSON.stringify({ turn: anchor.turn.replace(NAMESPACE, ''), role: anchor.role, at: anchor.at });
  return crypto.createHash('sha256').update(row.conversation_id + stable + row.body).digest('hex');
}

const groups = new Map();
let total = 0;
for (const row of db.prepare("SELECT rowid AS rid, id, conversation_id, kind, at, href, body FROM bot_search_documents WHERE kind IN ('user','assistant')").iterate()) {
  total += 1;
  const key = `${row.conversation_id}\u0000${row.kind}\u0000${row.at}\u0000${crypto.createHash('sha1').update(row.body).digest('hex')}`;
  const list = groups.get(key);
  const slim = { rid: row.rid, id: row.id, want: null, conversation_id: row.conversation_id, href: row.href, body: row.body };
  if (list) list.push(slim); else groups.set(key, [slim]);
}
const doomed = [];
const byChat = new Map();
for (const list of groups.values()) {
  if (list.length < 2) { list.length = 0; continue; }
  const want = currentId(list[0]);
  const keep = list.find((r) => r.id === want) ?? list.reduce((a, b) => (b.rid > a.rid ? b : a));
  for (const r of list) if (r !== keep) {
    doomed.push(r.rid);
    byChat.set(r.conversation_id, (byChat.get(r.conversation_id) ?? 0) + 1);
  }
}
console.log(`message documents ${total}, groups ${groups.size}, duplicates to delete ${doomed.length}`);
console.log('largest:', [...byChat].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c.slice(0, 8)} ${n}`).join(', '));
if (!apply) { console.log('dry run: nothing deleted (pass --apply)'); process.exit(0); }

const del = db.prepare('DELETE FROM bot_search_documents WHERE rowid = ?');
const batch = db.transaction((ids) => { for (const id of ids) del.run(id); });
let done = 0;
let slowest = 0;
for (let i = 0; i < doomed.length; i += BATCH) {
  const started = performance.now();
  batch(doomed.slice(i, i + BATCH));
  slowest = Math.max(slowest, performance.now() - started);
  done = Math.min(doomed.length, i + BATCH);
  if (done % 20_000 < BATCH) console.log(`deleted ${done}/${doomed.length}`);
  await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
}
console.log(`deleted ${done}; slowest batch ${Math.round(slowest)} ms`);
