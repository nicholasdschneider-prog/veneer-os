import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  artifactForHref,
  chatReturnUrl,
  isDesktopWatchLink,
  isPublishedPageLink,
  localPathForHref,
  miniAppLaunchUrl,
  pagesPublicHost,
  setPagesPublicBase,
} from './artifacts';
import type { FileArtifact } from './artifacts';

// The web suite runs in the node environment (no jsdom), but isDesktopWatchLink
// reads window.location.origin at call time, so stub a minimal window.
const ORIGIN = 'http://localhost:5173';
const hadWindow = 'window' in globalThis;

beforeAll(() => {
  (globalThis as { window?: unknown }).window = { location: { origin: ORIGIN } };
});

afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

describe('isDesktopWatchLink', () => {
  it('matches the same-origin /desktop viewer', () => {
    expect(isDesktopWatchLink('/desktop')).toBe(true);
    expect(isDesktopWatchLink('/desktop/')).toBe(true);
    expect(isDesktopWatchLink(`${ORIGIN}/desktop`)).toBe(true);
  });

  it('ignores /desktop on any other origin', () => {
    expect(isDesktopWatchLink('https://veneer.example/desktop')).toBe(false);
    expect(isDesktopWatchLink('https://veneer.example/desktop/')).toBe(false);
  });

  it('ignores deeper /desktop asset paths', () => {
    expect(isDesktopWatchLink('/desktop/novnc/vnc.html')).toBe(false);
    expect(isDesktopWatchLink('https://veneer.example/desktopx')).toBe(false);
  });

  it('ignores other hosts and paths', () => {
    expect(isDesktopWatchLink('https://evil.com/desktop')).toBe(false);
    expect(isDesktopWatchLink('/artifacts/foo')).toBe(false);
    expect(isDesktopWatchLink('https://example.com/')).toBe(false);
  });

  it('ignores non-http(s) schemes', () => {
    expect(isDesktopWatchLink('mailto:someone@example.com')).toBe(false);
    expect(isDesktopWatchLink('javascript:alert(1)')).toBe(false);
  });
});

describe('localPathForHref', () => {
  it('matches located macOS alias links to the registered preview', () => {
    const file: FileArtifact = {
      type: 'file', id: 'report', name: 'report.md', path: '/private/tmp/report.md',
      size: 12, updatedAt: 0, kind: 'text',
    };
    for (const href of ['/tmp/report.md:12:3', '/tmp/report.md#L12', 'file:///tmp/report.md:12']) {
      expect(localPathForHref(href)).toBe('/tmp/report.md');
      expect(artifactForHref(href, [file])).toBe(file);
    }
    expect(artifactForHref('https://example.com/tmp/report.md', [file])).toBeNull();
    expect(localPathForHref('file://remote/tmp/report.md')).toBeNull();
  });

  it('extracts the path from a same-origin local-path link (markdown resolves bare paths here)', () => {
    expect(localPathForHref('/Users/sam/exports/data.csv')).toBe('/Users/sam/exports/data.csv');
    expect(localPathForHref(`${ORIGIN}/home/agent/report.pdf`)).toBe('/home/agent/report.pdf');
  });

  it('decodes percent-encoded segments', () => {
    expect(localPathForHref('/Users/sam/Crew%20Seating/report.csv')).toBe('/Users/sam/Crew Seating/report.csv');
  });

  it('handles file:// URLs', () => {
    expect(localPathForHref('file:///tmp/out.zip')).toBe('/tmp/out.zip');
  });

  it('ignores app routes, external hosts, and non-filesystem paths', () => {
    expect(localPathForHref('/api/generated-files/abc/preview')).toBe(null);
    expect(localPathForHref('/desktop')).toBe(null);
    expect(localPathForHref('https://example.com/Users/sam/data.csv')).toBe(null);
    expect(localPathForHref('/p/some-page')).toBe(null);
  });
});

