#!/usr/bin/env node
// Read-only before/after report for the token governor.
//
//   node scripts/token-governor-report.mjs --since 2026-10-31 --until 2026-11-03 [--bots id,id] [--json]
//
// "Before" days come from Veneer's Codex transcripts (turn_done usage), walking
// each chat's fork ancestry; "after" days come from the turn_token_usage ledger
// and token_governor_events. Turn latency is first turn_started to text_final.
// Nothing is written.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const dataDir = process.env.DATA_DIR
  ? process.env.DATA_DIR.replace(/^~/, os.homedir())
  : path.join(os.homedir(), '.local/share/veneer-pro');
const since = arg('since', new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10));
const until = arg('until', new Date().toISOString().slice(0, 10));
const source = arg('source', 'auto'); // transcripts | ledger | auto
const STAGE_1 = [
  '1dcb56c5-be80-43c9-9b68-2817b931ecda', '7f83ff8e-43a3-4c16-b2bd-c304dd946d11',
  'f4131f81-27c5-4332-902a-a0d9873dfeb9', 'a6a9b2d4-384c-423a-a2fa-4f623aaeeb98',
];
const botIds = (arg('bots', STAGE_1.join(','))).split(',').filter(Boolean);

const db = new Database(path.join(dataDir, 'veneer-pro.db'), { readonly: true, fileMustExist: true });
const transcriptsDir = path.join(dataDir, 'codex-app-server-transcripts');
const inWindow = (iso) => iso && iso.slice(0, 10) >= since && iso.slice(0, 10) < until;
const hasLedger = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='turn_token_usage'").get());

function originClass(event) {
  const o = event.origin;
  if (!o) return event.text?.startsWith('[James link') ? 'james' : 'human';
  if (o.spareRunId) return 'spare';
  if (o.kind === 'build_queue') return 'build';
  if (o.kind === 'agent') return 'agent';
  if (o.kind === 'result_reply') return 'result_reply';
  return o.humanTaskNote ? 'human' : 'wakeup';
}

function sessionChain(sessionId) {
  const chain = [];
  let id = sessionId;
  for (let i = 0; id && i < 128; i += 1) {
    chain.push(id);
    try {
      id = JSON.parse(fs.readFileSync(path.join(transcriptsDir, `${id}.parent.json`), 'utf8')).sessionId;
    } catch {
      id = null;
    }
  }
  return chain;
}

function transcriptTurns(conversationId, sessionId) {
  const turns = [];
  for (const id of sessionChain(sessionId)) {
    let text;
    try { text = fs.readFileSync(path.join(transcriptsDir, `${id}.jsonl`), 'utf8'); } catch { continue; }
    let current = null;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'turn_started') current = { conversationId, startedAt: event.at, origin: originClass(event), finalAt: null };
      else if (event.type === 'text_final' && current) current.finalAt = event.at;
      else if (event.type === 'turn_done' && current) {
        const u = event.usage ?? {};
        turns.push({
          ...current,
          tokens: (u.totalInputTokens ?? u.inputTokens ?? 0) + (u.totalOutputTokens ?? u.outputTokens ?? 0),
          cached: u.cachedInputTokens ?? 0,
          context: u.inputTokens ?? null,
        });
        current = null;
      }
    }
  }
  return turns.filter((t) => inWindow(t.startedAt));
}

function ledgerTurns(botId) {
  if (!hasLedger) return [];
  return db.prepare(
    `SELECT conversation_id AS conversationId, started_at AS startedAt, finished_at AS finalAt, origin,
       input_tokens + output_tokens AS tokens, COALESCE(cached_input_tokens, 0) AS cached, context_tokens AS context
     FROM turn_token_usage WHERE bot_id = ? AND substr(started_at, 1, 10) >= ? AND substr(started_at, 1, 10) < ?`,
  ).all(botId, since, until);
}

const median = (values) => {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

const report = { since, until, generatedAt: new Date().toISOString(), bots: [] };
for (const botId of botIds) {
  const bot = db.prepare('SELECT name FROM bot_registrations WHERE conversation_id = ?').get(botId);
  const chats = db.prepare(
    'SELECT id, native_session_id FROM conversations WHERE id = ? OR id IN (SELECT conversation_id FROM coordination_lanes WHERE owner_id = ?)',
  ).all(botId, botId);
  const useLedger = source === 'ledger' || (source === 'auto' && ledgerTurns(botId).length > 0);
  const turns = useLedger ? ledgerTurns(botId) : chats.flatMap((c) => transcriptTurns(c.id, c.native_session_id));
  const days = Math.max(1, (Date.parse(until) - Date.parse(since)) / 86_400_000);
  const byOrigin = {};
  for (const t of turns) {
    const o = (byOrigin[t.origin] ??= { turns: 0, tokens: 0 });
    o.turns += 1;
    o.tokens += t.tokens;
  }
  const routineRuns = db.prepare(
    `SELECT COUNT(*) AS n FROM conversation_wakeups WHERE conversation_id = ? AND wake_key LIKE 'bot-routine:%'
     AND status = 'delivered' AND substr(delivered_at, 1, 10) >= ? AND substr(delivered_at, 1, 10) < ?`,
  ).get(botId, since, until).n;
  const governor = hasLedger
    ? Object.fromEntries(db.prepare(
      `SELECT kind, COUNT(*) AS n FROM token_governor_events WHERE bot_id = ? AND substr(at, 1, 10) >= ? AND substr(at, 1, 10) < ? GROUP BY kind`,
    ).all(botId, since, until).map((r) => [r.kind, r.n]))
    : {};
  const tokens = turns.reduce((sum, t) => sum + t.tokens, 0);
  const cached = turns.reduce((sum, t) => sum + t.cached, 0);
  report.bots.push({
    botId,
    name: bot?.name ?? botId,
    source: useLedger ? 'ledger' : 'transcripts',
    chats: chats.length,
    turnsPerDay: +(turns.length / days).toFixed(1),
    tokensPerDay: Math.round(tokens / days),
    cachedShare: tokens ? +(cached / tokens).toFixed(3) : null,
    medianContext: median(turns.map((t) => t.context)),
    medianTurnSeconds: median(turns.filter((t) => t.finalAt).map((t) => (Date.parse(t.finalAt) - Date.parse(t.startedAt)) / 1000)),
    routineRunsPerDay: +(routineRuns / days).toFixed(1),
    byOrigin,
    governor,
  });
}

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const m = (n) => (n == null ? '—' : `${(n / 1e6).toFixed(1)}M`);
  console.log(`Token governor report ${since} → ${until} (UTC, end exclusive)\n`);
  console.log('| Bot | Source | Turns/day | Tokens/day | Cached | Median context | Median turn | Routine runs/day | Governor events |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const b of report.bots) {
    const events = Object.entries(b.governor).map(([k, n]) => `${k} ${n}`).join(', ') || '—';
    console.log(`| ${b.name} | ${b.source} | ${b.turnsPerDay} | ${m(b.tokensPerDay)} | ${b.cachedShare == null ? '—' : `${Math.round(b.cachedShare * 100)}%`} | ${b.medianContext == null ? '—' : `${Math.round(b.medianContext / 1000)}k`} | ${b.medianTurnSeconds == null ? '—' : `${Math.round(b.medianTurnSeconds)}s`} | ${b.routineRunsPerDay} | ${events} |`);
  }
}
db.close();
