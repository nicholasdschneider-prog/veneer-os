#!/usr/bin/env node
// Adopt a Veneer Core project and its named chats into Veneer Pro.
//
// Core (the tmux instance on localhost:3210) and Pro run under the same HOME,
// so they share `~/.claude`. A Claude chat's history is not owned by either
// app: it is a JSONL file the CLI writes at
//
//   ~/.claude/projects/<cwd with every non-alphanumeric turned into '-'>/<sessionId>.jsonl
//
// and both apps only ever store a pointer to it — Core in its agent record, Pro
// in `conversations.native_session_id`. So long as the working directory is the
// same on both sides (it is: Pro's project `root_dir` is set to Core's project
// path), migration copies nothing. It inserts rows.
//
// Nothing under ~/.claude is read for content, moved, copied, or renamed. Core
// keeps its project and agents; this is an adoption, not a hand-off, and the
// same chat is reachable from both apps afterwards (see "single ownership" in
// docs/core-migration.md before actually resuming one from both).
//
// Dry run by default. Nothing is written without --apply.
//
//   node scripts/migrate-core-project.mjs --core-project crew-seating
//   node scripts/migrate-core-project.mjs --core-project crew-seating --apply
//
// Idempotent: a chat whose native_session_id already exists in Pro is skipped,
// so a re-run after adding an agent in Core adopts only the new one.
//
// Restart the runner after --apply. createWorkspaceResolver caches project root
// directories for the life of the process, so a project row inserted under a
// warm runner resolves to nothing until it restarts — and only restart it when
// `SELECT count(*) FROM pending_turns WHERE status='pending'` is 0, or you kill
// somebody's in-flight turn:
//
//   node scripts/restart.mjs veneer-pro-runner

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/** Mirror of claudeProjectKeyForCwd in server/src/providers/claude/transcript.ts. */
export function claudeProjectKeyForCwd(cwd) {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/** Mirror of uniqueProjectSlug in server/src/routes/api.ts. */
export function projectSlugFrom(name, taken = new Set()) {
  const base =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project';
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  return slug;
}

/**
 * The agents worth adopting. Core auto-names throwaway sessions and leaves
 * `autoNaming` on; a human who renamed a chat turned it off. That flag is the
 * only durable signal separating "a chat the operator cares about" from the ~90
 * historical/subagent sessions sitting in the same transcript directory, so it
 * is what `--agents all-named` means.
 */
export function selectAgents(agents, selector = 'all-named') {
  if (selector === 'all-named') {
    return agents.filter((agent) => agent.autoNaming === false && String(agent.name ?? '').trim() !== '');
  }
  const wanted = new Set(
    String(selector)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const picked = agents.filter((agent) => wanted.has(agent.id) || wanted.has(agent.agentId));
  const missing = [...wanted].filter(
    (item) => !agents.some((agent) => agent.id === item || agent.agentId === item),
  );
  if (missing.length) throw new Error(`no such agent in this Core project: ${missing.join(', ')}`);
  return picked;
}

/**
 * Decide what each selected agent becomes in Pro, without touching the DB.
 *
 * `status` is the whole point of the dry run:
 *   adopt          — will be inserted
 *   already-in-pro — a conversation already points at this session id
 *   no-transcript  — Core names a session with no file under the project's key
 *   unsupported    — not a Claude agent (see docs/core-migration.md)
 */
export function planChats({ coreProject, agents, details, existingSessionIds, sessionStat }) {
  const key = claudeProjectKeyForCwd(coreProject.path);
  return agents.map((agent) => {
    const detail = details.get(agent.id) ?? {};
    const sessionId = detail.sessionId ?? null;
    const provider = agent.type === 'claude' ? 'claude' : agent.type;
    const base = {
      agentId: agent.id,
      title: String(agent.name ?? '').trim(),
      provider,
      // Core's model string is already a launch-ready `--model` argument,
      // including its `[1m]` 1M-context suffix. Keep it verbatim: dropping the
      // suffix would silently resume a 1M-window session in a 200k window.
      model: detail.model ?? agent.model ?? null,
      effort: detail.modelSelection?.reasoningEffort ?? agent.modelSelection?.reasoningEffort ?? null,
      sessionId,
      projectKey: key,
    };
    if (provider !== 'claude') return { ...base, status: 'unsupported', reason: `${provider} chats are not adoptable` };
    if (!sessionId) return { ...base, status: 'no-transcript', reason: 'Core reports no session id' };
    if (existingSessionIds.has(sessionId)) return { ...base, status: 'already-in-pro', reason: 'session already adopted' };
    const stat = sessionStat(key, sessionId);
    if (!stat) return { ...base, status: 'no-transcript', reason: 'no session file under the project key' };
    return { ...base, status: 'adopt', bytes: stat.bytes, createdAt: stat.createdAt, lastActiveAt: stat.lastActiveAt };
  });
}

// ------------------------------------------------------------- personas -----

/**
 * The chats being adopted ran in Core's "full" mode — a real shell in the
 * project checkout. Pro grants that through an assistant with `full_access`,
 * which is why none of the shipped personas fit: `assistant` has no shell by
 * design, `app-creator` and `data-analyst` are scoped to other work, and
 * `platform-dev` is worse than wrong here — createWorkspaceResolver pins it to
 * VP_SOURCE_DIR and ignores `project_id` entirely, so an adopted chat would run
 * in the Veneer checkout and lose its transcript. Hence a plain developer.
 */
export const DEVELOPER_ASSISTANT = {
  slug: 'developer',
  name: 'Developer',
  full_access: 1,
  approval_mode: 'ask',
  instructions: `You are Developer, a senior software engineer working inside one of the user's code projects. Your chat runs with a shell in the project's folder.

How you work:
1. Read before you write. Find the code that already does something close to the task and follow its conventions — naming, structure, error handling, comment density — instead of importing habits from elsewhere.
2. Do the task that was asked. Don't quietly widen the scope, and don't narrow it either; if part of it turns out to be a bad idea, say so in a sentence and finish the rest.
3. Verify your own work. Run the project's build, tests, linter, or the app itself, and report what actually happened — including failures, skipped steps, and anything you could not check.
4. Never claim a command ran or a test passed unless you observed it.
5. Prefer the smallest change that solves the problem. Leave unrelated code alone.
6. Be brief. Lead with the result or the blocker; keep the detail for when it is asked for.

This project's repository is real, in use, and often has uncommitted work in it. Do not commit, push, rebase, reset, or delete anything the user did not ask for.`,
};

// ------------------------------------------------------------------ CLI -----

function parseArgs(argv) {
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const dataDir = flag('data-dir', process.env.DATA_DIR ?? dataDirFromEnvFile());
  return {
    apply: argv.includes('--apply'),
    coreProject: flag('core-project'),
    agents: flag('agents', 'all-named'),
    assistant: flag('assistant', DEVELOPER_ASSISTANT.slug),
    base: (flag('base', 'http://localhost:3210') ?? '').replace(/\/+$/, ''),
    db: flag('db', dataDir ? path.join(dataDir, 'veneer-pro.db') : null),
    claudeHome: flag('claude-home', process.env.HOME ?? os.homedir()),
    user: flag('user'),
  };
}

/** The services read DATA_DIR from their env file; a plain shell has not. */
function dataDirFromEnvFile() {
  const file = process.env.VP_ENV_FILE || path.join(os.homedir(), '.config', 'veneer-pro', 'env');
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*(?:export\s+)?DATA_DIR\s*=\s*(.*)$/.exec(line);
      if (match) return match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    /* no env file: the caller must pass --data-dir or --db */
  }
  return null;
}

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw new Error(`${url} → ${res.status} ${body?.error ?? ''}`.trim());
  return body;
}

