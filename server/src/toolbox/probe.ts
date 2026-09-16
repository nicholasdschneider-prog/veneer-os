import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { proServiceEnv } from '../homes.js';
import type { McpConfig } from './connections.js';

/**
 * One-click MCP connection probe (spec §9/§11.4): connect the server, run the
 * MCP `initialize` + `tools/list` handshake, report ok/error + tool names. This
 * is how the consultant verifies a connection remotely without SSH — no full
 * Claude turn, no auth needed.
 *
 * NEVER log the config — env/headers may carry secrets.
 */

export interface ProbeConnectionResult {
  ok: boolean;
  detail: string;
  tools: string[];
}

const PROBE_TIMEOUT_MS = 15_000;
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'veneer-pro-probe', version: '1' };

const initReq = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } };
const initializedNote = { jsonrpc: '2.0', method: 'notifications/initialized' };
const listReq = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

function toolNames(result: unknown): string[] {
  const tools = (result as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => (t as { name?: string })?.name).filter((n): n is string => typeof n === 'string');
}

export function probeConnection(config: McpConfig, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeConnectionResult> {
  return config.transport === 'stdio' ? probeStdio(config, timeoutMs) : probeRemote(config, timeoutMs);
}

function probeStdio(config: Extract<McpConfig, { transport: 'stdio' }>, timeoutMs: number): Promise<ProbeConnectionResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(config.command, config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...proServiceEnv(), ...config.env },
      });
    } catch (err) {
      resolve({ ok: false, detail: `Could not start the server: ${(err as Error).message}`, tools: [] });
      return;
    }

    let done = false;
    let stderrTail = '';
    const finish = (result: ProbeConnectionResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, detail: `The server did not respond within ${Math.round(timeoutMs / 1000)}s.`, tools: [] }),
      timeoutMs,
    );

    const write = (obj: unknown): void => {
      try {
        child.stdin?.write(JSON.stringify(obj) + '\n');
      } catch {
        /* pipe closed */
      }
    };

    child.stderr?.on('data', (c: Buffer) => {
      stderrTail = (stderrTail + c.toString('utf8')).slice(-1500);
    });
    child.on('error', (err) => finish({ ok: false, detail: err.message, tools: [] }));
    child.on('close', (code) => {
      if (!done) {
        const detail = stderrTail.trim().split('\n').pop() || `The server exited (code ${code}) before listing tools.`;
        finish({ ok: false, detail: detail.slice(0, 200), tools: [] });
      }
    });

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        return; // servers sometimes print banners; skip non-JSON lines
      }
      if (msg.id === 1) {
        if (msg.error) return finish({ ok: false, detail: msg.error.message ?? 'initialize failed', tools: [] });
        write(initializedNote);
        write(listReq);
      } else if (msg.id === 2) {
        if (msg.error) return finish({ ok: false, detail: msg.error.message ?? 'tools/list failed', tools: [] });
        const names = toolNames(msg.result);
        finish({ ok: true, detail: `Connected. ${names.length} tool${names.length === 1 ? '' : 's'} available.`, tools: names });
      }
    });

    write(initReq);
  });
}

/** Parse a body that is either a JSON object or an SSE stream of `data:` lines. */
function parseHttpBody(text: string, wantId: number): { result?: unknown; error?: { message?: string } } | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  // SSE: find the data line carrying our response id.
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.*)$/);
    if (!m || !m[1]) continue;
    try {
      const obj = JSON.parse(m[1]);
      if (obj && obj.id === wantId) return obj;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

async function probeRemote(config: Extract<McpConfig, { transport: 'http' | 'sse' }>, timeoutMs: number): Promise<ProbeConnectionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...config.headers,
  };
  try {
    const initRes = await fetch(config.url, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify(initReq),
      signal: controller.signal,
    });
    if (!initRes.ok) {
      return { ok: false, detail: `Server returned HTTP ${initRes.status} on initialize.`, tools: [] };
    }
    const sessionId = initRes.headers.get('mcp-session-id');
    const initParsed = parseHttpBody(await initRes.text(), 1);
    if (initParsed?.error) return { ok: false, detail: initParsed.error.message ?? 'initialize failed', tools: [] };

    const listHeaders = { ...baseHeaders, ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) };
    // Fire-and-forget the initialized notification (some servers require it).
    await fetch(config.url, { method: 'POST', headers: listHeaders, body: JSON.stringify(initializedNote), signal: controller.signal }).catch(() => undefined);
    const listRes = await fetch(config.url, {
      method: 'POST',
      headers: listHeaders,
      body: JSON.stringify(listReq),
      signal: controller.signal,
    });
    if (!listRes.ok) return { ok: false, detail: `Server returned HTTP ${listRes.status} on tools/list.`, tools: [] };
    const listParsed = parseHttpBody(await listRes.text(), 2);
    if (!listParsed) return { ok: false, detail: 'Could not parse the server response.', tools: [] };
    if (listParsed.error) return { ok: false, detail: listParsed.error.message ?? 'tools/list failed', tools: [] };
    const names = toolNames(listParsed.result);
    return { ok: true, detail: `Connected. ${names.length} tool${names.length === 1 ? '' : 's'} available.`, tools: names };
  } catch (err) {
    const e = err as Error;
    const detail = e.name === 'AbortError' ? `The server did not respond within ${Math.round(timeoutMs / 1000)}s.` : e.message;
    return { ok: false, detail: detail.slice(0, 200), tools: [] };
  } finally {
    clearTimeout(timer);
  }
}
