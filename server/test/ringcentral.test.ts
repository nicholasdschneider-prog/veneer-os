import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CREDENTIALS = {
  serverUrl: 'https://platform.ringcentral.com',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  jwt: 'test-long-lived-jwt',
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('RingCentral credential destination and token handling', () => {
  it.each([
    ['https://platform.ringcentral.com', 'https://platform.ringcentral.com'],
    ['https://platform.ringcentral.com/', 'https://platform.ringcentral.com'],
    ['https://platform.devtest.ringcentral.com', 'https://platform.devtest.ringcentral.com'],
    ['', 'https://platform.ringcentral.com'],
  ])('allows only a reviewed RingCentral origin: %s', async (input, expected) => {
    const { normalizeRingCentralServerUrl } = await import('../src/connectors/ringcentral/config.js');
    expect(normalizeRingCentralServerUrl(input)).toBe(expected);
  });

  it.each([
    'http://platform.ringcentral.com',
    'https://attacker.example',
    'https://platform.ringcentral.com.attacker.example',
    'https://user:password@platform.ringcentral.com',
    'https://platform.ringcentral.com/restapi',
    'https://platform.ringcentral.com?redirect=attacker',
    'https://platform.ringcentral.com#fragment',
  ])('rejects an unsafe credential destination before network access: %s', async (serverUrl) => {
    const fetchMock = vi.fn();
    const { getRingCentralAccount } = await import('../src/connectors/ringcentral/client.js');
    await expect(getRingCentralAccount({ credentials: { ...CREDENTIALS, serverUrl }, runtime: { fetch: fetchMock } })).rejects.toThrow(/server URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the JWT bearer grant, blocks redirects, coalesces token minting, and caches only in process', async () => {
    let resolveToken!: (response: Response) => void;
    const tokenResponse = new Promise<Response>((resolve) => { resolveToken = resolve; });
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(tokenResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'account' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'extension' }), { status: 200 }));
    const { getRingCentralAccount, getRingCentralCurrentExtension } = await import('../src/connectors/ringcentral/client.js');
    const account = getRingCentralAccount({ credentials: CREDENTIALS, runtime: { fetch: fetchMock } });
    const extension = getRingCentralCurrentExtension({ credentials: CREDENTIALS, runtime: { fetch: fetchMock } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveToken(new Response(JSON.stringify({ access_token: 'short-lived-token', expires_in: 3600 }), { status: 200 }));

    await expect(Promise.all([account, extension])).resolves.toEqual([{ id: 'account' }, { id: 'extension' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(String(tokenUrl)).toBe('https://platform.ringcentral.com/restapi/oauth/token');
    expect(tokenInit).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(tokenInit.headers.Authorization).toBe(`Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`);
    expect(new URLSearchParams(tokenInit.body).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(new URLSearchParams(tokenInit.body).get('assertion')).toBe('test-long-lived-jwt');
    for (const call of fetchMock.mock.calls.slice(1)) {
      expect(call[1]).toMatchObject({ method: 'GET', redirect: 'error' });
      expect(call[1].headers.Authorization).toBe('Bearer short-lived-token');
    }
  });

  it('invalidates and refreshes a rejected short-lived token only once', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'old-token', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new-token', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'account' }), { status: 200 }));
    const { getRingCentralAccount } = await import('../src/connectors/ringcentral/client.js');

    await expect(getRingCentralAccount({ credentials: CREDENTIALS, runtime: { fetch: fetchMock } })).resolves.toEqual({ id: 'account' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer old-token');
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe('Bearer new-token');
  });

  it('mints a new token after the safe in-process cache window expires', async () => {
    let now = 1_000_000;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'first-token', expires_in: 100 }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'second-token', expires_in: 100 }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const { getRingCentralAccount } = await import('../src/connectors/ringcentral/client.js');
    const options = { credentials: CREDENTIALS, runtime: { fetch: fetchMock, now: () => now } };
    await getRingCentralAccount(options);
    now += 81_000;
    await getRingCentralAccount(options);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer first-token');
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe('Bearer second-token');
  });

  it('does not leak credentials, provider bodies, URLs, or transport errors', async () => {
    const providerBody = `invalid ${CREDENTIALS.clientSecret} ${CREDENTIALS.jwt}`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(providerBody, { status: 401 }));
    const { getRingCentralAccount } = await import('../src/connectors/ringcentral/client.js');

    let message = '';
    try {
      await getRingCentralAccount({ credentials: CREDENTIALS, runtime: { fetch: fetchMock } });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('authentication was rejected');
    expect(message).not.toContain(CREDENTIALS.clientId);
    expect(message).not.toContain(CREDENTIALS.clientSecret);
    expect(message).not.toContain(CREDENTIALS.jwt);
    expect(message).not.toContain(providerBody);
    expect(message).not.toContain('http');
  });
});

describe('RingCentral fixed read surface and bounds', () => {
  it('publishes only the reviewed read tools with closed schemas', async () => {
    const { RINGCENTRAL_TOOLS } = await import('../src/connectors/ringcentral/tools.js');
    expect(RINGCENTRAL_TOOLS.map((tool) => tool.name)).toEqual([
      'get_account',
      'get_current_extension',
      'list_extensions',
      'list_phone_numbers',
      'list_calls',
      'get_call',
      'get_recording',
    ]);
    expect(RINGCENTRAL_TOOLS.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
    expect(JSON.stringify(RINGCENTRAL_TOOLS)).not.toMatch(/proxy|execute|http_request|manage_connection|sandbox/i);
  });

  it('fails closed on unknown tools, extra fields, and wrong argument types', async () => {
    const { callRingCentralTool } = await import('../src/connectors/ringcentral/tools.js');
    await expect(callRingCentralTool('http_request', {})).resolves.toMatchObject({ isError: true });
    await expect(callRingCentralTool('get_account', { url: 'https://attacker.example' })).resolves.toMatchObject({
      isError: true,
      content: [{ text: 'Invalid RingCentral tool arguments.' }],
    });
    await expect(callRingCentralTool('list_calls', { recordingOnly: 'true' })).resolves.toMatchObject({ isError: true });
  });

  it.each([
    [{ page: 0 }, /page/],
    [{ perPage: 101 }, /perPage/],
    [{ dateFrom: '2025-01-01T00:00:00Z', dateTo: '2026-01-01T00:00:00Z' }, /90 days/],
    [{ phoneNumber: 'https://attacker.example' }, /phoneNumber/],
  ])('rejects an unsafe or unbounded call query before authentication', async (input, error) => {
    const fetchMock = vi.fn();
    const { listRingCentralCalls } = await import('../src/connectors/ringcentral/client.js');
    await expect(Promise.resolve().then(() => listRingCentralCalls(input, { credentials: CREDENTIALS, runtime: { fetch: fetchMock } }))).rejects.toThrow(error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['../token', 'abc/def', 'https://attacker.example', '', 'x'.repeat(201)])('rejects an unsafe record ID before authentication: %s', async (id) => {
    const fetchMock = vi.fn();
    const { getRingCentralCall } = await import('../src/connectors/ringcentral/client.js');
    await expect(Promise.resolve().then(() => getRingCentralCall(id, { credentials: CREDENTIALS, runtime: { fetch: fetchMock } }))).rejects.toThrow('Call ID is invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses fixed endpoints, bounded query values, and strips recording media links', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'must-not-pass-through',
        records: [{ id: 'call-1', secret: 'must-not-pass-through', recording: { id: 'recording-1', contentUri: 'https://media.example/private' } }],
      }), { status: 200 }));
    const { listRingCentralCalls } = await import('../src/connectors/ringcentral/client.js');
    const result = await listRingCentralCalls({
      dateFrom: '2026-08-01T00:00:00Z',
      dateTo: '2026-08-02T00:00:00Z',
      direction: 'Inbound',
      recordingOnly: true,
      page: 2,
      perPage: 25,
    }, { credentials: CREDENTIALS, runtime: { fetch: fetchMock } });

    expect(result).toEqual({ records: [{ id: 'call-1', recording: { id: 'recording-1' } }] });
    const url = new URL(String(fetchMock.mock.calls[1][0]));
    expect(url.origin).toBe('https://platform.ringcentral.com');
    expect(url.pathname).toBe('/restapi/v1.0/account/~/call-log');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      direction: 'Inbound', recordingType: 'All', view: 'Detailed', page: '2', perPage: '25',
    });
  });

  it('fails closed when a successful provider response is oversized', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'Content-Length': String(3 * 1024 * 1024) } }));
    const { getRingCentralAccount } = await import('../src/connectors/ringcentral/client.js');
    await expect(getRingCentralAccount({ credentials: CREDENTIALS, runtime: { fetch: fetchMock } })).rejects.toThrow('more data than the connector allows');
  });
});

