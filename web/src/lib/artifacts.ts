export type ArtifactKind = 'csv' | 'tsv' | 'image' | 'pdf' | 'html' | 'code' | 'text' | 'other';

export interface PageArtifact {
  type: 'page';
  id: string;
  title: string;
  slug: string;
  url: string;
  updatedAt: string | number;
  /** Missing only for a bare transcript link that has not resolved to API metadata. */
  expiresAt?: string;
}

export interface AppArtifact {
  type: 'app';
  id: string;
  title: string;
  slug: string;
  url: string;
  runtime?: 'cloudflare' | 'local';
  status: 'deploying' | 'deployed' | 'error';
  lastError: string | null;
  updatedAt: string | number;
}

export interface FileArtifact {
  type: 'file';
  id: string;
  name: string;
  path: string;
  size: number;
  updatedAt: string | number;
  kind: ArtifactKind;
}

export type Artifact = PageArtifact | AppArtifact | FileArtifact;
export type ArtifactType = Artifact['type'];

export interface PublishedArtifact {
  type: 'page' | 'app';
  id: string;
  url: string;
}

const BARE_URL_PREFIX = 'url~';
const MINI_APP_RETURN_PARAM = '__veneer_return';

/** Launch a same-origin Mini App with an explicit, same-origin close target.
 * The server strips this platform parameter before app code sees the URL. */
export function miniAppLaunchUrl(appUrl: string, returnUrl: string, origin = window.location.origin): string {
  try {
    const app = new URL(appUrl, origin);
    const closeTarget = new URL(returnUrl, origin);
    if (app.origin !== origin || closeTarget.origin !== origin) return appUrl;
    app.searchParams.set(MINI_APP_RETURN_PARAM, closeTarget.toString());
    return app.toString();
  } catch {
    return appUrl;
  }
}

/** Return to the conversation itself, not the artifact panel used to launch
 * the full-screen app. Other route context (for example project) is retained. */
