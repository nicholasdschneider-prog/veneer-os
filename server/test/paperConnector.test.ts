import { describe, expect, it } from 'vitest';
import {
  PAPER_DEFAULT_MCP_URL,
  isLoopbackPaperUrl,
  resolvePaperMcpUrl,
  validatePaperSettings,
} from '../src/connectors/paper/config.js';
import {
  PAPER_NOT_MCP_MESSAGE,
  PAPER_TIMEOUT_MESSAGE,
  PAPER_WRONG_PATH_MESSAGE,
  parseMcpPayload,
  testPaperConnection,
} from '../src/connectors/paper/health.js';
import { CONNECTOR_DEFS, connectorMcpConfig } from '../src/connectors/catalog.js';

const paperDef = CONNECTOR_DEFS.find((def) => def.slug === 'paper')!;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('paper connector settings', () => {
  it('falls back to this machine when no URL is configured', () => {
    expect(resolvePaperMcpUrl({})).toBe(PAPER_DEFAULT_MCP_URL);
    expect(resolvePaperMcpUrl({ url: '   ' })).toBe(PAPER_DEFAULT_MCP_URL);
  });

  it('keeps a configured remote URL so Paper can live on another machine', () => {
    expect(resolvePaperMcpUrl({ url: ' http://100.78.101.60:29979/mcp ' })).toBe('http://100.78.101.60:29979/mcp');
  });

  it('accepts a blank URL but rejects malformed ones', () => {
    expect(validatePaperSettings({})).toBeNull();
    expect(validatePaperSettings({ url: 'http://127.0.0.1:29979/mcp' })).toBeNull();
    expect(validatePaperSettings({ url: 'not a url' })).toMatch(/full Paper MCP URL/);
    expect(validatePaperSettings({ url: 'ftp://127.0.0.1/mcp' })).toMatch(/http:\/\/ or https:\/\//);
  });

  it('recognises loopback so the UI only warns about real exposure', () => {
    expect(isLoopbackPaperUrl(PAPER_DEFAULT_MCP_URL)).toBe(true);
    expect(isLoopbackPaperUrl('http://localhost:29979/mcp')).toBe(true);
    expect(isLoopbackPaperUrl('http://[::1]:29979/mcp')).toBe(true);
    expect(isLoopbackPaperUrl('http://100.78.101.60:29979/mcp')).toBe(false);
    expect(isLoopbackPaperUrl('nonsense')).toBe(false);
  });
});

describe('paper catalog entry', () => {
  it('materializes as an http MCP server at the default endpoint', () => {
    expect(connectorMcpConfig(paperDef, JSON.stringify({ settings: {} }))).toEqual({
      transport: 'http',
      url: PAPER_DEFAULT_MCP_URL,
      headers: {},
    });
  });

  it('materializes a configured remote endpoint unchanged', () => {
    expect(connectorMcpConfig(paperDef, JSON.stringify({ settings: { url: 'http://100.78.101.60:29979/mcp' } }))).toEqual({
      transport: 'http',
      url: 'http://100.78.101.60:29979/mcp',
      headers: {},
    });
  });

  it('refuses to materialize invalid settings rather than guessing', () => {
    expect(connectorMcpConfig(paperDef, JSON.stringify({ settings: { url: 'not a url' } }))).toBeNull();
  });
});

describe('paper health probe', () => {
  const INITIALIZE_RESULT = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'paper-desktop', version: '0.5.5' },
    },
  };

  function sseResponse(payload: unknown, sessionId = 'session-1'): Response {
    return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'mcp-session-id': sessionId },
    });
  }

  it('reads the JSON-RPC payload out of an SSE frame or plain JSON', () => {
    expect(parseMcpPayload(`event: message\ndata: {"result":1}\n\n`)).toEqual({ result: 1 });
    expect(parseMcpPayload('{"result":2}')).toEqual({ result: 2 });
    expect(parseMcpPayload('not json')).toBeNull();
  });

  it('reports a live Paper as connected after a real initialize handshake', async () => {
    const calls: { method: string | undefined; hasBody: boolean }[] = [];
    const health = await testPaperConnection(PAPER_DEFAULT_MCP_URL, {
      fetch: async (_url, init) => {
        calls.push({ method: init?.method, hasBody: Boolean(init?.body) });
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        return sseResponse(INITIALIZE_RESULT);
      },
      now: () => 0,
    });
    expect(health).toMatchObject({ ok: true, status: 'connected', error: null });
    // The handshake must be a POST; a GET would 404 on a perfectly healthy Paper.
    expect(calls[0]).toEqual({ method: 'POST', hasBody: true });
    expect(calls[1]?.method).toBe('DELETE');
  });

  // Regression: Streamable HTTP answers an unauthenticated GET with 404
  // "Session not found" even when Paper is healthy, so probing must not use GET.
  it('does not treat a bare "Session not found" as the endpoint state', async () => {
    const health = await testPaperConnection(PAPER_DEFAULT_MCP_URL, {
      fetch: async (_url, init) => {
        if (init?.method !== 'POST') {
          return new Response(JSON.stringify({ error: 'not_found', error_description: 'Session not found' }), { status: 404 });
        }
        return sseResponse(INITIALIZE_RESULT);
      },
      now: () => 0,
    });
    expect(health.ok).toBe(true);
  });

  it('names the /mcp path when the URL reached Paper but the wrong route', async () => {
    const health = await testPaperConnection('http://127.0.0.1:29979/', {
      fetch: async () =>
        new Response(JSON.stringify({ status: 'not_found', message: 'Route not found. The MCP endpoint is /mcp.' }), {
          status: 404,
        }),
      now: () => 0,
    });
    expect(health.error).toBe(PAPER_WRONG_PATH_MESSAGE);
  });

  it('rejects a host that answers but is not Paper', async () => {
    const health = await testPaperConnection('http://100.78.101.60:29979/mcp', {
      fetch: async () => new Response('<html>hello</html>', { status: 200 }),
      now: () => 0,
    });
    expect(health.ok).toBe(false);
    expect(health.error).toBe(PAPER_NOT_MCP_MESSAGE);
  });

  it('tells the user where nothing answered', async () => {
    const health = await testPaperConnection('http://100.78.101.60:29979/mcp', {
      fetch: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' });
      },
      now: () => 0,
    });
    expect(health.ok).toBe(false);
    expect(health.error).toContain('http://100.78.101.60:29979/mcp');
    expect(health.timeoutStage).toBeNull();
  });

  it('separates a timeout from an unreachable host', async () => {
    const health = await testPaperConnection(PAPER_DEFAULT_MCP_URL, {
      fetch: async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      },
      now: () => 0,
    });
    expect(health.error).toBe(PAPER_TIMEOUT_MESSAGE);
    expect(health.timeoutStage).toBe('request');
  });
});
