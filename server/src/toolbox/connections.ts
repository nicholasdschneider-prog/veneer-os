import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ConnectionRow } from '../db/db.js';
import { parsePolicySafe, PolicySchema, type Policy } from './policy.js';

/**
 * Connection config storage + secret hygiene (spec §11, workstream A.16).
 *
 * MCP env values and HTTP headers may carry secrets, so `config_json` is
 * treated like `secrets.json`: never logged, and never returned raw over the
 * API. Reads return a MASKED view (secret values blanked, keys preserved) plus
 * `hasSecrets`; writes are write-only — a blanked value means "keep the stored
 * secret", a new value replaces it, a removed key drops it.
 */

const SecretMap = z.record(z.string(), z.string());

export const McpStdioConfigSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().trim().min(1).max(500),
  args: z.array(z.string().max(2000)).max(50).default([]),
  env: SecretMap.default({}),
});
export const McpRemoteConfigSchema = z.object({
  transport: z.enum(['http', 'sse']),
  url: z.string().trim().url().max(2000),
  headers: SecretMap.default({}),
});
export const McpConfigSchema = z.discriminatedUnion('transport', [McpStdioConfigSchema, McpRemoteConfigSchema]);
export type McpConfig = z.infer<typeof McpConfigSchema>;

/** Parse untrusted MCP config; throws on invalid shape. */
export function parseConnectionConfig(raw: unknown): McpConfig {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return McpConfigSchema.parse(obj);
}

/** Which map on an mcp config holds secrets: env for stdio, headers for remote. */
function secretMapOf(config: McpConfig): Record<string, string> {
  return config.transport === 'stdio' ? config.env : config.headers;
}

/** Masked view for API responses: secret values blanked to '', keys kept. */
export function maskConfig(config: McpConfig): { config: unknown; hasSecrets: boolean } {
  const c = config;
  const secrets = secretMapOf(c);
  const masked = Object.fromEntries(Object.keys(secrets).map((k) => [k, '']));
  const hasSecrets = Object.values(secrets).some((v) => v.trim().length > 0);
  if (c.transport === 'stdio') return { config: { ...c, env: masked }, hasSecrets };
  return { config: { ...c, headers: masked }, hasSecrets };
}

/**
 * Merge an incoming (masked-aware) config with the stored one: blank secret
 * values keep the stored secret; non-blank replace; keys absent from the
 * incoming map are dropped.
 */
export function mergeConfigSecrets(
  incoming: McpConfig,
  existing: McpConfig | null,
): McpConfig {
  if (!existing) return incoming;
  const inc = incoming;
  const old = existing;
  const oldSecrets = old.transport === inc.transport ? secretMapOf(old) : {};
  const merge = (m: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.trim() === '' && oldSecrets[k] ? oldSecrets[k]! : v]));
  if (inc.transport === 'stdio') return { ...inc, env: merge(inc.env) };
  return { ...inc, headers: merge(inc.headers) };
}

/** lowercase, alnum + underscore; safe as an mcp server key (`mcp__<slug>__…`). */
export function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return base || 'connection';
}

export function uniqueSlug(db: Database.Database, name: string): string {
  const base = slugify(name);
  const exists = db.prepare('SELECT 1 FROM connections WHERE slug = ?');
  if (!exists.get(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!exists.get(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

/** Full parsed policy for a row (never throws). */
export function policyOf(row: ConnectionRow): Policy {
  return parsePolicySafe(row.policy_json);
}

/** API-safe view of a connection: masked config, parsed policy, derived flags. */
export function connectionView(row: ConnectionRow): Record<string, unknown> {
  let config: McpConfig;
  try {
    config = parseConnectionConfig(row.config_json);
  } catch {
    config = { transport: 'stdio', command: '', args: [], env: {} };
  }
  const { config: masked, hasSecrets } = maskConfig(config);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    enabled: Boolean(row.enabled),
    managedBy: row.managed_by,
    config: masked,
    hasSecrets,
    policy: policyOf(row),
    createdAt: row.created_at,
  };
}

// Re-exported so routes validate the whole write body in one place.
export { PolicySchema };
