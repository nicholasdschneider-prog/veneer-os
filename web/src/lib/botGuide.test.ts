import { describe, expect, it } from 'vitest';
import { filterBotFeatures } from './botGuide';
import { BOT_FEATURES, botFeatureCatalog } from '../../../server/src/featureGuide/catalog';
// Tie the search fixture to the release it expects to be new. A fixed older
// date incorrectly treats later guide updates as unpublished features.
const voiceRelease = Date.parse(`${BOT_FEATURES.find(feature => feature.id === 'voice')!.updated}T12:00:00Z`);
const catalog = botFeatureCatalog(voiceRelease);
const expired = Math.max(...BOT_FEATURES.map(feature => Date.parse(feature.updated))) + 31 * 86400000;
describe('bot guide discovery', () => {
  it('finds capabilities by the task and setup instructions, not just the title', () => {
    expect(filterBotFeatures(catalog, '  WEEKDAY timezone  ', false).map(feature => feature.id)).toContain('routines');
    expect(filterBotFeatures(catalog, 'quiet hours', false).map(feature => feature.id)).toContain('notifications');
    expect(filterBotFeatures(catalog, 'does not exist xyz', false)).toEqual([]);
  });
  it('combines search with release filtering and retains existing features in the full guide', () => {
    expect(filterBotFeatures(catalog, 'voice', false).some(feature => feature.id === 'voice')).toBe(true);
    expect(filterBotFeatures(catalog, 'voice', true).some(feature => feature.id === 'voice')).toBe(true);
    const old = botFeatureCatalog(expired);
    expect(filterBotFeatures(old, 'voice', false).some(feature => feature.id === 'voice')).toBe(true);
    expect(filterBotFeatures(old, 'voice', true)).toEqual([]);
    expect(filterBotFeatures(catalog, '', true).every(feature => feature.isNew)).toBe(true);
    expect(filterBotFeatures(botFeatureCatalog(expired), '', true)).toEqual([]);
  });
});
