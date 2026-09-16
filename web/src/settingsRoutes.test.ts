import { describe, expect, it } from 'vitest';
import { resolveSettingsRoute } from './App';

describe('settings route compatibility', () => {
  it.each([
    ['#/settings/accounts', '#/settings/providers?tab=providers'],
    ['#/settings/providers?tab=usage', '#/settings/usage'],
    ['#/settings/providers?tab=defaults', '#/settings/providers?tab=providers'],
    ['#/settings/chat', '#/settings/providers'],
    ['#/settings/chat?tab=defaults', '#/settings/providers?tab=providers'],
    ['#/settings/chat?tab=history', '#/settings/providers?tab=history'],
    ['#/settings/chat?tab=voice', '#/settings/providers?tab=voice'],
    ['#/settings/chats', '#/settings/providers?tab=history'],
    ['#/settings/chattitles', '#/settings/providers?tab=history'],
    ['#/settings/voice', '#/settings/providers?tab=voice'],
    ['#/settings/connectors', '#/settings/connections?tab=apps'],
    ['#/connectors?connected=1', '#/settings/connections?connected=1&tab=apps'],
    ['#/toolbox', '#/settings/connections?tab=mcp'],
    ['#/skills', '#/settings/skills'],
    ['#/settings/apikeys', '#/settings/credentials?tab=keys'],
    ['#/settings/doppler', '#/settings/credentials?tab=vault'],
    ['#/settings/users', '#/settings/people'],
  ])('redirects %s to %s', (legacy, canonical) => {
    expect(resolveSettingsRoute(legacy)?.canonicalHash).toBe(canonical);
  });

  it('preserves current settings routes and query parameters', () => {
    expect(resolveSettingsRoute('#/settings/usage')).toEqual({
      section: 'usage',
      canonicalHash: '#/settings/usage',
    });
    expect(resolveSettingsRoute('#/settings/navigation')).toEqual({
      section: 'navigation',
      canonicalHash: '#/settings/navigation',
    });
    expect(resolveSettingsRoute('#/settings/browser')).toEqual({
      section: 'browser',
      canonicalHash: '#/settings/browser',
    });
    expect(resolveSettingsRoute('#/settings/connections?tab=mcp&project=42')).toEqual({
      section: 'connections',
      canonicalHash: '#/settings/connections?tab=mcp&project=42',
    });
  });
});
