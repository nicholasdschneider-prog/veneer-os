import { describe, expect, it } from 'vitest';
import { normalizeBrowserSettings } from './BrowserSettingsPage';

describe('Browser settings normalization', () => {
  it('keeps Auto visibly selected when a legacy server returns quality only', () => {
    expect(normalizeBrowserSettings({ quality: 90 })).toEqual({ quality: 90, resolution: 'auto' });
  });

  it('preserves a supported saved resolution', () => {
    expect(normalizeBrowserSettings({ quality: 80, resolution: 'retina' })).toEqual({
      quality: 80,
      resolution: 'retina',
    });
  });
});
