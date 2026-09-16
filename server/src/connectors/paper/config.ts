/**
 * Paper (paper.design) connector settings.
 *
 * Paper Desktop serves MCP from the machine the app runs on, so the default
 * points at this machine's loopback. It stays configurable because the human's
 * Paper install is not always the Veneer host: a client can run Veneer Pro on
 * one box (a Mac mini) while Paper runs on their own desktop, reached over a
 * private network such as Tailscale.
 */

export const PAPER_DEFAULT_MCP_URL = 'http://127.0.0.1:29979/mcp';

/** The endpoint this install should talk to; blank settings mean the default. */
export function resolvePaperMcpUrl(settings: Record<string, string>): string {
  return settings.url?.trim() || PAPER_DEFAULT_MCP_URL;
}

// `new URL()` keeps the brackets on an IPv6 hostname, so both spellings appear.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** True when only the Veneer host itself can reach the endpoint. */
export function isLoopbackPaperUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function validatePaperSettings(settings: Record<string, string>): string | null {
  const raw = settings.url?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `Enter the full Paper MCP URL, for example ${PAPER_DEFAULT_MCP_URL}.`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'The Paper MCP URL must start with http:// or https://.';
  }
  if (!parsed.hostname) return 'The Paper MCP URL needs a host.';
  return null;
}
