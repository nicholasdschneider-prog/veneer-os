import fs from 'node:fs';
import path from 'node:path';
import { resolveLoginHome } from '../../homes.js';

/**
 * Veneer-owned lockdown of the pinned Grok profile directory (`GROK_HOME`).
 *
 * ## The exposure
 *
 * Grok ships "compatibility scanners" that auto-import Claude Code and Cursor
 * configuration, all enabled by default. Verified live 2026-08-12 with grok
 * 1.0.3 via `grok inspect --json`, run with a scratch `GROK_HOME` AND a scratch
 * cwd — so nothing came from Grok's own profile or from the workspace — the CLI
 * still discovered, out of `$HOME/.claude` and `$HOME/.claude.json`:
 *
 *   - 27 Claude Code **hooks** (arbitrary shell commands, on session start,
 *     user prompt submit, and pre-tool-use),
 *   - Claude Code **permission rules** from `settings.local.json`,
 *   - Claude Code **MCP servers** from `~/.claude.json` (this is what pulled the
 *     stray `cloudflare-mcp` server into an unrelated probe),
 *   - Claude Code **instruction files** (`Claude.md`),
 *   - Claude Code and Cursor **skills**.
 *
 * For a Full Access agent, `$HOME` is the machine owner's real home — so this is
 * the difference between a Veneer turn and a Veneer turn that silently runs the
 * owner's hooks with their tool allowlist.
 *
 * ## The fix takes two mechanisms, because one does not cover the other
 *
 * 1. **Per-scanner env switches** (`GROK_<VENDOR>_<SURFACE>_ENABLED=false`),
 *    set on the child process in `adapter.ts`. Measured effect: 26/27 Claude
 *    hooks and the foreign MCP server flip to `compatibilityStatus: "disabled"`,
 *    and `grok inspect` reports each cell as `source: "env"`. They do NOT stop
 *    the Claude permission-settings import — that still loaded 3 rules.
 * 2. **This file**: `config.toml` → `[claude_compat] imported = true`. That is
 *    the marker the CLI writes after its one-time Claude settings import;
 *    setting it up front makes it skip the import entirely. Measured effect on
 *    top of the env switches: permission-rule sources 1 → 0, hooks 27 → 1,
 *    discovered MCP servers 2 → 0. This marker is read ONLY from `config.toml`
 *    — putting it in `requirements.toml` provably does nothing.
 *
 * 3. **Native Grok skills**: global skills are materialized under the pinned
 *    `$GROK_HOME/skills`, while `[skills].ignore` excludes `$HOME/.claude/skills`
 *    and `$HOME/.agents/skills`. This is required because Full Access changes
 *    HOME to the machine owner's login home, and Grok 1.0.3 does not use
 *    `CLAUDE_CONFIG_DIR` for skill discovery. Project skills remain available
 *    through the current working directory's `.agents/skills`.
 *
 * ## Residual exposure (accepted, not silent)
 *
 * Claude Code **plugins** under `$HOME/.claude/plugins/` are still discovered:
 * they contribute skills/commands and are listed as a plugin hook source. Grok's
 * docs say a plugin's hooks, MCP servers and LSP servers stay inactive until the
 * plugin is trusted, and only `~/.grok/plugins` is trusted automatically — so
 * this is instruction-surface bleed rather than code execution. There is no
 * global "scan no plugins" switch in 1.0.3, only `[plugins] disabled = [...]`
 * by name. Revisit if Veneer ever runs where the login account has untrusted
 * Claude plugins installed.
 */

const MANAGED_HEADER = '# Managed by Veneer Pro — do not edit. See providers/grok/profile.ts.';

/**
 * Grok's per-vendor, per-surface compatibility scanners, in their environment
 * form. Resolution is `env var > config.toml > default (on)`, so setting these
 * on the child process cannot be shadowed by a config file — including one a
 * workspace checks in.
 *
 * The `*_SESSIONS_ENABLED` cells go beyond the documented minimum — they are
 * staged foreign-session scanners that activate as soon as a matching
 * `resume-claude` / `resume-cursor` / `resume-codex` skill exists, and Veneer's
 * skill store is exactly the kind of place such a skill could appear.
 */
export const DISABLED_COMPAT_SCANNERS = [
  'GROK_CLAUDE_MCPS_ENABLED',
  'GROK_CLAUDE_HOOKS_ENABLED',
  'GROK_CLAUDE_RULES_ENABLED',
  'GROK_CLAUDE_SKILLS_ENABLED',
  'GROK_CLAUDE_AGENTS_ENABLED',
  'GROK_CLAUDE_SESSIONS_ENABLED',
  'GROK_CURSOR_SKILLS_ENABLED',
  'GROK_CURSOR_RULES_ENABLED',
  'GROK_CURSOR_AGENTS_ENABLED',
  'GROK_CURSOR_MCPS_ENABLED',
  'GROK_CURSOR_HOOKS_ENABLED',
  'GROK_CURSOR_SESSIONS_ENABLED',
  'GROK_CODEX_SESSIONS_ENABLED',
] as const;

const LOGIN_SKILL_IGNORES = ['~/.claude/skills', '~/.agents/skills'] as const;

/** Apply the scanner lockdown to a child environment, in place. */
export function disableVendorCompatScanners(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of DISABLED_COMPAT_SCANNERS) env[key] = 'false';
  return env;
}

