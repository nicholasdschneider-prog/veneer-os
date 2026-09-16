import { describe, expect, it } from 'vitest';
import { visualViewportStyle } from './useVisualViewportBounds';

describe('visualViewportStyle', () => {
  it('positions an overlay inside the keyboard-sized visual viewport', () => {
    expect(visualViewportStyle({ offsetLeft: 7, offsetTop: 142, width: 376, height: 402 })).toEqual({
      inset: 'auto',
      left: '7px',
      top: '142px',
      width: '376px',
      height: '402px',
    });
  });

  it('falls back to CSS viewport bounds when the API is unavailable', () => {
    expect(visualViewportStyle(null)).toBeUndefined();
  });
});
