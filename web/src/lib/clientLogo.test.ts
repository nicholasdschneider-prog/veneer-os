import { describe, expect, it } from 'vitest';
import { fitImageInSquare } from './clientLogo';

describe('fitImageInSquare', () => {
  it('centers a wide image without cropping it', () => {
    expect(fitImageInSquare(1200, 300)).toEqual({
      x: 0,
      y: 192,
      width: 512,
      height: 128,
    });
  });

  it('centers a tall image without cropping it', () => {
    expect(fitImageInSquare(200, 800)).toEqual({
      x: 192,
      y: 0,
      width: 128,
      height: 512,
    });
  });

  it('fills the canvas for an already-square image', () => {
    expect(fitImageInSquare(400, 400)).toEqual({
      x: 0,
      y: 0,
      width: 512,
      height: 512,
    });
  });

  it('rejects invalid dimensions', () => {
    expect(() => fitImageInSquare(0, 400)).toThrow('Logo dimensions are invalid.');
  });
});
