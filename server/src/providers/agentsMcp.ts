import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * MCP servers lifted out of a materialized Claude-format mcp-config.json so
 * the Codex adapters can re-inject them — Codex can't read Claude's
 * --mcp-config file, but the server definitions translate to its config.toml
 * `mcp_servers` shape. Covers the built-in "agents" server (ask_user + the
 * cross-chat tools, per-turn agent token in env) AND user connectors/toolbox
 * servers (stdio or streamable HTTP).
 */

/** Built stdio proxy that forwards the Veneer Browser MCP over HTTP with a
 * per-request agent token (see mcp/veneerBrowserProxy.ts). */
export const VENEER_BROWSER_PROXY_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'mcp',
  'veneerBrowserProxy.js',
);

export type LiftedMcpServer =
  | { name: string; kind: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { name: string; kind: 'remote'; url: string; headers: Record<string, string> };

function strMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v);
  }
  return out;
}

export function readAllMcpServers(mcpConfigPath: string | null | undefined): LiftedMcpServer[] {
  if (!mcpConfigPath) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')) as {
      mcpServers?: Record<string, { command?: string; args?: unknown; env?: unknown; url?: string; headers?: unknown }>;
    };
    const out: LiftedMcpServer[] = [];
    for (const [name, s] of Object.entries(parsed.mcpServers ?? {})) {
      if (s.command) {
        out.push({ name, kind: 'stdio', command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: strMap(s.env) });
      } else if (s.url) {
        out.push({ name, kind: 'remote', url: s.url, headers: strMap(s.headers) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The same servers shaped as config.toml `mcp_servers.<name>` tables, ready
 * for the Codex App Server per-thread config override.
 *
 * Remote servers: Codex speaks streamable HTTP via `url` but has no arbitrary
 * `http_headers` support (verified 0.144.4: the key is silently ignored; only
 * bearer_token_env_var exists) — so servers that need headers are wrapped in
 * an `mcp-remote` stdio proxy, with header VALUES riding in env (mcp-remote
 * interpolates ${VAR}) so secrets stay out of argv. The built-in
 * `veneer_browser` server is the exception: it goes through our own stdio
 * proxy so the agent token is re-read per request instead of frozen with the
 * thread.
 */
export function codexMcpServers(mcpConfigPath: string | null | undefined): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const servers = readAllMcpServers(mcpConfigPath);
  // The agents stdio server already carries the conversation id and the
  // per-conversation token file; the browser proxy needs the same pair.
  const agents = servers.find((s) => s.name === 'agents' && s.kind === 'stdio');
  const conversationId = agents?.kind === 'stdio' ? agents.env.VP_CONVERSATION_ID ?? '' : '';
  const agentTokenFile = agents?.kind === 'stdio' ? agents.env.VP_AGENT_TOKEN_FILE ?? '' : '';
  for (const s of servers) {
    // Name becomes a TOML key segment / MCP server id — skip anything unsafe.
    if (!/^[A-Za-z0-9_-]+$/.test(s.name)) continue;
    if (s.kind === 'stdio') {
      out[s.name] = {
        command: s.command,
        args: s.args,
        ...(Object.keys(s.env).length ? { env: s.env } : {}),
        // ask_user blocks while the user answers; raise the per-call MCP tool
        // timeout above the server-side question window (10 min).
        ...(s.name === 'agents'
          ? {
              tool_timeout_sec: 960,
              // These tools only manage a durable continuation for the current
              // chat. Codex otherwise asks for a second approval and cannot
              // monitor unattended after the user already requested the wait.
              tools: {
                schedule_wakeup: { approval_mode: 'approve' },
                list_wakeups: { approval_mode: 'approve' },
                cancel_wakeup: { approval_mode: 'approve' },
              },
            }
          : s.name === 'veneer_browser'
            ? { tool_timeout_sec: 960 }
          : s.name === 'netsuite' || s.name.startsWith('netsuite-') || s.name === 'ringcentral' || s.name.startsWith('ringcentral-')
            ? { tool_timeout_sec: 45 }
            : {}),
      };
    } else if (Object.keys(s.headers).length === 0) {
      out[s.name] = { url: s.url };
    } else if (s.name === 'veneer_browser') {
      // Not mcp-remote: Codex persists the server env with the native thread
      // and relaunches with it on resume, so a token frozen in argv/env expires
      // after a few hours and mcp-remote then misreads the 401 as an OAuth
      // challenge. The proxy re-reads the token file on every request.
      out[s.name] = {
        command: process.execPath,
        args: [VENEER_BROWSER_PROXY_PATH],
        env: {
          VP_VENEER_BROWSER_URL: s.url,
          VP_AGENT_TOKEN: s.headers['X-VP-Agent-Token'] ?? '',
          ...(conversationId ? { VP_CONVERSATION_ID: conversationId } : {}),
          ...(agentTokenFile ? { VP_AGENT_TOKEN_FILE: agentTokenFile } : {}),
        },
        tool_timeout_sec: 960,
      };
    } else {
      const env: Record<string, string> = {};
      const args = ['-y', 'mcp-remote', s.url];
      Object.entries(s.headers).forEach(([key, value], i) => {
        const envVar = `MCP_HEADER_${i}`;
        env[envVar] = value;
        args.push('--header', `${key}:\${${envVar}}`);
      });
      out[s.name] = { command: 'npx', args, env };
    }
  }
  return out;
}

/**
 * ACP `McpServer` variants, as sent in `session/new` / `session/load`
 * `params.mcpServers` for the Grok adapter.
 *
 * The name/value ARRAYS are not a style choice — they are what the wire schema
 * accepts. Verified live 2026-08-12 against grok 1.0.3 (`grok agent stdio`):
 * sending `env`/`headers` as a plain object map is rejected with
 * `-32602 Invalid params: data did not match any variant of untagged enum
 * McpServer`, while the array form parses (it then reaches the auth check).
 */
export type GrokMcpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { name: string; type: 'http'; url: string; headers: { name: string; value: string }[] };

function nameValuePairs(raw: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(raw).map(([name, value]) => ({ name, value }));
}

/**
 * The same lifted servers shaped for Grok's ACP `mcpServers` array.
 *
 * Unlike Codex, Grok speaks streamable HTTP with arbitrary headers natively
 * (`initialize` reports `agentCapabilities.mcpCapabilities.http = true`), so
 * headered remote servers such as `veneer_browser` are passed through as-is —
 * no `mcp-remote` stdio proxy, and no header values in argv.
 *
 * This is the single shaping seam: if a future Grok build changes the wire
 * encoding, only this function and its unit test move.
 */
export function grokMcpServers(mcpConfigPath: string | null | undefined): GrokMcpServer[] {
  const out: GrokMcpServer[] = [];
  for (const s of readAllMcpServers(mcpConfigPath)) {
    // Name becomes an MCP server id and a tool-name prefix — skip anything unsafe.
    if (!/^[A-Za-z0-9_-]+$/.test(s.name)) continue;
    if (s.kind === 'stdio') {
      // `env` is a required field of the stdio variant, so it is always sent.
      out.push({ name: s.name, command: s.command, args: s.args, env: nameValuePairs(s.env) });
    } else {
      out.push({ name: s.name, type: 'http', url: s.url, headers: nameValuePairs(s.headers) });
    }
  }
  return out;
}
