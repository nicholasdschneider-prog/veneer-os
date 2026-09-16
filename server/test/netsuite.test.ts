import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string;

function configureNetSuite(accountId = '1234567_SB1'): void {
  vi.stubEnv('NS_ACCOUNT_ID', accountId);
  vi.stubEnv('NS_CLIENT_ID', 'test-client');
  vi.stubEnv('NS_CERT_ID', 'test-cert');
  vi.stubEnv('NS_PRIVATE_KEY_PEM', PRIVATE_KEY);
}

beforeEach(() => {
  vi.resetModules();
  configureNetSuite();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NetSuite REST credential boundary', () => {
  it('resolves supported paths only on the configured account origin', async () => {
    const { resolveNetSuiteUrl } = await import('../src/connectors/netsuite/nsClient.js');

    expect(resolveNetSuiteUrl('record/v1/customer?limit=5').toString()).toBe(
      'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/customer?limit=5',
    );
    expect(resolveNetSuiteUrl('/services/rest/record/v1/customer/123').toString()).toBe(
      'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/customer/123',
    );
  });

  it.each([
    'https://attacker.example/collect',
    'http://169.254.169.254/latest/meta-data',
    '//attacker.example/collect',
    '/record/v1/customer',
    'record\\v1\\customer',
  ])('rejects unsafe path %s before requesting a token', async (path) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { nsFetch } = await import('../src/connectors/netsuite/nsClient.js');

    await expect(nsFetch(path)).rejects.toThrow(/relative REST path|under \/services\/rest/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects account IDs that could change the credential destination', async () => {
    configureNetSuite('1234567.attacker.example');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { nsFetch } = await import('../src/connectors/netsuite/nsClient.js');

    await expect(nsFetch('record/v1/customer')).rejects.toThrow('Invalid NetSuite account ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('authenticates valid requests, blocks redirects, and reuses its isolated in-process token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'token-one', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: '1' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '2' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { nsFetch } = await import('../src/connectors/netsuite/nsClient.js');

    await expect(nsFetch('record/v1/customer', { query: { limit: '5' } })).resolves.toEqual({
      items: [{ id: '1' }],
    });
    await expect(
      nsFetch('record/v1/customer/2', { headers: { Authorization: 'Bearer attacker-controlled' } }),
    ).resolves.toEqual({ id: '2' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/customer?limit=5',
    );
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: expect.objectContaining({ Authorization: 'Bearer token-one', Accept: 'application/json' }),
    });
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer token-one' }),
    });
  });
});