describe('RingCentral catalog runtime', () => {
  it('builds a fixed stdio MCP process and fails closed for malformed settings', async () => {
    const { connectorDef, connectorMcpConfig } = await import('../src/connectors/catalog.js');
    const def = connectorDef('ringcentral')!;
    expect(def).toMatchObject({ slug: 'ringcentral', kind: 'custom' });
    const mcp = connectorMcpConfig(def, JSON.stringify({ settings: CREDENTIALS }));
    expect(mcp).toMatchObject({
      transport: 'stdio',
      command: process.execPath,
      env: {
        RC_SERVER_URL: CREDENTIALS.serverUrl,
        RC_CLIENT_ID: CREDENTIALS.clientId,
        RC_CLIENT_SECRET: CREDENTIALS.clientSecret,
        RC_JWT: CREDENTIALS.jwt,
      },
    });
    expect(JSON.stringify(mcp)).not.toMatch(/proxy|mcp-remote|composio/i);
    expect(connectorMcpConfig(def, JSON.stringify({ settings: { ...CREDENTIALS, serverUrl: 'https://attacker.example' } }))).toBeNull();
    expect(connectorMcpConfig(def, JSON.stringify({ settings: { ...CREDENTIALS, extra: 'unsupported' } }))).toBeNull();
    expect(connectorMcpConfig(def, JSON.stringify({ settings: { clientId: 'only-one-field' } }))).toBeNull();
  });
});