/**
 * A session file's real start and end, taken from the transcript rather than
 * from the filesystem: mtime moves whenever anything touches the file (a Core
 * restart rewrites every one of them), and that would date a two-week-old chat
 * to today. Reads the head and tail only — these files run to tens of MB.
 */
export function readSessionStat(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const fd = fs.openSync(file, 'r');
  try {
    const window = 64 * 1024;
    const head = readChunk(fd, 0, Math.min(window, stat.size));
    const tail = stat.size > window ? readChunk(fd, stat.size - window, window) : head;
    return {
      bytes: stat.size,
      createdAt: firstTimestamp(head) ?? toSqlite(stat.birthtime),
      lastActiveAt: lastTimestamp(tail) ?? toSqlite(stat.mtime),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readChunk(fd, position, length) {
  const buf = Buffer.alloc(length);
  const read = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, read).toString('utf8');
}

const TIMESTAMP = /"timestamp"\s*:\s*"([^"]+)"/g;

function firstTimestamp(text) {
  const match = new RegExp(TIMESTAMP.source).exec(text);
  return match ? toSqlite(new Date(match[1])) : null;
}

function lastTimestamp(text) {
  let last = null;
  for (const match of text.matchAll(TIMESTAMP)) last = match[1];
  return last ? toSqlite(new Date(last)) : null;
}