describe('NetSuite bounded read behavior', () => {
  const silentRuntime = {
    log: { error: () => undefined },
    sleep: async () => undefined,
    random: () => 0,
  };

  it('retries transient read statuses, honors Retry-After, and then succeeds', async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'token-one', expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 503, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: 'safe-result' }] }), { status: 200 }));
    const { nsFetch } = await import('../src/connectors/netsuite/nsClient.js');

    await expect(
      nsFetch('record/v1/customer', {
        runtime: {
          ...silentRuntime,
          fetch: fetchMock,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      }),
    ).resolves.toEqual({ items: [{ id: 'safe-result' }] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([0]);
  });

  it('invalidates and refetches the token only once after a read-only 401', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'old-token', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new-token', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'ok' }), { status: 200 }));
    const { nsFetch } = await import('../src/connectors/netsuite/nsClient.js');

    await expect(
      nsFetch('record/v1/customer', { runtime: { ...silentRuntime, fetch: fetchMock } }),
    ).resolves.toEqual({ id: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1][1]?.headers.Authorization).toBe('Bearer old-token');
    expect(fetchMock.mock.calls[3][1]?.headers.Authorization).toBe('Bearer new-token');
  });

  it('never retries a write, including after a network failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 }))
      .mockRejectedValueOnce(new Error('socket included a sensitive URL'));
    const { nsFetch } = await import('../src/connectors/netsuite/nsClient.js');

    await expect(
      nsFetch('record/v1/customer', {
        method: 'POST',
        body: { private: 'business data' },
        runtime: { ...silentRuntime, fetch: fetchMock },
      }),
    ).rejects.toThrow('was not retried because it is not read-only');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts a stuck REST read on its explicit attempt deadline', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 }))
      .mockImplementationOnce((_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      );
    const { nsFetch } = await import('../src/connectors/netsuite/nsClient.js');

    await expect(
      nsFetch('record/v1/customer', {
        runtime: {
          ...silentRuntime,
          fetch: fetchMock,
          requestAttemptTimeoutMs: 10,
          totalTimeoutMs: 30,
          readMaxAttempts: 1,
        },
      }),
    ).rejects.toThrow('timed out during request');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('SuiteQL read-only boundary and diagnostics', () => {
  it('forwards only whitelist-validated NetSuite diagnostic stderr records', async () => {
    const {
      formatNetSuiteDiagnostic,
      forwardNetSuiteDiagnosticChunk,
      parseNetSuiteDiagnosticLine,
    } = await import('../src/connectors/netsuite/diagnostics.js');
    const safe = formatNetSuiteDiagnostic({
      event: 'request',
      operation: 'suiteql',
      attempt: 1,
      status: 200,
      durationMs: 321,
    });
    expect(parseNetSuiteDiagnosticLine(`codex mcp stderr: ${safe}`)).toBe(safe);
    expect(parseNetSuiteDiagnosticLine('[netsuite] {"component":"netsuite","event":"request","secret":"token"}')).toBeNull();
    expect(
      parseNetSuiteDiagnosticLine('[netsuite] {"component":"netsuite","event":"request","status":"private customer data"}'),
    ).toBeNull();

    const forwarded: string[] = [];
    let buffered = forwardNetSuiteDiagnosticChunk('', safe.slice(0, 30), { error: (line) => forwarded.push(String(line)) });
    buffered = forwardNetSuiteDiagnosticChunk(buffered, `${safe.slice(30)}\nunrelated stderr\n`, {
      error: (line) => forwarded.push(String(line)),
    });
    expect(buffered).toBe('');
    expect(forwarded).toEqual([safe]);
  });

  it.each([
    'SELECT id FROM customer',
    '-- lookup\nSELECT id FROM customer;',
    '/* bounded report */ WITH recent AS (SELECT id FROM customer) SELECT id FROM recent',
    "SELECT 'DELETE FROM customer' AS note FROM customer",
    'SELECT "UPDATE" FROM customer',
  ])('accepts a safe query including comments, quotes, and CTEs: %s', async (query) => {
    const { assertReadOnlySuiteql } = await import('../src/connectors/netsuite/nsClient.js');
    expect(() => assertReadOnlySuiteql(query)).not.toThrow();
  });

  it.each([
    'DELETE FROM customer',
    '/* misleading SELECT */ UPDATE customer SET name = name',
    'WITH changed AS (DELETE FROM customer) SELECT id FROM changed',
    'SELECT id FROM customer; DELETE FROM customer',
  ])('rejects write or multi-statement SuiteQL: %s', async (query) => {
    const { assertReadOnlySuiteql } = await import('../src/connectors/netsuite/nsClient.js');
    expect(() => assertReadOnlySuiteql(query)).toThrow(/read-only|one read-only statement/);
  });

  it('logs only safe structured timings, pages, row counts, and statuses', async () => {
    const lines: string[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'bearer-secret-value', expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'customer-record-8675309', email: 'private@example.com' }], hasMore: false }), {
          status: 200,
        }),
      );
    const { suiteql } = await import('../src/connectors/netsuite/nsClient.js');
    const query = 'SELECT id, email FROM customer WHERE email = private@example.com';
    await suiteql(query, {
      maxRows: 1,
      runtime: {
        fetch: fetchMock,
        log: { error: (line) => lines.push(String(line)) },
        sleep: async () => undefined,
        random: () => 0,
      },
    });

    const diagnosticText = lines.join('\n');
    expect(diagnosticText).toContain('"event":"token"');
    expect(diagnosticText).toContain('"event":"request"');
    expect(diagnosticText).toContain('"event":"page"');
    expect(diagnosticText).toContain('"event":"suiteql"');
    expect(diagnosticText).not.toContain('bearer-secret-value');
    expect(diagnosticText).not.toContain('customer-record-8675309');
    expect(diagnosticText).not.toContain('private@example.com');
    expect(diagnosticText).not.toContain('SELECT');
    expect(diagnosticText).not.toContain('suitetalk.api');
    expect(diagnosticText).not.toContain('1234567');
  });

  it('returns data-free health timings for success and safe authentication failure', async () => {
    const successFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'must-be-discarded' }], hasMore: false }), { status: 200 }),
      );
    const { testNetSuiteConnection } = await import('../src/connectors/netsuite/nsClient.js');
    const credentials = {
      accountId: '1234567_SB1',
      clientId: 'test-client',
      certId: 'test-cert',
      privateKey: PRIVATE_KEY,
    };
    const ok = await testNetSuiteConnection(credentials, {
      runtime: { fetch: successFetch, log: { error: () => undefined } },
    });
    expect(ok).toMatchObject({
      ok: true,
      status: 'connected',
      error: null,
      timeoutStage: null,
      timings: { tokenMs: expect.any(Number), queryMs: expect.any(Number), totalMs: expect.any(Number) },
    });
    expect(JSON.stringify(ok)).not.toContain('must-be-discarded');

    const failureFetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const failed = await testNetSuiteConnection(credentials, {
      runtime: {
        fetch: failureFetch,
        log: { error: () => undefined },
        tokenMaxAttempts: 1,
      },
    });
    expect(failed).toMatchObject({
      ok: false,
      status: 'error',
      error: expect.stringContaining('authentication was rejected'),
      timings: { tokenMs: null, queryMs: null, totalMs: expect.any(Number) },
    });
    expect(JSON.stringify(failed)).not.toContain('test-client');
  });
});
