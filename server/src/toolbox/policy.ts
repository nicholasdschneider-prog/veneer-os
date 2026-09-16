import type Database from 'better-sqlite3';
import { z } from 'zod';

/**
 * Per-connection tool policy (spec §11.2). A `default` action plus an ordered
 * list of `{match, action}` glob rules; FIRST matching rule wins, else the
 * default applies. Actions:
 *   allow   — pre-allowlisted (materialized into settings.permissions.allow)
 *   approve — runtime human approval (falls through to the control_request path)
 *   deny    — blocked (materialized into settings.permissions.deny)
 *
 * Every policy JSON is zod-validated on every boundary (read from DB, written
 * from the API, consumed by the materializer).
 */

export const PolicyActionSchema = z.enum(['allow', 'approve', 'deny']);
export type PolicyAction = z.infer<typeof PolicyActionSchema>;

export const PolicyRuleSchema = z.object({
  match: z.string().trim().min(1).max(200),
  action: PolicyActionSchema,
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicySchema = z.object({
  default: PolicyActionSchema.default('approve'),
  rules: z.array(PolicyRuleSchema).max(100).default([]),
});
export type Policy = z.infer<typeof PolicySchema>;

/** Parse untrusted policy JSON (string or object); throws on invalid shape. */
export function parsePolicy(input: unknown): Policy {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  return PolicySchema.parse(raw ?? {});
}

/** Lenient parse for DB rows we wrote — never throw, fall back to a safe default. */
export function parsePolicySafe(input: unknown): Policy {
  try {
    return parsePolicy(input);
  } catch {
    return { default: 'approve', rules: [] };
  }
}

/**
 * Glob → RegExp. `*` matches any run of characters (including none); every
 * other character is matched literally. Anchored full-string, case-sensitive
 * (tool names are case-sensitive).
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function globMatches(glob: string, value: string): boolean {
  return globToRegExp(glob).test(value);
}

/** First-match-wins decision for one tool against one policy (spec §11.2). */
export function decideAction(toolName: string, policy: Policy): PolicyAction {
  for (const rule of policy.rules) {
    if (globMatches(rule.match, toolName)) return rule.action;
  }
  return policy.default;
}

/**
 * Convert a policy into allow/deny pattern lists for a Claude `--settings`
 * file. `approve` rules and an `approve` default produce NO patterns — those
 * tools fall through to the runtime control_request approval path (§7.2).
 *
 * `scopePrefix` (e.g. `mcp__shopify__`) scopes a non-approve default to just
 * this connection's tools via a `<prefix>*` catch-all, so a connection's
 * default never clobbers unrelated tools. Built-in policy passes no prefix
 * (its rules are literal tool names / global globs).
 */
export function policyToPermissions(policy: Policy, scopePrefix?: string): { allow: string[]; deny: string[] } {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const rule of policy.rules) {
    if (rule.action === 'allow') allow.push(rule.match);
    else if (rule.action === 'deny') deny.push(rule.match);
  }
  if (scopePrefix) {
    if (policy.default === 'allow') allow.push(`${scopePrefix}*`);
    else if (policy.default === 'deny') deny.push(`${scopePrefix}*`);
  }
  return { allow, deny };
}

// ── Built-in tools policy (global, stored in settings) ──────────────────────
// Governs Claude's own tools (Bash, WebSearch, Read, …). The v1 defaults
// reproduce the shipped behavior: Bash denied, WebSearch/WebFetch allowed,
// everything else falls through to acceptEdits + approval.

const BUILTIN_POLICY_KEY = 'builtin_tools_policy';

export const DEFAULT_BUILTIN_POLICY: Policy = {
  default: 'approve',
  rules: [
    { match: 'Bash', action: 'deny' },
    { match: 'WebSearch', action: 'allow' },
    { match: 'WebFetch', action: 'allow' },
    { match: 'AskUserQuestion', action: 'allow' },
    { match: 'TodoWrite', action: 'allow' },
  ],
};

export function getBuiltinPolicy(db: Database.Database): Policy {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(BUILTIN_POLICY_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return DEFAULT_BUILTIN_POLICY;
  return parsePolicySafe(row.value_json);
}

export function setBuiltinPolicy(db: Database.Database, policy: Policy): void {
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(BUILTIN_POLICY_KEY, JSON.stringify(policy));
}
