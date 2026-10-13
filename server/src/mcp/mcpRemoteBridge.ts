import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * Stdio wrapper around the pinned `mcp-remote` bridge for Codex chats.
 *
 * Codex 0.162 keeps a process-wide cache of each MCP server's tool catalog and,
 * while an optional server is still starting, binds those cached tools with no
 * live client. When the bridge then times out or the connection set is rebuilt
 * (cancelling the startup), the model holds tools it cannot call ("… is not a
 * function" / "not available to the model"). A server opts out of that cache
 * by advertising `capabilities.experimental["codex/tool-catalog-cache"]
 * .cacheable = false` in its initialize result (codex-mcp rmcp_client.rs), so
 * Codex either waits for the live connection or omits the server. Composio
 * does not send that flag, so this wrapper adds it to the initialize response
 * and passes every other line through untouched.
 *
 * It also launches mcp-remote from the local install with this node binary
 * instead of `npx -y`, so a burst of lanes does not pay an npx resolution per
 * server per thread. Never logs headers or bodies.
 */

export const MCP_REMOTE_VERSION = '0.14.3';

const require = createRequire(import.meta.url);

export function resolveMcpRemoteProxy(): string | null {
  try {
    return require.resolve('mcp-remote/dist/proxy.js');
  } catch {
    return null;
  }
}

/** Mark an initialize result as not cacheable; any other line comes back unchanged. */
export function markInitializeUncacheable(line: string): string {
  if (!line.includes('"protocolVersion"')) return line;
  let message: { id?: unknown; result?: { protocolVersion?: unknown; capabilities?: Record<string, unknown> } };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return line;
  }
  const result = message.result;
  if (!result || typeof result !== 'object' || typeof result.protocolVersion !== 'string' || message.id === undefined) {
    return line;
  }
  const capabilities = result.capabilities && typeof result.capabilities === 'object' ? result.capabilities : {};
  const experimental =
    capabilities.experimental && typeof capabilities.experimental === 'object'
      ? (capabilities.experimental as Record<string, unknown>)
      : {};
  result.capabilities = {
    ...capabilities,
    experimental: { ...experimental, 'codex/tool-catalog-cache': { cacheable: false } },
  };
  return JSON.stringify(message);
}

function main(): void {
  const proxy = resolveMcpRemoteProxy();
  const [command, args] = proxy
    ? [process.execPath, [proxy, ...process.argv.slice(2)]]
    : ['npx', ['-y', `mcp-remote@${MCP_REMOTE_VERSION}`, ...process.argv.slice(2)]];
  if (!proxy) process.stderr.write('[mcp-remote-bridge] local mcp-remote not found; falling back to npx\n');
  const child = spawn(command, args, { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => undefined);
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    process.stdout.write(`${markInitializeUncacheable(line)}\n`);
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', (err) => {
    process.stderr.write(`[mcp-remote-bridge] failed to start mcp-remote: ${err.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    lines.close();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
