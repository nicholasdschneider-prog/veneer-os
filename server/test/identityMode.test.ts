import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, warnIfDevIdentity } from '../src/config.js';
import { createIdentityResolver } from '../src/identity/cloudflareAccess.js';

describe('identity mode', () => {
  it('defaults to cloudflare and refuses to start without the Access settings', () => {
    expect(() => loadConfig({})).toThrow(/VP_IDENTITY=cloudflare requires/);
    expect(() => loadConfig({})).toThrow(/VP_IDENTITY=dev/);
    expect(() => loadConfig({ VP_CF_TEAM_DOMAIN: 'team.cloudflareaccess.com' })).toThrow(
      /VP_CF_AUD/,
    );
    expect(
      loadConfig({ VP_CF_TEAM_DOMAIN: 'team.cloudflareaccess.com', VP_CF_AUD: 'aud-1' }).identity,
    ).toBe('cloudflare');
  });

  it('resolves the fixed owner only when dev mode is explicit', async () => {
    const config = loadConfig({ VP_IDENTITY: 'dev' });
    expect(config.identity).toBe('dev');

    const resolve = createIdentityResolver(config);
    const identity = await resolve({ headers: {} } as IncomingMessage);
    expect(identity).toEqual({ email: config.devEmail });
  });

  it('warns once at startup in dev mode and stays quiet in cloudflare mode', () => {
    const warn = vi.fn();
    warnIfDevIdentity(loadConfig({ VP_IDENTITY: 'dev' }), { warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('localhost');

    warn.mockClear();
    const cloudflare = loadConfig({
      VP_CF_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      VP_CF_AUD: 'aud-1',
    });
    warnIfDevIdentity(cloudflare, { warn });
    expect(warn).not.toHaveBeenCalled();
  });
});
