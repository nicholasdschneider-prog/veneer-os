#!/usr/bin/env node
// Re-point a Veneer Pro install at new absolute paths after a host migration.
//
// Why this exists: nothing in the app stores where a conversation's transcript
// lives. `claudeSessionFilePath` recomputes it on every read from the agent's
// *current* working directory —
//
//   ~/.claude/projects/<cwd with every non-alphanumeric turned into '-'>/<sessionId>.jsonl
//
// so moving a working directory silently takes every prior transcript for that
// directory with it. The files are still on disk under the old directory name;
// the app just stops looking there. That is exactly what happened in the
// 2026-07-28 droplet -> Mac Studio move: a byte-perfect sync, 159 of 174 claude
// conversations dark. See _plans/2026-07-28-lost-session-files-findings.md.
//
// Two things move during a host migration, and both have to be handled together:
//
//   1. `projects.root_dir` in the DB — absolute, and on the old host's layout.
//      Left stale it is worse than a display bug: createWorkspaceResolver does
//      mkdirSync(root_dir) before every turn, so on macOS (where /home is an
//      autofs mount that cannot be written) every project-scoped turn throws.
//   2. The `.claude/projects/<key>` directory names, which are derived from the
//      paths in (1) plus VP_SOURCE_DIR and DATA_DIR.
//
// Remapping (1) without (2) moves the breakage rather than fixing it, so this
// script always plans both and applies them in one run. Aliases are symlinks,
// not copies: one physical directory stays the source of truth, both old and new
// keys resolve, and new sessions land beside the old ones.
//
// Dry run by default. Nothing is written without --apply.
//
//   node scripts/migrate-host-paths.mjs \
//     --old-prefix /home/veneer --new-prefix /Users/you/veneer-pro-home \
//     --map /home/veneer/veneer-pro=/Users/you/veneer-os \
//     --old-source-dir /home/veneer/veneer-pro \
//     --old-data-dir /home/veneer/.local/share/veneer-pro \
//     --apply
//
// Stop the runner (or at least run this between turns) before --apply: the
// workspace resolver caches project directories in memory for the life of the
// process, so a remap applied under a warm runner is not picked up until it
// restarts.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Mirror of claudeProjectKeyForCwd in server/src/providers/claude/transcript.ts. */
export function claudeProjectKeyForCwd(cwd) {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Decide each project's new root_dir. An exact --map override always wins; a
 * project whose root_dir does not sit under oldPrefix is left alone. Returning
 * unchanged rows too (changed:false) keeps the dry-run output honest about what
 * was considered rather than only what moved.
 */
export function planRootDirRemap({ projects, oldPrefix, newPrefix, overrides = new Map() }) {
  return projects.map((project) => {
    const from = project.root_dir;
    if (!from) return { slug: project.slug, from, to: from, changed: false, reason: 'no root_dir' };
    if (overrides.has(from)) {
      const to = overrides.get(from);
      return { slug: project.slug, from, to, changed: to !== from, reason: 'explicit --map' };
    }
    if (!oldPrefix || !underPrefix(from, oldPrefix)) {
      return { slug: project.slug, from, to: from, changed: false, reason: 'outside --old-prefix' };
    }
    const to = path.join(newPrefix, path.relative(oldPrefix, from));
    return { slug: project.slug, from, to, changed: to !== from, reason: 'prefix remap' };
  });
}

/** Prefix match on path boundaries, so /home/veneer never matches /home/veneer2. */
function underPrefix(target, prefix) {
  const rel = path.relative(prefix, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Turn a list of {from,to} cwd moves into the alias links that keep their
 * transcripts reachable. Only emits a link when the old key actually holds
 * transcripts and the new key is still free — both checks matter, because this
 * script is expected to be run more than once (a re-run must be a no-op).
 */
export function planAliases({ moves, projectsDir, exists = fs.existsSync }) {
  const plan = [];
  const seen = new Set();
  for (const move of moves) {
    if (!move.from || !move.to || move.from === move.to) continue;
    const oldKey = claudeProjectKeyForCwd(move.from);
    const newKey = claudeProjectKeyForCwd(move.to);
    if (oldKey === newKey || seen.has(newKey)) continue;
    seen.add(newKey);
    const status = !exists(path.join(projectsDir, oldKey))
      ? 'no-transcripts'
      : exists(path.join(projectsDir, newKey))
        ? 'already-present'
        : 'create';
    plan.push({ label: move.label ?? move.slug ?? newKey, oldKey, newKey, status });
  }
  return plan;
}

// ---------------------------------------------------------------- CLI ------

function parseArgs(argv) {
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const overrides = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--map') continue;
    const [from, ...rest] = String(argv[i + 1] ?? '').split('=');
    if (from && rest.length) overrides.set(from, rest.join('='));
  }
  const dataDir = flag('data-dir', process.env.DATA_DIR);
  return {
    apply: argv.includes('--apply'),
    db: flag('db', dataDir ? path.join(dataDir, 'veneer-pro.db') : null),
    claudeHome: flag('claude-home', process.env.HOME),
    oldPrefix: flag('old-prefix'),
    newPrefix: flag('new-prefix'),
    overrides,
    oldSourceDir: flag('old-source-dir'),
    newSourceDir: flag('source-dir', process.env.VP_SOURCE_DIR),
    oldDataDir: flag('old-data-dir'),
    newDataDir: dataDir,
  };
}

function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.db || !fs.existsSync(opts.db)) {
    console.error(`Cannot find the database. Pass --db <file> or --data-dir <dir> (looked at: ${opts.db ?? 'unset'})`);
    process.exit(2);
  }
  if (!opts.claudeHome) {
    console.error('Cannot find the service HOME. Pass --claude-home <dir>.');
    process.exit(2);
  }
  const projectsDir = path.join(opts.claudeHome, '.claude', 'projects');
  const sqlite = (sql, readonly = true) =>
    execFileSync('sqlite3', [...(readonly ? ['-readonly'] : []), '-json', opts.db, sql], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });

  const projects = JSON.parse(sqlite('select slug, root_dir from projects order by slug') || '[]');
  const remap = planRootDirRemap({ ...opts, projects });

  console.log(`db       ${opts.db}`);
  console.log(`projects ${projectsDir}`);
  console.log(`mode     ${opts.apply ? 'APPLY' : 'dry run (pass --apply to write)'}\n`);

  console.log('projects.root_dir:');
  for (const row of remap) {
    const mark = row.changed ? '~' : ' ';
    console.log(`  ${mark} ${String(row.slug).padEnd(12)} ${row.from ?? '(none)'}`);
    if (row.changed) console.log(`    ${' '.repeat(13)}-> ${row.to}   [${row.reason}]`);
  }

  // A remap whose destination does not exist would trade a stale path for a
  // missing one — refuse rather than write it.
  const missing = remap.filter((row) => row.changed && !fs.existsSync(row.to));
  if (missing.length) {
    console.error('\nRefusing to continue — these destinations do not exist on this host:');
    for (const row of missing) console.error(`  ${row.slug}: ${row.to}`);
    console.error('Create them, or pass an explicit --map OLD=NEW for each.');
    process.exit(1);
  }

  // Project roots are only some of the working directories. VP_SOURCE_DIR backs
  // every platform-dev conversation and DATA_DIR backs the per-assistant
  // workspaces, and both move during a host migration too.
  const moves = remap.filter((row) => row.changed).map((row) => ({ ...row, label: `project:${row.slug}` }));
  if (opts.oldSourceDir && opts.newSourceDir) {
    moves.push({ label: 'VP_SOURCE_DIR', from: opts.oldSourceDir, to: opts.newSourceDir });
  }
  if (opts.oldDataDir && opts.newDataDir) {
    for (const slug of assistantSlugs(sqlite)) {
      moves.push({
        label: `workspace:${slug}`,
        from: path.join(opts.oldDataDir, 'workspaces', slug),
        to: path.join(opts.newDataDir, 'workspaces', slug),
      });
    }
  }

  const aliases = planAliases({ moves, projectsDir });
  console.log('\n.claude/projects aliases:');
  if (!aliases.length) console.log('  (none)');
  for (const alias of aliases) {
    console.log(`  ${alias.status === 'create' ? '+' : ' '} ${alias.newKey}`);
    console.log(`      -> ${alias.oldKey}   [${alias.label}: ${alias.status}]`);
  }

  if (!opts.apply) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    return;
  }

  // Aliases first: they are inert until the DB points at them, so there is never
  // a moment where the DB names a key that does not resolve.
  for (const alias of aliases) {
    if (alias.status !== 'create') continue;
    fs.symlinkSync(alias.oldKey, path.join(projectsDir, alias.newKey)); // relative, same dir
    console.log(`[alias] ${alias.newKey} -> ${alias.oldKey}`);
  }
  const changed = remap.filter((row) => row.changed);
  if (changed.length) {
    const statements = changed
      .map((row) => `UPDATE projects SET root_dir=${quote(row.to)} WHERE slug=${quote(row.slug)};`)
      .join('\n');
    execFileSync('sqlite3', [opts.db], { input: `BEGIN;\n${statements}\nCOMMIT;\n`, encoding: 'utf8' });
    console.log(`[db] updated ${changed.length} project root_dir value(s)`);
  }
  console.log('\nDone. Restart the runner so it drops its cached project directories:');
  console.log('  npm run restart');
}

function assistantSlugs(sqlite) {
  try {
    return JSON.parse(sqlite('select slug from assistants order by slug') || '[]').map((row) => row.slug);
  } catch {
    return [];
  }
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