/** SQLite's own `datetime('now')` shape: UTC, no zone marker, second precision. */
function toSqlite(date) {
  const value = date instanceof Date ? date : new Date(date);
  return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 19).replace('T', ' ');
}

function bytes(n) {
  if (n === undefined) return '';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.coreProject) {
    console.error('Pass --core-project <id> (the Core project id, e.g. crew-seating).');
    process.exit(2);
  }
  if (!opts.db || !fs.existsSync(opts.db)) {
    console.error(`Cannot find the database. Pass --db <file> or --data-dir <dir> (looked at: ${opts.db ?? 'unset'})`);
    process.exit(2);
  }
  const projectsDir = path.join(opts.claudeHome, '.claude', 'projects');
  const sessionStat = (key, sessionId) => readSessionStat(path.join(projectsDir, key, `${sessionId}.jsonl`));

  const { project: coreProject, agents: coreAgents } = await fetchJson(
    `${opts.base}/api/projects/${encodeURIComponent(opts.coreProject)}`,
  );
  const selected = selectAgents(coreAgents ?? [], opts.agents);
  const details = new Map(
    await Promise.all(
      selected.map(async (agent) => [
        agent.id,
        (await fetchJson(`${opts.base}/api/agents/${encodeURIComponent(agent.id)}`)) ?? {},
      ]),
    ),
  );

  const db = new Database(opts.db, { readonly: !opts.apply });
  try {
    if (!opts.user) throw new Error('--user <email> is required');
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(opts.user);
    if (!user) throw new Error(`no Veneer user with email ${opts.user}`);

    const existingSessionIds = new Set(
      db.prepare('SELECT native_session_id FROM conversations').all().map((row) => row.native_session_id),
    );
    const chats = planChats({ coreProject, agents: selected, details, existingSessionIds, sessionStat });

    // Match on root_dir, not slug: the same folder adopted twice must land in
    // the same Pro project even if Core's name has been edited since.
    const existingProject = db.prepare('SELECT id, slug, name, root_dir FROM projects WHERE root_dir = ?').get(coreProject.path);
    const takenSlugs = new Set(db.prepare('SELECT slug FROM projects').all().map((row) => row.slug));
    const projectPlan = existingProject
      ? { ...existingProject, status: 'exists' }
      : {
          id: crypto.randomUUID(),
          slug: projectSlugFrom(coreProject.name, takenSlugs),
          name: coreProject.name,
          root_dir: coreProject.path,
          status: 'create',
        };

    const assistant = db.prepare('SELECT id, slug, full_access FROM assistants WHERE slug = ?').get(opts.assistant);
    const assistantPlan = assistant
      ? { ...assistant, status: 'exists' }
      : opts.assistant === DEVELOPER_ASSISTANT.slug
        ? { slug: DEVELOPER_ASSISTANT.slug, full_access: DEVELOPER_ASSISTANT.full_access, status: 'create' }
        : null;
    if (!assistantPlan) throw new Error(`no Pro agent with slug "${opts.assistant}"`);

    console.log(`core     ${opts.base}/api/projects/${opts.coreProject}`);
    console.log(`db       ${opts.db}`);
    console.log(`sessions ${path.join(projectsDir, claudeProjectKeyForCwd(coreProject.path))}`);
    console.log(`mode     ${opts.apply ? 'APPLY' : 'dry run (pass --apply to write)'}\n`);
    console.log(`project  ${projectPlan.status === 'create' ? '+' : ' '} ${projectPlan.slug}  ${projectPlan.root_dir}`);
    console.log(`agent    ${assistantPlan.status === 'create' ? '+' : ' '} ${assistantPlan.slug}  (full access: ${assistantPlan.full_access ? 'yes' : 'no'})`);
    console.log('instructions repository CLAUDE.md and AGENTS.md stay user-owned\n');
    console.log('chats:');
    for (const chat of chats) {
      const mark = chat.status === 'adopt' ? '+' : ' ';
      console.log(`  ${mark} ${chat.title}`);
      console.log(
        `      ${chat.status.padEnd(14)} ${chat.sessionId ?? '(no session)'}  ${chat.provider}/${chat.model ?? '-'}/${chat.effort ?? '-'}` +
          (chat.status === 'adopt' ? `  ${bytes(chat.bytes)}  ${chat.createdAt} → ${chat.lastActiveAt}` : `  ${chat.reason}`),
      );
    }
    const adopting = chats.filter((chat) => chat.status === 'adopt');
    console.log(`\n${adopting.length} to adopt, ${chats.length - adopting.length} skipped.`);

    if (!opts.apply) {
      console.log('\nDry run — nothing written. Re-run with --apply.');
      return;
    }
    if (!adopting.length) {
      console.log('\nNothing to adopt.');
      return;
    }

    db.transaction(() => {
      if (assistantPlan.status === 'create') {
        const info = db
          .prepare('INSERT INTO assistants (slug, name, instructions, approval_mode, full_access) VALUES (?, ?, ?, ?, ?)')
          .run(
            DEVELOPER_ASSISTANT.slug,
            DEVELOPER_ASSISTANT.name,
            DEVELOPER_ASSISTANT.instructions,
            DEVELOPER_ASSISTANT.approval_mode,
            DEVELOPER_ASSISTANT.full_access,
          );
        assistantPlan.id = Number(info.lastInsertRowid);
        console.log(`[agent] created ${assistantPlan.slug} (id ${assistantPlan.id})`);
      }
      if (projectPlan.status === 'create') {
        db.prepare(
          `INSERT INTO projects (id, slug, name, instructions, root_dir, default_assistant_id, sort_order)
           SELECT ?, ?, ?, '', ?, ?, COALESCE(MAX(sort_order), -1) + 1 FROM projects`,
        ).run(projectPlan.id, projectPlan.slug, projectPlan.name, projectPlan.root_dir, assistantPlan.id);
        console.log(`[project] created ${projectPlan.slug} (${projectPlan.id})`);
      }
      const insertConversation = db.prepare(
        `INSERT INTO conversations
           (id, assistant_id, user_id, project_id, title, title_auto, provider, model, effort,
            native_session_id, channel, created_at, last_active_at, last_user_activity_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'web', ?, ?, datetime('now'))`,
      );
      // `turn_ran:<id>` is what conversationManager.isFirstTurn reads. Without
      // it an adopted chat looks brand new and its next turn spawns with
      // `--session-id <existing>`, which the CLI rejects outright ("Session ID
      // is already in use") instead of resuming. Adoption means the session has
      // demonstrably already run.
      const markTurnRan = db.prepare(
        `INSERT INTO settings (key, value_json) VALUES (?, 'true')
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      );
      for (const chat of adopting) {
        const id = crypto.randomUUID();
        insertConversation.run(
          id,
          assistantPlan.id,
          user.id,
          projectPlan.id,
          chat.title,
          chat.provider,
          chat.model,
          chat.effort,
          chat.sessionId,
          chat.createdAt,
          chat.lastActiveAt,
        );
        markTurnRan.run(`turn_ran:${id}`);
        console.log(`[chat] ${chat.title} → ${id}`);
      }
    })();

    console.log(`\nAdopted ${adopting.length} chat(s). Core is untouched — its project and agents still own the same sessions.`);
    console.log('Restart the runner so it picks up the new project directory (only when no turn is in flight):');
    console.log("  sqlite3 -readonly \"$DB\" \"select count(*) from pending_turns where status='pending'\"   # must be 0");
    console.log('  node scripts/restart.mjs veneer-pro-runner');
  } finally {
    db.close();
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
