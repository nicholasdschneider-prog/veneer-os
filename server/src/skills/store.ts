import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { proClaudeConfigDir, proCodexHome, proGrokHome } from '../homes.js';
import { composeSkillMd, parseSkillMd, setBody, setScalars } from './frontmatter.js';
import { isInstalledPlatformSkill, platformSkillsRoot } from './platform.js';

/**
 * Skills store (spec §1, §2, §5.2). One canonical real dir per skill in a
 * Codex-native location, with a Claude symlink; the API scans the real
 * discovery dirs live and computes provider availability by realpath. No DB
 * rows for skills. All roots are server-derived (never from client input);
 * codexHome/claudeHome are injectable so tests run against tmp dirs.
 */

export type ProviderState = 'ok' | 'missing' | 'broken-link';
export type SkillOrigin = 'user' | 'platform' | 'system' | 'broken';
export type Role = 'member' | 'owner' | 'consultant';
export type SkillEntryKind = 'original' | 'link';

export interface SkillPlacementRef {
  scope: string;
  name: string;
}

export interface SkillMeta {
  scope: string;
  name: string;
  displayName: string | null;
  description: string | null;
  providers: { claude: ProviderState; codex: ProviderState; grok: ProviderState };
  shared: boolean;
  enabled: boolean;
  origin: SkillOrigin;
  readOnly: boolean;
  issues: string[];
  hasExtraFiles: boolean;
  mtime: number;
  entryKind: SkillEntryKind;
  source: SkillPlacementRef | null;
  dependents: SkillPlacementRef[];
}
export interface SkillDetail extends SkillMeta {
  content: string;
  body: string;
  extraFiles: string[];
  canonicalDir: string;
}
export interface SkillScopeGroup {
  scope: string;
  label: string;
  kind: 'global' | 'project' | 'source';
  root: string;
  skills: SkillMeta[];
}

export type SkillErrorCode = 'exists' | 'conflict' | 'not-found' | 'read-only' | 'forbidden' | 'invalid';

/** Typed store error; the router maps `.code` to an HTTP status (spec §4). */
export class SkillError extends Error {
  constructor(
    public code: SkillErrorCode,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SkillError';
  }
}

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface ScopeInfo {
  kind: 'global' | 'project' | 'source';
  label: string;
  root: string; // absolute base shown for advanced display
  realBase: string;
  linkBase: string;
  grokLinkBase: string | null;
  holdingBase: string;
  linkStyle: 'absolute' | 'relative';
}

export interface SkillStore {
  list(role: Role): { scopes: SkillScopeGroup[]; builtins: SkillMeta[] };
  read(scope: string, name: string): SkillDetail;
  create(scope: string, name: string, description: string, body: string): { skill: SkillDetail; crossScopeDuplicates: string[] };
  save(scope: string, name: string, patch: { description?: string; body?: string; raw?: string; expectedMtime?: number }): SkillDetail;
  rename(scope: string, name: string, newName: string): SkillDetail;
  setEnabled(scope: string, name: string, enabled: boolean): SkillDetail;
  sync(scope: string, name: string): SkillDetail;
  move(scope: string, name: string, toScope: string): SkillDetail;
  copy(scope: string, name: string, toScope: string): SkillDetail;
  remove(scope: string, name: string): void;
}

