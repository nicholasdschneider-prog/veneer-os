import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDopplerTokenStore,
  dopplerSecretStdin,
  DopplerRuntime,
  redactDopplerError,
  validateDopplerIdentity,
} from '../src/secrets/doppler.js';

describe('client Doppler secret handling', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function store() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-doppler-'));
    dirs.push(dir);
    return createDopplerTokenStore(dir);
  }

  it('stores service tokens in a 0600 file and clears it completely', () => {
    const tokens = store();
    tokens.set({ runtimeToken: 'dp.st.runtime-test', agentToken: 'dp.st.agent-test' });
    expect(fs.statSync(tokens.file).mode & 0o777).toBe(0o600);
    expect(tokens.get()).toEqual(
      expect.objectContaining({
        runtimeToken: 'dp.st.runtime-test',
        agentToken: 'dp.st.agent-test',
      }),
    );
    tokens.clear();
    expect(fs.existsSync(tokens.file)).toBe(false);
  });

  it('keeps only an in-memory snapshot and preserves it across transient failures', async () => {
    const tokens = store();
    tokens.set({ runtimeToken: 'dp.st.runtime-test' });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            DOPPLER_PROJECT: 'client-one',
            DOPPLER_CONFIG: 'prd',
            OPENROUTER_API_KEY: 'runtime-value',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('temporary outage', { status: 503 }));
    const runtime = new DopplerRuntime(tokens, fetchImpl);

    expect((await runtime.refresh()).healthy).toBe(true);
    expect(runtime.get('OPENROUTER_API_KEY')).toBe('runtime-value');
    const degraded = await runtime.refresh();
    expect(degraded.healthy).toBe(false);
    expect(degraded.error).not.toContain('dp.st.runtime-test');
    expect(runtime.get('OPENROUTER_API_KEY')).toBe('runtime-value');
    expect(fs.readdirSync(path.dirname(tokens.file))).toEqual(['doppler.json']);
  });

  it('validates token identity and redacts tokens from provider errors', () => {
    expect(() =>
      validateDopplerIdentity(
        new Map([
          ['DOPPLER_PROJECT', 'wrong-client'],
          ['DOPPLER_CONFIG', 'prd'],
        ]),
        'expected-client',
        'prd',
      ),
    ).toThrow('wrong-client/prd');
    expect(redactDopplerError(new Error('request failed for dp.st.top-secret-token'))).toBe(
      'request failed for [redacted]',
    );
  });

  it('ends piped secret input with EOF instead of an interactive dot marker', () => {
    expect(dopplerSecretStdin('secret-value')).toBe('secret-value\n');
    expect(dopplerSecretStdin('line-one\nline-two')).toBe('line-one\nline-two\n');
    expect(dopplerSecretStdin('secret-value')).not.toContain('\n.\n');
  });
});