/**
 * Ensure the pinned Grok profile carries every Veneer security invariant.
 * Best-effort by design: a profile we cannot write is a degraded install, not a
 * reason to fail every turn — the caller logs and continues.
 *
 * Non-destructive: operator tables and `[skills].paths` survive. Existing
 * ignore entries are preserved while Veneer's two login-home exclusions are
 * merged in exactly once.
 */
export function ensureGrokProfile(
  grokHome: string,
  log: Pick<Console, 'warn'> = console,
  ownerHome: string = resolveLoginHome(),
): void {
  try {
    fs.mkdirSync(grokHome, { recursive: true });
    const configPath = path.join(grokHome, 'config.toml');
    let config: string | null = null;
    try {
      config = fs.readFileSync(configPath, 'utf8');
    } catch {
      config = null;
    }
    let next = config ?? `${MANAGED_HEADER}\n`;
    if (!/^\s*\[claude_compat\]/m.test(next)) {
      next += `${next.endsWith('\n') ? '' : '\n'}\n[claude_compat]\nimported = true\n`;
    }
    next = mergeSkillIgnores(next, requiredSkillIgnores(grokHome, ownerHome));
    if (next !== config) fs.writeFileSync(configPath, next, { mode: 0o600 });
  } catch (err) {
    log.warn(`[grok] could not prepare the Grok profile at ${grokHome}: ${(err as Error).message}`);
  }
}

/** Merge required strings into `[skills].ignore` without touching other keys. */
function mergeSkillIgnores(config: string, requiredIgnores: string[]): string {
  const section = /^\s*\[skills\]\s*(?:#.*)?$/m.exec(config);
  if (!section || section.index === undefined) {
    return `${config}${config.endsWith('\n') ? '' : '\n'}\n[skills]\nignore = ${JSON.stringify(requiredIgnores)}\n`;
  }

  const sectionStart = section.index;
  const bodyStart = sectionStart + section[0].length;
  const nextHeader = /^\s*\[\[?[^\]\n]+\]\]?\s*(?:#.*)?$/gm;
  nextHeader.lastIndex = bodyStart;
  const next = nextHeader.exec(config);
  const sectionEnd = next?.index ?? config.length;
  const body = config.slice(bodyStart, sectionEnd);
  const assignment = /^([ \t]*)ignore[ \t]*=[ \t]*/m.exec(body);

  if (!assignment || assignment.index === undefined) {
    const insertion = `\nignore = ${JSON.stringify(requiredIgnores)}`;
    return `${config.slice(0, bodyStart)}${insertion}${config.slice(bodyStart)}`;
  }

  const assignmentStart = bodyStart + assignment.index;
  const valueStart = assignmentStart + assignment[0].length;
  const arrayStart = config.indexOf('[', valueStart);
  if (arrayStart < 0 || arrayStart >= sectionEnd) throw new Error('[skills].ignore must be a TOML array');
  const arrayEnd = findTomlArrayEnd(config, arrayStart, sectionEnd);
  const values = parseTomlStringArray(config.slice(arrayStart + 1, arrayEnd));
  for (const required of requiredIgnores) if (!values.includes(required)) values.push(required);
  const replacement = JSON.stringify(values);
  return `${config.slice(0, arrayStart)}${replacement}${config.slice(arrayEnd + 1)}`;
}

/**
 * Grok matches ignores after resolving symlinks. Include personal symlink
 * targets, except targets intentionally exposed through pinned GROK_HOME.
 */
function requiredSkillIgnores(grokHome: string, ownerHome: string): string[] {
  const ignores: string[] = [...LOGIN_SKILL_IGNORES];
  const managedTargets = symlinkTargets(path.join(grokHome, 'skills'));
  for (const relative of [path.join('.claude', 'skills'), path.join('.agents', 'skills')]) {
    for (const target of symlinkTargets(path.join(ownerHome, relative))) {
      if (!managedTargets.has(target) && !ignores.includes(target)) ignores.push(target);
    }
  }
  return ignores;
}

function symlinkTargets(root: string): Set<string> {
  const targets = new Set<string>();
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return targets;
  }
  for (const name of names) {
    const entry = path.join(root, name);
    try {
      if (fs.lstatSync(entry).isSymbolicLink()) targets.add(fs.realpathSync(entry));
    } catch {
      /* dangling or unreadable personal links cannot expose a skill */
    }
  }
  return targets;
}

function findTomlArrayEnd(config: string, start: number, limit: number): number {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = start + 1; i < limit; i += 1) {
    const char = config[i]!;
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ']') return i;
  }
  throw new Error('[skills].ignore has an unterminated TOML array');
}

function parseTomlStringArray(source: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < source.length;) {
    const char = source[i]!;
    if (char !== '"' && char !== "'") {
      i += 1;
      continue;
    }
    const quote = char;
    let token = quote;
    i += 1;
    let escaped = false;
    for (; i < source.length; i += 1) {
      const current = source[i]!;
      token += current;
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && current === '\\') {
        escaped = true;
      } else if (current === quote) {
        i += 1;
        break;
      }
    }
    const value = quote === '"' ? JSON.parse(token) as string : token.slice(1, -1);
    if (!values.includes(value)) values.push(value);
  }
  return values;
}

/** Absolute path of the subscription credential file Grok writes after login. */
export function grokAuthFile(grokHome: string): string {
  return path.join(grokHome, 'auth.json');
}