describe('Mini App launch navigation', () => {
  it('returns from a full-screen app to the originating chat, not its artifact panel', () => {
    const current = `${ORIGIN}/#/chat/chat-1?project=project-1&artifact=app%3Aapp-1`;
    const returnUrl = chatReturnUrl(current);
    expect(returnUrl).toBe(`${ORIGIN}/#/chat/chat-1?project=project-1`);

    const launchUrl = miniAppLaunchUrl(`${ORIGIN}/tools/pipeline/?view=list`, returnUrl, ORIGIN);
    const parsed = new URL(launchUrl);
    expect(parsed.pathname).toBe('/tools/pipeline/');
    expect(parsed.searchParams.get('view')).toBe('list');
    expect(parsed.searchParams.get('__veneer_return')).toBe(returnUrl);
  });

  it('does not attach cross-origin app or return destinations', () => {
    expect(miniAppLaunchUrl('https://other.example/tools/app/', `${ORIGIN}/#/chat/chat-1`, ORIGIN)).toBe(
      'https://other.example/tools/app/',
    );
    expect(miniAppLaunchUrl(`${ORIGIN}/tools/app/`, 'https://evil.example/', ORIGIN)).toBe(
      `${ORIGIN}/tools/app/`,
    );
  });
});

describe('isPublishedPageLink', () => {
  afterEach(() => setPagesPublicBase(null));

  it('matches /p/ slugs on the configured pages host', () => {
    setPagesPublicBase('https://pages.example.com');
    expect(pagesPublicHost()).toBe('pages.example.com');
    expect(isPublishedPageLink('https://pages.example.com/p/system-map')).toBe(true);
    expect(isPublishedPageLink('https://pages.example.com/p/system-map/')).toBe(true);
    expect(isPublishedPageLink('https://owner.pages.example.com/p/slug')).toBe(true);
  });

  it('ignores fonts, other paths, and foreign hosts', () => {
    setPagesPublicBase('https://pages.example.com/');
    expect(isPublishedPageLink('https://pages.example.com/f/f1/Harman-Sans.woff2')).toBe(false);
    expect(isPublishedPageLink('https://pages.example.com/')).toBe(false);
    expect(isPublishedPageLink('https://example.com/p/system-map')).toBe(false);
    expect(isPublishedPageLink('https://pages.example.com.evil.com/p/slug')).toBe(false);
    expect(isPublishedPageLink('/p/system-map')).toBe(false);
  });

  it('trusts no host until the server reports a configured pages base', () => {
    expect(pagesPublicHost()).toBeNull();
    expect(isPublishedPageLink('https://pages.example.com/p/system-map')).toBe(false);
    setPagesPublicBase('not a url');
    expect(pagesPublicHost()).toBeNull();
    expect(isPublishedPageLink('https://pages.example.com/p/system-map')).toBe(false);
  });

  it('does not resolve a bare page link while no pages host is configured', () => {
    expect(artifactForHref('https://pages.example.com/p/system-map', [])).toBeNull();
    setPagesPublicBase('https://pages.example.com');
    expect(artifactForHref('https://pages.example.com/p/system-map', [])).toMatchObject({
      type: 'page',
      slug: 'system-map',
    });
  });
});

describe('artifactForHref file-path matching', () => {
  const file: FileArtifact = {
    type: 'file',
    id: 'gf-1',
    name: 'data.csv',
    path: '/Users/sam/exports/data.csv',
    size: 10,
    updatedAt: 1,
    kind: 'csv',
  };

  it('matches a transcript link pointing at the registered file path', () => {
    expect(artifactForHref('/Users/sam/exports/data.csv', [file])).toBe(file);
    expect(artifactForHref('file:///Users/sam/exports/data.csv', [file])).toBe(file);
  });

  it('matches a percent-encoded link to a path with spaces', () => {
    const spaced: FileArtifact = { ...file, id: 'gf-2', path: '/Users/sam/Crew Seating/report.csv' };
    expect(artifactForHref('/Users/sam/Crew%20Seating/report.csv', [spaced])).toBe(spaced);
  });

  it('still matches the generated-files API routes by id', () => {
    expect(artifactForHref('/api/generated-files/gf-1/preview', [file])).toBe(file);
    expect(artifactForHref('/api/generated-files/gf-1/download', [file])).toBe(file);
  });

  it('returns null for an unregistered local path', () => {
    expect(artifactForHref('/Users/sam/exports/other.csv', [file])).toBe(null);
  });
});
