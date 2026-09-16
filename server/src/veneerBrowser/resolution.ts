import type { VeneerBrowserResolution } from './settings.js';

export const VENEER_BROWSER_MAX_FRAME_PIXELS = 4_200_000;
export const VENEER_BROWSER_THUMBNAIL_LIMITS = {
  maxPixels: 360 * 240,
  maxWidth: 360,
  maxHeight: 240,
} as const;

export function veneerBrowserFrameScale(resolution: VeneerBrowserResolution, viewerDpr: unknown): number {
  if (resolution === 'standard') return 1;
  if (resolution === 'retina') return 2;
  const parsed = Number(viewerDpr);
  const dpr = Number.isFinite(parsed) && parsed > 0 ? parsed : 1.5;
  return Math.min(1.5, Math.max(1, dpr));
}
