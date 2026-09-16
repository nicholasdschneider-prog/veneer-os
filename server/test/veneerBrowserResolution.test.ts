import { describe, expect, it } from 'vitest';
import {
  VENEER_BROWSER_MAX_FRAME_PIXELS,
  veneerBrowserFrameScale,
} from '../src/veneerBrowser/resolution.js';
import { cappedFrameGeometry } from '../src/channels/cdpDesktop.js';

describe('Veneer Browser resolution', () => {
  it('maps Standard, Auto, and Retina without trusting an oversized viewer DPR', () => {
    expect(veneerBrowserFrameScale('standard', 2)).toBe(1);
    expect(veneerBrowserFrameScale('auto', 1)).toBe(1);
    expect(veneerBrowserFrameScale('auto', 2)).toBe(1.5);
    expect(veneerBrowserFrameScale('auto', 'damaged')).toBe(1.5);
    expect(veneerBrowserFrameScale('retina', 1)).toBe(2);
  });

  it('renders a normal Auto viewport at 1.5x and Retina at 2x', () => {
    expect(cappedFrameGeometry({ width: 1280, height: 800 }, 1.5, {
      maxPixels: VENEER_BROWSER_MAX_FRAME_PIXELS,
    })).toEqual({ deviceScaleFactor: 1.5, maxWidth: 1920, maxHeight: 1200, captureScale: 1 });
    expect(cappedFrameGeometry({ width: 1280, height: 800 }, 2, {
      maxPixels: VENEER_BROWSER_MAX_FRAME_PIXELS,
    })).toEqual({ deviceScaleFactor: 2, maxWidth: 2560, maxHeight: 1600, captureScale: 1 });
  });

  it('caps oversized frames without shrinking the CSS viewport below 1x', () => {
    const frame = cappedFrameGeometry({ width: 3840, height: 2160 }, 2, {
      maxPixels: VENEER_BROWSER_MAX_FRAME_PIXELS,
    });
    expect(frame.deviceScaleFactor).toBe(1);
    expect(frame.maxWidth * frame.maxHeight).toBeLessThanOrEqual(VENEER_BROWSER_MAX_FRAME_PIXELS);
    expect(frame.captureScale).toBeLessThan(1);
  });

  it('keeps the floating thumbnail within 360x240', () => {
    expect(cappedFrameGeometry({ width: 1280, height: 800 }, 1, {
      maxPixels: 360 * 240,
      maxWidth: 360,
      maxHeight: 240,
    })).toEqual({ deviceScaleFactor: 1, maxWidth: 360, maxHeight: 225, captureScale: 0.28125 });
  });
});
