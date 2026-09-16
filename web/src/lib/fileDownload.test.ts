import { describe, expect, it, vi } from 'vitest';
import {
  isIosNavigator,
  isShareCancellation,
  isStandaloneWindow,
  selectFileDownloadStrategy,
  shareDownloadedFile,
} from './fileDownload';

describe('file download strategy', () => {
  it('detects iPhone and desktop-mode iPadOS user agents', () => {
    expect(isIosNavigator({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', platform: '', maxTouchPoints: 0 } as Navigator)).toBe(true);
    expect(isIosNavigator({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 } as Navigator)).toBe(true);
    expect(isIosNavigator({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 } as Navigator)).toBe(false);
  });

  it('detects standards-based and iOS standalone PWA modes', () => {
    expect(
      isStandaloneWindow(
        { matchMedia: () => ({ matches: true }) } as unknown as Window,
        {} as Navigator,
      ),
    ).toBe(true);
    expect(
      isStandaloneWindow(
        { matchMedia: () => ({ matches: false }) } as unknown as Window,
        { standalone: true } as Navigator & { standalone: boolean },
      ),
    ).toBe(true);
  });

  it('preserves ordinary browser downloads on desktop', () => {
    expect(selectFileDownloadStrategy({ ios: false, standalone: false, fileShare: true })).toBe('native');
  });

  it('uses Web Share files in iOS and installed PWAs when available', () => {
    expect(selectFileDownloadStrategy({ ios: true, standalone: false, fileShare: true })).toBe('share');
    expect(selectFileDownloadStrategy({ ios: false, standalone: true, fileShare: true })).toBe('share');
  });

  it('uses a separate browsing context when file sharing is unavailable', () => {
    expect(selectFileDownloadStrategy({ ios: true, standalone: false, fileShare: false })).toBe('external');
    expect(selectFileDownloadStrategy({ ios: false, standalone: true, fileShare: false })).toBe('external');
  });
});

describe('shareDownloadedFile', () => {
  it('fetches with same-origin authentication and shares the original filename and MIME type', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('heading\nvalue\n', {
        headers: { 'content-type': 'text/csv' },
      }),
    );
    const shared: ShareData[] = [];
    const navigatorValue = {
      canShare: vi.fn(() => true),
      userActivation: { isActive: true },
      share: vi.fn(async (data: ShareData) => {
        shared.push(data);
      }),
    };

    await shareDownloadedFile({
      href: '/api/generated-files/file-1/download/report.csv',
      name: 'report.csv',
      fetchImpl: fetchImpl as typeof fetch,
      navigatorValue,
    });

    expect(fetchImpl).toHaveBeenCalledWith('/api/generated-files/file-1/download/report.csv', {
      credentials: 'same-origin',
    });
    const file = shared[0]?.files?.[0];
    expect(file?.name).toBe('report.csv');
    expect(file?.type).toBe('text/csv');
    expect(navigatorValue.canShare).toHaveBeenCalledWith({ files: [file] });
  });

  it('does not share an unauthorized or missing download response', async () => {
    const share = vi.fn();

    await expect(
      shareDownloadedFile({
        href: '/api/generated-files/missing/download',
        name: 'missing.csv',
        fetchImpl: vi.fn(async () => new Response('Not found', { status: 404 })) as typeof fetch,
        navigatorValue: { canShare: vi.fn(() => true), share },
      }),
    ).rejects.toThrow('Download failed (404)');
    expect(share).not.toHaveBeenCalled();
  });

  it('falls back before sharing when a slow fetch exhausts Safari user activation', async () => {
    const share = vi.fn();

    await expect(
      shareDownloadedFile({
        href: '/api/generated-files/file-1/download/report.csv',
        name: 'report.csv',
        fetchImpl: vi.fn(async () => new Response('a,b', { headers: { 'content-type': 'text/csv' } })) as typeof fetch,
        navigatorValue: { canShare: vi.fn(() => true), share, userActivation: { isActive: false } },
      }),
    ).rejects.toThrow('fresh tap');
    expect(share).not.toHaveBeenCalled();
  });

  it('recognizes closing the native share sheet as cancellation, not failure', () => {
    expect(isShareCancellation(new DOMException('Cancelled', 'AbortError'))).toBe(true);
    expect(isShareCancellation(new Error('Network error'))).toBe(false);
  });
});