export function chatReturnUrl(currentUrl: string): string {
  try {
    const url = new URL(currentUrl);
    const [path, query = ''] = url.hash.split('?');
    if (!/^#\/chat\/[^/]+/.test(path ?? '')) return url.toString();
    const params = new URLSearchParams(query);
    params.delete('artifact');
    const nextQuery = params.toString();
    url.hash = `${path}${nextQuery ? `?${nextQuery}` : ''}`;
    return url.toString();
  } catch {
    return currentUrl;
  }
}

export function artifactKey(artifact: Artifact): string {
  return `${artifact.type}:${artifact.id}`;
}

export function artifactHashValue(artifact: Artifact): string {
  return artifactKey(artifact);
}

export function artifactPathKey(filePath: string): string {
  return filePath.replace(/^\/private(?=\/(?:tmp|var)(?:\/|$))/, '');
}

function comparableUrl(value: string): string | null {
  try {
    const url = new URL(value, window.location.origin);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function bareId(url: string): string {
  return `${BARE_URL_PREFIX}${encodeURIComponent(url)}`;
}

function bareUrl(id: string): string | null {
  if (!id.startsWith(BARE_URL_PREFIX)) return null;
  try {
    return decodeURIComponent(id.slice(BARE_URL_PREFIX.length));
  } catch {
    return null;
  }
}

// The host published pages are served from, taken from the server's configured
// pages public base (GET /api/me → pagesPublicBase). Null until that payload
// arrives, and whenever page publishing is not configured — in which case no
// host is trusted and nothing is treated as a published page.
let trustedPageHost: string | null = null;

/** Record the server's configured pages public base (null clears it). */
export function setPagesPublicBase(base: string | null | undefined): void {
  if (!base) {
    trustedPageHost = null;
    return;
  }
  try {
    trustedPageHost = new URL(base).hostname.toLowerCase() || null;
  } catch {
    trustedPageHost = null;
  }
}

/** The configured published-page host, or null when publishing is off. */
export function pagesPublicHost(): string | null {
  return trustedPageHost;
}

function pageHost(hostname: string): boolean {
  if (!trustedPageHost) return false;
  const host = hostname.toLowerCase();
  return host === trustedPageHost || host.endsWith(`.${trustedPageHost}`);
}

const PAGE_PATH_RE = /^\/p\/[^/]+\/?$/;

/**
 * A published Veneer page URL, identified from the href alone. Same host and
 * /p/slug rules as artifactForHref's bare-page path. Fonts, other objects on
 * the pages host, and ordinary external links return false.
 */
export function isPublishedPageLink(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    try {
      url = new URL(href, window.location.origin);
    } catch {
      return false;
    }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return PAGE_PATH_RE.test(url.pathname) && pageHost(url.hostname);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Filesystem roots a local deliverable path can plausibly start with. Agents
// link deliverables by absolute path; markdown resolves those against this
// origin, so they arrive as same-origin URLs whose pathname is the file path.
// None of these collide with an app route.
const LOCAL_PATH_RE = /^\/(?:Users|home|root|tmp|private|var|opt|srv|mnt|data|workspaces?)\//;

/**
 * The local absolute file path a transcript link points at, or null when the
 * link is not a local-path link (app routes and external URLs return null).
 * Handles both same-origin resolved paths and explicit file:// URLs.
 */
export function localPathForHref(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    return null;
  }
  if (url.protocol === 'file:' && url.hostname && url.hostname !== 'localhost') return null;
  if (url.protocol !== 'file:' && url.origin !== window.location.origin) return null;
  const pathname = decode(url.pathname.replace(/:\d+(?::\d+)?$/, ''));
  return LOCAL_PATH_RE.test(pathname) ? pathname : null;
}

/**
 * Resolve a transcript link only when it is positively identifiable as an
 * artifact. Unknown external links deliberately return null.
 */
export function artifactForHref(href: string, artifacts: Artifact[]): Artifact | null {
  let url: URL;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    return null;
  }

  const comparable = comparableUrl(url.toString());
  const localPath = localPathForHref(href);
  const known = artifacts.find((artifact) => {
    if (artifact.type === 'file') {
      const match = url.pathname.match(/^\/api\/generated-files\/([^/]+)\/(?:download(?:\/[^/]+)?|preview)$/);
      if (match) return decode(match[1]!) === artifact.id;
      // A link straight to the file's absolute path on disk.
      return localPath !== null && artifactPathKey(localPath) === artifactPathKey(artifact.path);
    }
    return comparableUrl(artifact.url) === comparable;
  });
  if (known) return known;

  const pageMatch = url.pathname.match(/^\/p\/([^/]+)\/?$/);
  if (pageMatch && isPublishedPageLink(url.toString())) {
    return {
      type: 'page',
      id: bareId(url.toString()),
      title: decode(pageMatch[1]!),
      slug: decode(pageMatch[1]!),
      url: url.toString(),
      updatedAt: Date.now(),
    };
  }

  const appMatch = url.pathname.match(/^\/tools\/([^/]+)\/?$/);
  if (appMatch && url.origin === window.location.origin) {
    return {
      type: 'app',
      id: bareId(url.toString()),
      title: decode(appMatch[1]!),
      slug: decode(appMatch[1]!),
      url: url.toString(),
      status: 'deployed',
      lastError: null,
      updatedAt: Date.now(),
    };
  }

  return null;
}

/**
 * A "watch the agent's live browser" link: this install's own Desktop viewer at
 * /desktop. Matched as conservatively as artifactForHref — only the exact
 * /desktop path counts, so ordinary external links (and deeper /desktop/* asset
 * paths) are untouched.
 */
export function isDesktopWatchLink(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.pathname.replace(/\/$/, '') !== '/desktop') return false;
  return url.origin === window.location.origin;
}

export function artifactFromHash(value: string | null, artifacts: Artifact[]): Artifact | null {
  if (!value) return null;
  const colon = value.indexOf(':');
  if (colon <= 0) return null;
  const type = value.slice(0, colon) as ArtifactType;
  const id = value.slice(colon + 1);
  if (!['page', 'app', 'file'].includes(type) || !id) return null;
  const known = artifacts.find((artifact) => artifact.type === type && artifact.id === id);
  if (known) return known;

  const url = bareUrl(id);
  if (!url || type === 'file') return null;
  try {
    const parsed = new URL(url);
    const pageMatch = parsed.pathname.match(/^\/p\/([^/]+)\/?$/);
    const appMatch = parsed.pathname.match(/^\/tools\/([^/]+)\/?$/);
    if (type === 'page' && !isPublishedPageLink(url)) return null;
    if (type === 'app' && (!appMatch || parsed.origin !== window.location.origin)) return null;
    const slug = decode((type === 'page' ? pageMatch?.[1] : appMatch?.[1]) ?? parsed.hostname);
    return type === 'page'
      ? { type, id, title: slug, slug, url, updatedAt: Date.now() }
      : { type, id, title: slug, slug, url, status: 'deployed', lastError: null, updatedAt: Date.now() };
  } catch {
    return null;
  }
}
