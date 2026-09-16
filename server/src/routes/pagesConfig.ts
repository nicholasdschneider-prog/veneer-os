import type { Config } from '../config.js';

/**
 * Pages uses the same Cloudflare identity as Mini Apps by default. Keep this
 * web-only hydration here because the web service owns page publishing.
 */
export function applyPagesPublishingConfig(
  config: Config,
  doppler: { get(name: string): string | null },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const accountId = env.VP_PAGES_CF_ACCOUNT_ID ?? env.VP_APPS_CF_ACCOUNT_ID;
  const apiToken =
    doppler.get('VP_PAGES_CF_API_TOKEN') ??
    doppler.get('VP_APPS_CF_API_TOKEN') ??
    env.VP_PAGES_CF_API_TOKEN ??
    env.VP_APPS_CF_API_TOKEN;
  // Same three-way gate as loadConfig: without a public base there is no address
  // to serve published pages from, so publishing stays off rather than guessing
  // a host. Leaves an already-loaded config.pages untouched.
  const publicBase = env.VP_PAGES_PUBLIC_BASE;
  if (!accountId || !apiToken || !publicBase) return;

  config.pages = {
    accountId,
    apiToken,
    bucket: env.VP_PAGES_BUCKET ?? 'veneer-pages',
    publicBase: publicBase.replace(/\/+$/, ''),
  };
}
