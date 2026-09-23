import { describe, expect, it } from 'vitest';
import { filterBotFeatures } from './botGuide';
import { botFeatureCatalog } from '../../../server/src/featureGuide/catalog';
const catalog = botFeatureCatalog(Date.parse('2026-09-23T12:00:00Z'));
describe('bot guide discovery', () => {
  it('finds capabilities by the task and setup instructions, not just the title', () => {
    expect(filterBotFeatures(catalog, '  WEEKDAY timezone  ', false).map(feature => feature.id)).toContain('routines');
    expect(filterBotFeatures(catalog, 'quiet hours', false).map(feature => feature.id)).toContain('notifications');
    expect(filterBotFeatures(catalog, 'does not exist xyz', false)).toEqual([]);
  });
  it('combines search with release filtering and retains existing features in the full guide', () => {
    expect(filterBotFeatures(catalog, 'voice', false).some(feature => feature.id === 'voice')).toBe(true);
    expect(filterBotFeatures(catalog, 'voice', true).some(feature => feature.id === 'voice')).toBe(true);
    const old = botFeatureCatalog(Date.parse('2027-01-01'));
    expect(filterBotFeatures(old, 'voice', false).some(feature => feature.id === 'voice')).toBe(true);
    expect(filterBotFeatures(old, 'voice', true)).toEqual([]);
    expect(filterBotFeatures(catalog, '', true).every(feature => feature.isNew)).toBe(true);
    expect(filterBotFeatures(botFeatureCatalog(Date.parse('2027-01-01')), '', true)).toEqual([]);
  });
});
