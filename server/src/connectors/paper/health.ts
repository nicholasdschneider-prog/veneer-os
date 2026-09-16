import { PAPER_DEFAULT_MCP_URL } from './config.js';

/**
 * Liveness probe for a Paper Desktop MCP endpoint.
 *
 * Readiness has to be decided with a real MCP `initialize` handshake. A bare
 * GET is NOT a usable signal: Streamable HTTP reserves GET for reopening the
 * SSE stream of an existing session, so a running, perfectly healthy Paper
 * answers an unauthenticated GET with 404 `Session not found` forever. Probing
 * that way reports a working endpoint as broken.
 *
 * Verified against Paper 0.5.5: POST `initialize` returns 200, an
 * `mcp-session-id` header and a `serverInfo` of `paper-desktop`, and the
 * session is then released with DELETE so probes do not accumulate sessions.
 */

export interface PaperHealthResult {
  ok: boolean;
  status: 'connected' | 'error';
  error: string | null;
  timeoutStage: 'request' | null;
  timings: { tokenMs: number | null; queryMs: number | null; totalMs: number };
}

export const PAPER_PROBE_TIMEOUT_MS = 8000;

export const PAPER_WRONG_PATH_MESSAGE =
  `That URL reached Paper but not its MCP endpoint. The path must be /mcp, as in ${PAPER_DEFAULT_MCP_URL}.`;
export const PAPER_TIMEOUT_MESSAGE = 'Paper did not answer in time. Check that the app is running and responsive.';
export const PAPER_NOT_MCP_MESSAGE =
  'Something answered at that URL but it is not a Paper MCP endpoint. Check the address, and that Paper Desktop is running.';

export interface PaperProbeRuntime {
  fetch?: typeof fetch;
  now?: () => number;
}

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'veneer-pro', version: '1.0' },
  },
});

function unreachableMessage(url: string): string {
  return `Nothing answered at ${url}. Open Paper Desktop on that machine, or correct the URL.`;
}

/** Pull the JSON-RPC payload out of either a plain JSON or an SSE response. */
export function parseMcpPayload(body: string): Record<string, unknown> | null {
  const candidates = body.includes('data:')
    ? body.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
    : [body.trim()];
  for (const candidate of candidates) {
    if (!candidate.startsWith('{')) continue;
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      /* try the next frame */
    }
  }
  return null;
}

function serverName(payload: Record<string, unknown> | null): string | null {
  const result = payload?.result as { serverInfo?: { name?: unknown } } | undefined;
  const name = result?.serverInfo?.name;
  return typeof name === 'string' ? name : null;
}

export async function testPaperConnection(
  url: string,
  runtime: PaperProbeRuntime = {},
): Promise<PaperHealthResult> {
  const doFetch = runtime.fetch ?? fetch;
  const now = runtime.now ?? (() => Date.now());
  const started = now();
  const finish = (partial: Omit<PaperHealthResult, 'timings'>): PaperHealthResult => ({
    ...partial,
    timings: { tokenMs: null, queryMs: null, totalMs: Math.max(0, now() - started) },
  });

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: INITIALIZE_BODY,
      signal: AbortSignal.timeout(PAPER_PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name ?? '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return finish({
      ok: false,
      status: 'error',
      error: timedOut ? PAPER_TIMEOUT_MESSAGE : unreachableMessage(url),
      timeoutStage: timedOut ? 'request' : null,
    });
  }

  const body = await response.text().catch(() => '');
  if (/route not found/i.test(body)) {
    return finish({ ok: false, status: 'error', error: PAPER_WRONG_PATH_MESSAGE, timeoutStage: null });
  }

  const payload = parseMcpPayload(body);
  if (!response.ok || !serverName(payload)) {
    return finish({ ok: false, status: 'error', error: PAPER_NOT_MCP_MESSAGE, timeoutStage: null });
  }

  // Best effort: hand the session back so repeated tests do not pile up.
  const sessionId = response.headers.get('mcp-session-id');
  if (sessionId) {
    await doFetch(url, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId },
      signal: AbortSignal.timeout(PAPER_PROBE_TIMEOUT_MS),
    }).catch(() => undefined);
  }

  return finish({ ok: true, status: 'connected', error: null, timeoutStage: null });
}
