import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolveCurrentAgentToken } from '../runtime/agentTokenFile.js';

/**
 * Stdio JSON-RPC → HTTP proxy for the Veneer Browser MCP, used by Codex chats.
 *
 * Codex has no header support for streamable-HTTP MCP servers, and the
 * `mcp-remote` wrapper it previously used froze the per-turn agent token in the
 * thread's persisted env: after the token expired the 401 was mistaken for an
 * OAuth challenge and every browser call failed with a Dynamic Client
 * Registration error. This proxy resolves the token on EVERY request through
 * the per-conversation token file (see runtime/agentTokenFile.ts), so a
 * relaunched process with a stale VP_AGENT_TOKEN still sends the current one.
 *
 * Never logs headers or bodies.
 */

export interface ProxyEnv {
  VP_VENEER_BROWSER_URL?: string;
  VP_AGENT_TOKEN?: string;
  VP_CONVERSATION_ID?: string;
  VP_AGENT_TOKEN_FILE?: string;
}

export function resolveProxyToken(env: ProxyEnv): string {
  return resolveCurrentAgentToken(env.VP_AGENT_TOKEN ?? '', env.VP_CONVERSATION_ID ?? '', env.VP_AGENT_TOKEN_FILE);
}

function jsonRpcError(id: unknown, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } });
}

/**
 * Forward one JSON-RPC message. Returns the line to write to stdout, or null
 * when nothing should be written (notifications, 202 responses).
 */
export async function forwardMessage(
  line: string,
  env: ProxyEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let message: { id?: unknown; method?: unknown };
  try {
    message = JSON.parse(trimmed) as { id?: unknown; method?: unknown };
  } catch {
    return jsonRpcError(null, 'Parse error');
  }
  const id = message.id;
  const isNotification = id === undefined || id === null;
  const url = env.VP_VENEER_BROWSER_URL ?? '';
  if (!url) return isNotification ? null : jsonRpcError(id, 'Veneer Browser MCP URL is not configured.');

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-VP-Agent-Token': resolveProxyToken(env) },
      body: trimmed,
    });
  } catch (err) {
    return isNotification ? null : jsonRpcError(id, `Veneer Browser MCP unreachable: ${(err as Error).message}`);
  }
  const text = await res.text().catch(() => '');
  if (res.status === 202 || isNotification) return null;
  if (!res.ok) {
    let detail = '';
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === 'string') detail = parsed.error;
    } catch {
      /* non-JSON body: omit it */
    }
    return jsonRpcError(id, `Veneer Browser MCP returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const body = text.trim();
  return body ? body : null;
}

export function runProxy(env: ProxyEnv = process.env as ProxyEnv): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = 0;
  let closed = false;
  const maybeExit = () => {
    if (closed && pending === 0) process.exit(0);
  };
  rl.on('line', (line) => {
    pending += 1;
    void forwardMessage(line, env)
      .then((out) => {
        if (out) process.stdout.write(`${out}\n`);
      })
      .finally(() => {
        pending -= 1;
        maybeExit();
      });
  });
  // Let in-flight requests finish before exiting on stdin close.
  rl.on('close', () => {
    closed = true;
    maybeExit();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) runProxy();
