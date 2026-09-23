import { describe, expect, it } from 'vitest';
import { BOT_FEATURES, botFeatureCatalog, botFeatureInstructions, isNewFeature } from '../src/featureGuide/catalog.js';
import { coreVeneerRules } from '../src/instructions/context.js';
import { employeeRouteAllowed } from '../src/bots/employeeAccess.js';

describe('living bot guide release contract', () => {
  it('requires practical human and bot instructions, unique links, and valid release dates', () => {
    expect(new Set(BOT_FEATURES.map(feature => feature.id)).size).toBe(BOT_FEATURES.length);
    for (const feature of BOT_FEATURES) {
      expect(feature.id).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(new Date(feature.updated).toISOString().slice(0, 10)).toBe(feature.updated);
      for (const text of [feature.title, feature.audience, feature.summary, feature.example, feature.limits, feature.agent]) expect(text.trim().length).toBeGreaterThan(8);
      expect(feature.steps.length).toBeGreaterThanOrEqual(3);
      expect(botFeatureInstructions()).toContain(feature.agent);
    }
  });
  it('shows announcements for 30 days, never before release, retaining older instructions', () => {
    const feature = BOT_FEATURES.find(feature => feature.id === 'routines')!;
    expect(isNewFeature(feature, Date.parse('2026-09-21T23:59:59Z'))).toBe(false);
    expect(isNewFeature(feature, Date.parse('2026-09-22T00:00:00Z'))).toBe(true);
    expect(isNewFeature(feature, Date.parse('2026-10-21T23:59:59Z'))).toBe(true);
    expect(isNewFeature(feature, Date.parse('2026-10-22T00:00:00Z'))).toBe(false);
    expect(isNewFeature({ ...feature, announcement: null }, Date.parse('2026-09-23'))).toBe(false);
    expect(botFeatureCatalog(Date.parse('2027-01-01')).features).toHaveLength(BOT_FEATURES.length);
  });
  it('allows restricted employees to read the guide without opening writes or other workflow routes', () => {
    expect(employeeRouteAllowed('GET', '/bot-workflows/guide')).toBe(true);
    expect(employeeRouteAllowed('GET', '/bot-workflows/guide/')).toBe(true);
    expect(employeeRouteAllowed('POST', '/bot-workflows/guide')).toBe(false);
    expect(employeeRouteAllowed('GET', '/bot-workflows/current/routines')).toBe(false);
    expect(employeeRouteAllowed('GET', '/bot-workflows/guide/private')).toBe(false);
  });
  it('delivers current capabilities to all agents and makes platform maintenance a standing requirement', () => {
    for (const assistantSlug of ['assistant', 'platform-dev', 'business-bot']) {
      const text = coreVeneerRules({ workspaceDir: '/repo', assistantSlug, elevated: false });
      expect(text).toContain(botFeatureInstructions());
      expect(text).toContain('Availability is not permission');
      if (assistantSlug === 'platform-dev') expect(text).toContain('Standing release requirement');
    }
  });
});