export function createSkillStore({
  config,
  db,
  homes,
}: {
  config: Config;
  db: Database.Database;
  homes?: { codexHome?: string; claudeHome?: string; grokHome?: string };
}): SkillStore {
  // Pro's own provider profiles, addressed by path rather than through HOME:
  // skills belong to the service directories whatever HOME an agent runs with.
  const codexHome = homes?.codexHome ?? process.env.CODEX_HOME ?? proCodexHome();
  const claudeHome = homes?.claudeHome ?? proClaudeConfigDir();
  const grokHome = homes?.grokHome ?? process.env.GROK_HOME ?? proGrokHome();
  // macOS exposes /tmp and parts of /var through symlinks. Canonicalize paths
  // before containment checks so scope guards behave the same on every host.
  const systemDir = path.resolve(path.join(codexHome, 'skills', '.system'));
  const platformDir = platformSkillsRoot(config.sourceDir);

  // ── path helpers ────────────────────────────────────────────────────────
  function atomicWrite(file: string, data: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o644 });
    fs.renameSync(tmp, file);
  }

  function assertName(name: string): void {
    if (path.basename(name) !== name || name.startsWith('.') || !SKILL_NAME_RE.test(name)) {
      throw new SkillError('invalid', `Invalid skill name: ${name}`);
    }
  }

  function canonicalPath(p: string): string {
    let existing = path.resolve(p);
    const missing: string[] = [];
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
    const canonicalBase = realpathOrNull(existing) ?? existing;
    return path.join(canonicalBase, ...missing);
  }

  function contained(base: string, p: string): boolean {
    // macOS temp paths commonly cross the /var → /private/var symlink.
    const b = canonicalPath(base);
    const r = canonicalPath(p);
    return r === b || r.startsWith(b + path.sep);
  }

  function realpathOrNull(p: string): string | null {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  }

  function lstatOrNull(p: string): fs.Stats | null {
    try {
      return fs.lstatSync(p);
    } catch {
      return null;
    }
  }

  function placementTarget(info: ScopeInfo, name: string): { canonicalDir: string | null; entryKind: SkillEntryKind } {
    const candidates = [
      { path: path.join(info.realBase, name), stat: lstatOrNull(path.join(info.realBase, name)) },
      { path: path.join(info.holdingBase, name), stat: lstatOrNull(path.join(info.holdingBase, name)) },
      { path: path.join(info.linkBase, name), stat: lstatOrNull(path.join(info.linkBase, name)) },
    ];
    const entry = candidates.find(({ stat }) => stat !== null);
    if (!entry) return { canonicalDir: null, entryKind: 'original' };
    return {
      canonicalDir: realpathOrNull(entry.path),
      entryKind: entry.stat!.isSymbolicLink() ? 'link' : 'original',
    };
  }

  function projectDir(id: string): string | null {
    const row = db.prepare('SELECT slug, root_dir FROM projects WHERE id = ?').get(id) as
      | { slug: string; root_dir: string | null }
      | undefined;
    if (!row) return null;
    return row.root_dir ?? path.join(config.dataDir, 'workspaces', 'projects', row.slug);
  }

  function projectLabel(id: string): string {
    const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as { name: string } | undefined;
    return row?.name ?? id;
  }

  /** Build the base dirs + link style for a scope key, or throw not-found. */
  function scopeInfo(scope: string): ScopeInfo {
    if (scope === 'global') {
      return {
        kind: 'global',
        label: 'Global',
        root: path.join(codexHome, 'skills'),
        realBase: path.join(codexHome, 'skills'),
        linkBase: path.join(claudeHome, 'skills'),
        grokLinkBase: path.join(grokHome, 'skills'),
        holdingBase: path.join(codexHome, 'skills-disabled'),
        linkStyle: 'absolute',
      };
    }
    if (scope === 'source') {
      const w = config.sourceDir;
      return workspaceScope('source', 'Platform source', w);
    }
    const m = /^project:(.+)$/.exec(scope);
    if (m) {
      const id = m[1]!;
      const dir = projectDir(id);
      if (!dir) throw new SkillError('not-found', 'Unknown project');
      return workspaceScope('project', projectLabel(id), dir);
    }
    throw new SkillError('invalid', `Invalid scope: ${scope}`);
  }

  function workspaceScope(kind: 'project' | 'source', label: string, w: string): ScopeInfo {
    return {
      kind,
      label,
      root: path.join(w, '.agents', 'skills'),
      realBase: path.join(w, '.agents', 'skills'),
      linkBase: path.join(w, '.claude', 'skills'),
      grokLinkBase: null,
      holdingBase: path.join(w, '.agents', 'skills-disabled'),
      linkStyle: 'relative',
    };
  }

  /** The Claude symlink target for a skill (absolute or scope-relative). */
  function linkTargetFor(info: ScopeInfo, name: string): string {
    return info.linkStyle === 'absolute' ? path.join(info.realBase, name) : path.join('..', '..', '.agents', 'skills', name);
  }

  function createClaudeLink(info: ScopeInfo, name: string): void {
    const link = path.join(info.linkBase, name);
    fs.mkdirSync(info.linkBase, { recursive: true });
    const existing = lstatOrNull(link);
    if (existing) {
      // Only replace a symlink; never clobber a real dir sitting on the Claude side.
      if (existing.isSymbolicLink()) fs.unlinkSync(link);
      else return;
    }
    fs.symlinkSync(linkTargetFor(info, name), link);
  }

  /** Grok reads global skills from its pinned profile, independent of HOME. */
  function createGrokLink(info: ScopeInfo, name: string): void {
    if (!info.grokLinkBase) return;
    const link = path.join(info.grokLinkBase, name);
    fs.mkdirSync(info.grokLinkBase, { recursive: true });
    const existing = lstatOrNull(link);
    if (existing) {
      // Platform skills are owned copies; user collisions are never clobbered.
      if (existing.isSymbolicLink()) fs.unlinkSync(link);
      else return;
    }
    fs.symlinkSync(path.join(info.realBase, name), link);
  }

  function unlinkProviderLink(base: string | null, name: string): void {
    if (!base) return;
    const entry = path.join(base, name);
    if (!lstatOrNull(entry)?.isSymbolicLink()) return;
    try {
      fs.unlinkSync(entry);
    } catch {
      /* best effort; provider state reports any remaining broken link */
    }
  }

  // ── enumeration / classification ────────────────────────────────────────
  function classifyOrigin(canonicalDir: string | null): SkillOrigin {
    if (!canonicalDir) return 'broken';
    if (isInstalledPlatformSkill(canonicalDir)) return 'platform';
    if (contained(platformDir, canonicalDir)) return 'platform';
    if (contained(systemDir, canonicalDir)) return 'system';
    return 'user';
  }

  /** Compute a SkillMeta for `name` in a scope, or null when nothing exists. */
  function metaFor(scope: string, info: ScopeInfo, name: string): SkillMeta | null {
    const realPath = path.join(info.realBase, name);
    const holdPath = path.join(info.holdingBase, name);
    const claudePath = path.join(info.linkBase, name);
    const grokPath = info.grokLinkBase ? path.join(info.grokLinkBase, name) : null;

    const realSt = lstatOrNull(realPath);
    const holdSt = lstatOrNull(holdPath);
    const claudeSt = lstatOrNull(claudePath);
    const grokSt = grokPath ? lstatOrNull(grokPath) : null;

    let canonicalDir: string | null = null;
    let enabled = true;
    if (realSt && (realSt.isDirectory() || realSt.isSymbolicLink())) {
      canonicalDir = realpathOrNull(realPath);
      enabled = true;
    } else if (holdSt && (holdSt.isDirectory() || holdSt.isSymbolicLink())) {
      canonicalDir = realpathOrNull(holdPath);
      enabled = false;
    } else if (claudeSt) {
      // Only a Claude-side entry: a real dir (unadopted, e.g. `verify`), a
      // symlink to a user skill, or a dangling link (broken).
      if (claudeSt.isSymbolicLink()) canonicalDir = realpathOrNull(claudePath);
      else if (claudeSt.isDirectory()) canonicalDir = realpathOrNull(claudePath);
    }
    if (!realSt && !holdSt && !claudeSt) return null;

    const origin = classifyOrigin(canonicalDir);
    const readOnly = origin === 'platform' || origin === 'system';
    const issues: string[] = [];

    // Claude provider state.
    let claude: ProviderState;
    if (!claudeSt) {
      claude = 'missing';
    } else if (claudeSt.isSymbolicLink()) {
      const tgt = realpathOrNull(claudePath);
      if (!tgt) {
        claude = 'broken-link';
        issues.push('broken-link:claude');
      } else if (canonicalDir && tgt === canonicalDir) {
        claude = 'ok';
      } else {
        claude = 'broken-link';
        issues.push('broken-link:claude');
      }
    } else if (claudeSt.isDirectory()) {
      const tgt = realpathOrNull(claudePath);
      claude = 'ok';
      // A real dir on the Claude side that is NOT the canonical real dir means a
      // second same-named skill (name clash), not the adopt case.
      if (canonicalDir && tgt && tgt !== canonicalDir &&
          !(origin === 'platform' && isInstalledPlatformSkill(tgt, name))) {
        issues.push('name-clash');
      }
    } else {
      claude = 'missing';
    }

    // Codex provider state (reads the real base only; never symlink-based here).
    let codex: ProviderState;
    if (!realSt) {
      codex = 'missing';
    } else if (realSt.isSymbolicLink()) {
      if (realpathOrNull(realPath)) codex = 'ok';
      else {
        codex = 'broken-link';
        issues.push('broken-link:codex');
      }
    } else if (realSt.isDirectory()) {
      codex = 'ok';
    } else {
      codex = 'missing';
    }

    // Grok reads project/source skills natively from `.agents/skills`. Global
    // skills use a link in the pinned GROK_HOME so Full Access HOME changes do
    // not switch profiles or import the owner's personal skill directories.
    let grok: ProviderState;
    if (!info.grokLinkBase) {
      grok = codex;
    } else if (!grokSt || !grokPath) {
      grok = 'missing';
    } else if (grokSt.isSymbolicLink()) {
      const tgt = realpathOrNull(grokPath);
      if (!tgt) {
        grok = 'broken-link';
        issues.push('broken-link:grok');
      } else if (canonicalDir && tgt === canonicalDir) {
        grok = 'ok';
      } else {
        grok = 'broken-link';
        issues.push('broken-link:grok');
      }
    } else if (grokSt.isDirectory() && origin === 'platform' && isInstalledPlatformSkill(grokPath, name)) {
      grok = 'ok';
    } else {
      grok = 'missing';
      issues.push('name-clash:grok');
    }

    const shared = claude === 'ok' && codex === 'ok' && grok === 'ok';
    const { entryKind } = placementTarget(info, name);

    // Parse SKILL.md for description / displayName / frontmatter issues.
    let description: string | null = null;
    let displayName: string | null = null;
    let mtime = 0;
    let hasExtraFiles = false;
    if (canonicalDir) {
      const skillMd = path.join(canonicalDir, 'SKILL.md');
      try {
        const raw = fs.readFileSync(skillMd, 'utf8');
        const parsed = parseSkillMd(raw);
        description = parsed.description;
        displayName = parsed.name && parsed.name !== name ? parsed.name : null;
        mtime = fs.statSync(skillMd).mtimeMs;
        if (!parsed.hasFrontmatter) issues.push('no-frontmatter');
        else if (!parsed.description) issues.push('missing-description');
        if (parsed.name && parsed.name !== name) issues.push('name-mismatch');
      } catch {
        issues.push('no-frontmatter');
      }
      try {
        hasExtraFiles = fs.readdirSync(canonicalDir).some((e) => e !== 'SKILL.md');
      } catch {
        /* unreadable dir → no extras reported */
      }
    }

    return {
      scope,
      name,
      displayName,
      description,
      providers: { claude, codex, grok },
      shared,
      enabled,
      origin,
      readOnly,
      issues,
      hasExtraFiles,
      mtime,
      entryKind,
      source: null,
      dependents: [],
    };
  }

  /** Names present in a scope (real + link + holding), dot entries skipped. */
  function scopeNames(info: ScopeInfo): string[] {
    const names = new Set<string>();
    for (const base of [info.realBase, info.linkBase, info.holdingBase]) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(base);
      } catch {
        continue;
      }
      for (const e of entries) if (!e.startsWith('.')) names.add(e);
    }
    return [...names];
  }

  function listScope(scope: string, info: ScopeInfo): SkillMeta[] {
    const metas: SkillMeta[] = [];
    for (const name of scopeNames(info)) {
      if (!SKILL_NAME_RE.test(name)) continue; // skip anything not a valid skill dir name
      const meta = metaFor(scope, info, name);
      if (meta) metas.push(meta);
    }
    metas.sort((a, b) => a.name.localeCompare(b.name));
    return metas;
  }

  function allScopeKeys(includeSource = true): string[] {
    const scopes = ['global'];
    const projects = db.prepare('SELECT id FROM projects ORDER BY name COLLATE NOCASE').all() as { id: string }[];
    for (const project of projects) scopes.push(`project:${project.id}`);
    if (includeSource) scopes.push('source');
    return scopes;
  }

  function annotateRelationships(metas: SkillMeta[]): SkillMeta[] {
    const records = metas.map((meta) => ({
      meta,
      canonicalDir: placementTarget(scopeInfo(meta.scope), meta.name).canonicalDir,
    }));
    return records.map(({ meta, canonicalDir }) => {
      if (!canonicalDir) return { ...meta, source: null, dependents: [] };
      const related = records.filter(
        (record) =>
          record.canonicalDir === canonicalDir &&
          (record.meta.scope !== meta.scope || record.meta.name !== meta.name),
      );
      if (meta.entryKind === 'link') {
        const source = related.find((record) => record.meta.entryKind === 'original');
        return {
          ...meta,
          source: source ? { scope: source.meta.scope, name: source.meta.name } : null,
          dependents: [],
        };
      }
      return {
        ...meta,
        source: null,
        dependents: related
          .filter((record) => record.meta.entryKind === 'link')
          .map((record) => ({ scope: record.meta.scope, name: record.meta.name })),
      };
    });
  }

  function allPlacementMetas(includeSource = true): SkillMeta[] {
    return allScopeKeys(includeSource).flatMap((scope) => listScope(scope, scopeInfo(scope)));
  }

  function listBuiltins(): SkillMeta[] {
    const metas: SkillMeta[] = [];
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(systemDir);
    } catch {
      return metas;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const dir = path.join(systemDir, name);
      if (!lstatOrNull(dir)?.isDirectory()) continue;
      let description: string | null = null;
      let displayName: string | null = null;
      let mtime = 0;
      try {
        const raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
        const parsed = parseSkillMd(raw);
        description = parsed.description;
        displayName = parsed.name && parsed.name !== name ? parsed.name : null;
        mtime = fs.statSync(path.join(dir, 'SKILL.md')).mtimeMs;
      } catch {
        /* builtin without a readable SKILL.md — still listed */
      }
      metas.push({
        scope: 'global',
        name,
        displayName,
        description,
        providers: { claude: 'missing', codex: 'ok', grok: 'missing' },
        shared: false,
        enabled: true,
        origin: 'system',
        readOnly: true,
        issues: [],
        hasExtraFiles: false,
        mtime,
        entryKind: 'original',
        source: null,
        dependents: [],
      });
    }
    metas.sort((a, b) => a.name.localeCompare(b.name));
    return metas;
  }

  // ── read/detail ─────────────────────────────────────────────────────────
  function detailFrom(scope: string, info: ScopeInfo, name: string): SkillDetail {
    const meta = annotateRelationships(allPlacementMetas()).find(
      (placement) => placement.scope === scope && placement.name === name,
    ) ?? metaFor(scope, info, name);
    if (!meta) throw new SkillError('not-found', 'Skill not found');
    const realPath = path.join(info.realBase, name);
    const holdPath = path.join(info.holdingBase, name);
    const claudePath = path.join(info.linkBase, name);
    let canonicalDir: string | null = null;
    for (const p of [realPath, holdPath, claudePath]) {
      const rp = realpathOrNull(p);
      if (rp) {
        canonicalDir = rp;
        break;
      }
    }
    let content = '';
    let body = '';
    let extraFiles: string[] = [];
    if (canonicalDir) {
      try {
        content = fs.readFileSync(path.join(canonicalDir, 'SKILL.md'), 'utf8');
        body = parseSkillMd(content).body;
      } catch {
        /* missing SKILL.md → empty content */
      }
      try {
        extraFiles = fs.readdirSync(canonicalDir).filter((e) => e !== 'SKILL.md');
      } catch {
        /* ignore */
      }
    }
    return { ...meta, content, body, extraFiles, canonicalDir: canonicalDir ?? '' };
  }

  function requireExisting(info: ScopeInfo, name: string): SkillMeta {
    const meta = metaFor('_', info, name);
    if (!meta) throw new SkillError('not-found', 'Skill not found');
    return meta;
  }

  function assertWritable(meta: SkillMeta): void {
    if (meta.origin === 'platform') throw new SkillError('read-only', 'Built-in Veneer skills are read-only');
    if (meta.origin === 'system') throw new SkillError('read-only', 'Built-in Codex skills are read-only');
  }

  function taken(info: ScopeInfo, name: string): boolean {
    return (
      lstatOrNull(path.join(info.realBase, name)) !== null ||
      lstatOrNull(path.join(info.linkBase, name)) !== null ||
      lstatOrNull(path.join(info.holdingBase, name)) !== null
    );
  }

  // Cheap same-name existence check used for cross-scope duplicate reporting.
  function existsInScope(scope: string): (name: string) => boolean {
    let info: ScopeInfo;
    try {
      info = scopeInfo(scope);
    } catch {
      return () => false;
    }
    return (name: string) => taken(info, name);
  }

  function crossScopeDuplicatesOf(currentScope: string, name: string): string[] {
    const scopes: string[] = ['global', 'source'];
    const projects = db.prepare('SELECT id FROM projects').all() as { id: string }[];
    for (const p of projects) scopes.push(`project:${p.id}`);
    const dups: string[] = [];
    for (const scope of scopes) {
      if (scope === currentScope) continue;
      if (existsInScope(scope)(name)) dups.push(scope);
    }
    return dups;
  }

  /**
   * An unadopted Claude-only real dir (e.g. `verify`) IS the skill; ops that
   * assume the canonical Codex-side dir (disable, rename, sync) adopt it first.
   */
  function adoptIfClaudeOnly(info: ScopeInfo, name: string): void {
    const realPath = path.join(info.realBase, name);
    const realSt = lstatOrNull(realPath);
    if (realSt?.isDirectory() || (realSt?.isSymbolicLink() && realpathOrNull(realPath))) return;
    const claudePath = path.join(info.linkBase, name);
    const st = lstatOrNull(claudePath);
    if (st && st.isDirectory() && !st.isSymbolicLink()) {
      // Old installs can leave a dangling Codex link in front of the canonical
      // destination. It has no data, and must be unlinked before adoption.
      if (realSt?.isSymbolicLink()) fs.unlinkSync(realPath);
      moveDir(claudePath, realPath);
    }
  }

  /** Move a directory on the same filesystem; fall back to copy+remove on EXDEV. */
  function moveDir(from: string, to: string): void {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    }
  }

  function firstParagraph(body: string): string {
    for (const line of body.split('\n')) {
      const t = line.replace(/^#+\s*/, '').trim();
      if (t) return t;
    }
    return '';
  }

  function removePlacementLinks(info: ScopeInfo, name: string): void {
    for (const base of [info.linkBase, info.realBase, info.holdingBase]) {
      const entry = path.join(base, name);
      if (!lstatOrNull(entry)?.isSymbolicLink()) continue;
      try {
        fs.unlinkSync(entry);
      } catch {
        /* best effort; the caller will report any remaining placement */
      }
    }
    unlinkProviderLink(info.grokLinkBase, name);
  }

  // ── public API ──────────────────────────────────────────────────────────
  return {
    list(role) {
      const scopes: SkillScopeGroup[] = [];
      const push = (scope: string) => {
        const info = scopeInfo(scope);
        scopes.push({ scope, label: info.label, kind: info.kind, root: info.root, skills: listScope(scope, info) });
      };
      push('global');
      const projects = db.prepare('SELECT id, name FROM projects ORDER BY name COLLATE NOCASE').all() as {
        id: string;
        name: string;
      }[];
      for (const p of projects) push(`project:${p.id}`);
      if (role !== 'member') push('source');
      const annotated = annotateRelationships(scopes.flatMap((group) => group.skills));
      const byPlacement = new Map(annotated.map((meta) => [`${meta.scope}\0${meta.name}`, meta]));
      for (const group of scopes) {
        group.skills = group.skills.map((meta) => byPlacement.get(`${meta.scope}\0${meta.name}`) ?? meta);
      }
      return { scopes, builtins: listBuiltins() };
    },

    read(scope, name) {
      assertName(name);
      return detailFrom(scope, scopeInfo(scope), name);
    },

    create(scope, name, description, body) {
      assertName(name);
      const info = scopeInfo(scope);
      if (taken(info, name)) throw new SkillError('exists', `A skill named "${name}" already exists in this scope`, { code: 'exists' });
      const realPath = path.join(info.realBase, name);
      fs.mkdirSync(realPath, { recursive: true });
      atomicWrite(path.join(realPath, 'SKILL.md'), composeSkillMd(name, description, body));
      try {
        createClaudeLink(info, name);
      } catch {
        // Symlink EPERM (§9.11): create still succeeds; row shows broken-link:claude with a retry.
      }
      try {
        createGrokLink(info, name);
      } catch {
        // Same degraded behavior as Claude: the row exposes the provider issue.
      }
      return { skill: detailFrom(scope, info, name), crossScopeDuplicates: crossScopeDuplicatesOf(scope, name) };
    },

    save(scope, name, patch) {
      assertName(name);
      const info = scopeInfo(scope);
      const meta = requireExisting(info, name);
      assertWritable(meta);
      const detail = detailFrom(scope, info, name);
      if (!detail.canonicalDir) throw new SkillError('not-found', 'Skill not found');
      const skillMd = path.join(detail.canonicalDir, 'SKILL.md');
      if (patch.expectedMtime !== undefined && meta.mtime !== patch.expectedMtime) {
        throw new SkillError('conflict', 'This skill changed elsewhere', {
          code: 'conflict',
          mtime: meta.mtime,
          raw: detail.content,
        });
      }
      let next: string;
      if (patch.raw !== undefined) {
        next = patch.raw;
      } else {
        next = detail.content;
        if (patch.description !== undefined) next = setScalars(next, { description: patch.description });
        if (patch.body !== undefined) next = setBody(next, patch.body);
      }
      atomicWrite(skillMd, next);
      return detailFrom(scope, info, name);
    },

    rename(scope, name, newName) {
      assertName(name);
      assertName(newName);
      const info = scopeInfo(scope);
      const meta = requireExisting(info, name);
      assertWritable(meta);
      if (newName === name) return detailFrom(scope, info, name);
      if (taken(info, newName)) throw new SkillError('exists', `A skill named "${newName}" already exists in this scope`, { code: 'exists' });

      if (meta.enabled) adoptIfClaudeOnly(info, name);
      const base = meta.enabled ? info.realBase : info.holdingBase;
      const fromDir = path.join(base, name);
      const toDir = path.join(base, newName);
      if (!contained(base, fromDir) || !contained(base, toDir)) throw new SkillError('invalid', 'Path escapes scope');
      fs.renameSync(fromDir, toDir);
      // name == dir is required; rewrite the frontmatter name line to match.
      const skillMd = path.join(toDir, 'SKILL.md');
      try {
        atomicWrite(skillMd, setScalars(fs.readFileSync(skillMd, 'utf8'), { name: newName }));
      } catch {
        /* no SKILL.md yet — nothing to rewrite */
      }
      unlinkProviderLink(info.grokLinkBase, name);
      if (meta.enabled) {
        try {
          fs.unlinkSync(path.join(info.linkBase, name));
        } catch {
          /* old link may be absent */
        }
        try {
          createClaudeLink(info, newName);
        } catch {
          /* EPERM → broken-link:claude, repairable */
        }
        try {
          createGrokLink(info, newName);
        } catch {
          /* repairable with sync */
        }
      }
      return detailFrom(scope, info, newName);
    },

    setEnabled(scope, name, enabled) {
      assertName(name);
      const info = scopeInfo(scope);
      const meta = requireExisting(info, name);
      assertWritable(meta);
      if (meta.enabled === enabled) {
        if (!enabled) unlinkProviderLink(info.grokLinkBase, name);
        return detailFrom(scope, info, name);
      }

      if (!enabled) {
        // Disable: park the real dir in the sibling holding dir; drop the link.
        adoptIfClaudeOnly(info, name);
        const from = path.join(info.realBase, name);
        const to = path.join(info.holdingBase, name);
        moveDir(from, to);
        try {
          fs.unlinkSync(path.join(info.linkBase, name));
        } catch {
          /* link may be absent */
        }
        unlinkProviderLink(info.grokLinkBase, name);
      } else {
        // Enable: 409 if the name was re-taken while parked, then reverse.
        if (lstatOrNull(path.join(info.realBase, name)) || lstatOrNull(path.join(info.linkBase, name))) {
          throw new SkillError('exists', `A skill named "${name}" already exists in this scope`, { code: 'exists' });
        }
        moveDir(path.join(info.holdingBase, name), path.join(info.realBase, name));
        try {
          createClaudeLink(info, name);
        } catch {
          /* EPERM → broken-link:claude */
        }
        try {
          createGrokLink(info, name);
        } catch {
          /* repairable with sync */
        }
      }
      return detailFrom(scope, info, name);
    },

    sync(scope, name) {
      assertName(name);
      const info = scopeInfo(scope);
      const meta = requireExisting(info, name);
      assertWritable(meta);

      const realPath = path.join(info.realBase, name);
      const claudePath = path.join(info.linkBase, name);

      // Adopt a Claude-only real dir: move it to the canonical Codex location.
      adoptIfClaudeOnly(info, name);

      if (!meta.enabled) {
        unlinkProviderLink(info.grokLinkBase, name);
        return detailFrom(scope, info, name);
      }

      // Inject missing frontmatter / description so Codex accepts it.
      const skillMd = path.join(realPath, 'SKILL.md');
      try {
        const raw = fs.readFileSync(skillMd, 'utf8');
        const parsed = parseSkillMd(raw);
        const changes: { name?: string; description?: string } = {};
        if (!parsed.name || parsed.name !== name) changes.name = name;
        if (!parsed.description) changes.description = firstParagraph(parsed.body) || name;
        if (changes.name !== undefined || changes.description !== undefined) {
          atomicWrite(skillMd, setScalars(raw, changes));
        }
      } catch {
        /* no SKILL.md at all → nothing to repair here */
      }

      // (Re)create a working Claude link if missing/broken.
      const linkSt = lstatOrNull(claudePath);
      const linkOk = linkSt?.isSymbolicLink() && realpathOrNull(claudePath) === realpathOrNull(realPath);
      if (!linkOk && lstatOrNull(realPath)?.isDirectory()) {
        if (linkSt?.isSymbolicLink()) {
          try {
            fs.unlinkSync(claudePath);
          } catch {
            /* best effort */
          }
        }
        try {
          createClaudeLink(info, name);
        } catch {
          /* EPERM → broken-link:claude */
        }
      }
      if (lstatOrNull(realPath)?.isDirectory() && info.grokLinkBase) {
        const grokPath = path.join(info.grokLinkBase, name);
        const grokSt = lstatOrNull(grokPath);
        const grokOk = grokSt?.isSymbolicLink() && realpathOrNull(grokPath) === realpathOrNull(realPath);
        if (!grokOk && (!grokSt || grokSt.isSymbolicLink())) {
          unlinkProviderLink(info.grokLinkBase, name);
          try {
            createGrokLink(info, name);
          } catch {
            /* repairable by retrying sync */
          }
        }
      }
      return detailFrom(scope, info, name);
    },

    move(scope, name, toScope) {
      assertName(name);
      const fromInfo = scopeInfo(scope);
      const toInfo = scopeInfo(toScope);
      const meta = requireExisting(fromInfo, name);
      assertWritable(meta);
      // Adopt an unadopted Claude-only real dir so the canonical dir is the source.
      adoptIfClaudeOnly(fromInfo, name);
      if (taken(toInfo, name)) {
        throw new SkillError('exists', `A skill named "${name}" already exists in this scope`, { code: 'exists' });
      }
      // A parked skill stays parked: move to the SAME kind of base in the destination.
      const fromBase = meta.enabled ? fromInfo.realBase : fromInfo.holdingBase;
      const toBase = meta.enabled ? toInfo.realBase : toInfo.holdingBase;
      moveDir(path.join(fromBase, name), path.join(toBase, name));
      try {
        fs.unlinkSync(path.join(fromInfo.linkBase, name));
      } catch {
        /* old link may be absent (parked / EPERM at create time) */
      }
      unlinkProviderLink(fromInfo.grokLinkBase, name);
      if (meta.enabled) {
        try {
          createClaudeLink(toInfo, name);
        } catch {
          /* EPERM → broken-link:claude, repairable */
        }
        try {
          createGrokLink(toInfo, name);
        } catch {
          /* repairable with sync */
        }
      }
      return detailFrom(toScope, toInfo, name);
    },

    copy(scope, name, toScope) {
      assertName(name);
      const fromInfo = scopeInfo(scope);
      const toInfo = scopeInfo(toScope);
      const meta = requireExisting(fromInfo, name);
      assertWritable(meta);
      const source = detailFrom(scope, fromInfo, name);
      if (!source.canonicalDir) throw new SkillError('not-found', 'Skill source not found');
      const destination = taken(toInfo, name) ? detailFrom(toScope, toInfo, name) : null;
      const replacesLink =
        destination?.entryKind === 'link' && destination.canonicalDir === source.canonicalDir;
      if (destination && !replacesLink) {
        throw new SkillError('exists', `A skill named "${name}" already exists in this scope`, { code: 'exists' });
      }
      const destReal = path.join(toInfo.realBase, name);
      fs.mkdirSync(path.dirname(destReal), { recursive: true });
      const temporary = path.join(toInfo.realBase, `.${name}.${crypto.randomUUID()}.copy-tmp`);
      try {
        fs.rmSync(temporary, { recursive: true, force: true });
        // Copies references/scripts/assets too. A parked source yields an enabled copy.
        fs.cpSync(source.canonicalDir, temporary, { recursive: true });
        if (replacesLink) removePlacementLinks(toInfo, name);
        fs.renameSync(temporary, destReal);
      } catch (error) {
        fs.rmSync(temporary, { recursive: true, force: true });
        throw error;
      }
      try {
        createClaudeLink(toInfo, name);
      } catch {
        /* EPERM → broken-link:claude, repairable */
      }
      try {
        createGrokLink(toInfo, name);
      } catch {
        /* repairable with sync */
      }
      return detailFrom(toScope, toInfo, name);
    },

    remove(scope, name) {
      assertName(name);
      const info = scopeInfo(scope);
      const meta = requireExisting(info, name);
      assertWritable(meta);

      const detail = detailFrom(scope, info, name);
      if (detail.entryKind === 'link') {
        removePlacementLinks(info, name);
        return;
      }
      if (detail.dependents.length) {
        throw new SkillError('conflict', 'This is the original skill. Remove or replace its linked placements first.', {
          code: 'linked-dependents',
          dependents: detail.dependents,
        });
      }

      const claudePath = path.join(info.linkBase, name);
      const claudeSt = lstatOrNull(claudePath);
      if (claudeSt) {
        if (claudeSt.isSymbolicLink()) {
          // lstat discipline: unlink the link, never follow it.
          try {
            fs.unlinkSync(claudePath);
          } catch {
            /* best effort */
          }
        } else if (claudeSt.isDirectory() && contained(info.linkBase, claudePath)) {
          // A real dir on the Claude side is only THIS skill when unadopted
          // (no canonical dir anywhere). If a canonical dir exists, the Claude
          // dir is a same-named clash sibling — deleting it would destroy an
          // unrelated skill (spec §2: delete only within the canonical dir).
          const hasCanonical =
            lstatOrNull(path.join(info.realBase, name))?.isDirectory() ||
            lstatOrNull(path.join(info.holdingBase, name))?.isDirectory();
          if (!hasCanonical) fs.rmSync(claudePath, { recursive: true, force: true });
        }
      }
      unlinkProviderLink(info.grokLinkBase, name);
      for (const base of [info.realBase, info.holdingBase]) {
        const dir = path.join(base, name);
        const st = lstatOrNull(dir);
        if (st && st.isDirectory() && contained(base, dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  };
}
