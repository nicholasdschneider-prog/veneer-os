import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { applyPagesPublishingConfig } from '../src/routes/pagesConfig.js';

describe('Pages Cloudflare configuration', () => {
  it('uses the shared Cloudflare identity and client Doppler token with an explicit public base', () => {
    const config = loadConfig({
      VP_IDENTITY: 'dev',
      VP_APPS_CF_ACCOUNT_ID: 'account-1',
      VP_APPS_CF_ZONE_ID: 'zone-1',
      VP_APPS_PUBLIC_ORIGIN: 'https://example-client.example.com',
    });

    expect(config.pages).toBeNull();
    applyPagesPublishingConfig(
      config,
      {
        get: (name) => (name === 'VP_APPS_CF_API_TOKEN' ? 'shared-token' : null),
      },
      {
        VP_APPS_CF_ACCOUNT_ID: 'account-1',
        VP_APPS_CF_ZONE_ID: 'zone-1',
        VP_APPS_PUBLIC_ORIGIN: 'https://example-client.example.com',
        VP_PAGES_PUBLIC_BASE: 'https://pages.example.com',
      },
    );

    expect(config.pages).toEqual({
      accountId: 'account-1',
      apiToken: 'shared-token',
      bucket: 'veneer-pages',
      publicBase: 'https://pages.example.com',
    });
  });

  it('leaves pages unconfigured when no public base is set', () => {
    const config = loadConfig({
      VP_IDENTITY: 'dev',
      VP_APPS_CF_ACCOUNT_ID: 'account-1',
    });

    expect(config.pages).toBeNull();
    applyPagesPublishingConfig(
      config,
      { get: (name) => (name === 'VP_APPS_CF_API_TOKEN' ? 'shared-token' : null) },
      { VP_APPS_CF_ACCOUNT_ID: 'account-1' },
    );

    // No guessed public host: publishing stays off until VP_PAGES_PUBLIC_BASE exists.
    expect(config.pages).toBeNull();
  });

  it('does not clobber an already-configured pages block when the public base is missing', () => {
    const config = loadConfig({
      VP_IDENTITY: 'dev',
      VP_PAGES_CF_ACCOUNT_ID: 'pages-account',
      VP_PAGES_CF_API_TOKEN: 'env-pages-token',
      VP_PAGES_PUBLIC_BASE: 'https://pages.example.com',
    });

    expect(config.pages?.publicBase).toBe('https://pages.example.com');
    applyPagesPublishingConfig(
      config,
      { get: () => null },
      { VP_APPS_CF_ACCOUNT_ID: 'account-1', VP_APPS_CF_API_TOKEN: 'shared-token' },
    );

    expect(config.pages?.publicBase).toBe('https://pages.example.com');
  });

  it('prefers page-specific settings when they are present', () => {
    const config = loadConfig({
      VP_IDENTITY: 'dev',
      VP_APPS_CF_ACCOUNT_ID: 'apps-account',
      VP_PAGES_CF_ACCOUNT_ID: 'pages-account',
      VP_PAGES_BUCKET: 'custom-pages',
      VP_PAGES_PUBLIC_BASE: 'https://pages.example.com/',
      VP_PAGES_CF_API_TOKEN: 'env-pages-token',
    });

    applyPagesPublishingConfig(
      config,
      {
        get: (name) => (name === 'VP_PAGES_CF_API_TOKEN' ? 'doppler-pages-token' : null),
      },
      {
        VP_APPS_CF_ACCOUNT_ID: 'apps-account',
        VP_PAGES_CF_ACCOUNT_ID: 'pages-account',
        VP_PAGES_BUCKET: 'custom-pages',
        VP_PAGES_PUBLIC_BASE: 'https://pages.example.com/',
        VP_PAGES_CF_API_TOKEN: 'env-pages-token',
      },
    );

    expect(config.pages).toEqual({
      accountId: 'pages-account',
      apiToken: 'doppler-pages-token',
      bucket: 'custom-pages',
      publicBase: 'https://pages.example.com',
    });
  });
});
