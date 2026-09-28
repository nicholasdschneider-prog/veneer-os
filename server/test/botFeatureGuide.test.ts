import { describe, expect, it } from 'vitest';
import { BOT_FEATURES, botFeatureCatalog, botFeatureInstructions, isNewFeature } from '../src/featureGuide/catalog.js';
import { coreVeneerRules } from '../src/instructions/context.js';
import { employeeRouteAllowed } from '../src/bots/employeeAccess.js';

describe('living bot guide release contract', () => {
  it('announces same-owner approved delivery with unchanged authority limits',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-28')).features.find(f=>f.id==='approved-message-delegation')!;
    expect(f.isNew).toBe(true);expect(f.updated).toBe('2026-09-28');
    expect(f.steps.join(' ')).toContain('same bot performs both steps');
    expect(f.agent).toContain('existing claim key');expect(f.agent).toContain('Never reopen, reclaim, requeue or resend');
    expect(f.agent).toContain('no self-message');expect(f.agent).toContain('ordinary-draft retrofit');
    expect(botFeatureInstructions()).toContain(f.agent);
    expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
  });
  it('teaches dedicated timing setup limits to employees and resumed bots',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-28')).features.find(f=>f.id==='purchase-timing-verifier')!;
    expect(f.isNew).toBe(true);expect(f.steps.join(' ')).toContain('/#/purchase-timing-setup');
    expect(f.limits).toContain('Disabled until');
    expect(f.agent).toContain('EXECUTION_BOUNDARY_UNAVAILABLE');
    expect(f.agent).toContain('SOURCE_MAPPING_REQUIRED');
    expect(f.announcement).toContain('Recorded human approvals remain intact');
    expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
    expect(employeeRouteAllowed('POST','/purchase-timing/setup/confirm')).toBe(false);
    expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'business-bot',elevated:false})).toContain(f.agent);
  });
  it('delivers conversational consent guidance to employees and resumed bots',()=>{
    const feature=botFeatureCatalog(Date.parse('2026-09-28')).features.find(f=>f.id==='conversational-consent')!;
    expect(feature.isNew).toBe(true);
    expect(feature.summary).toContain('second approval click');
    expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
    expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'business-bot',elevated:false})).toContain(feature.agent);
    expect(feature.agent).toContain('inspect_conversational_decision');
  });
  it('explains shared browser capacity to employees and resumed agents', () => {
    const feature = botFeatureCatalog(Date.parse('2026-09-27')).features.find(f => f.id === 'browser')!;
    expect(feature.isNew).toBe(true);
    expect(feature.limits).toContain('Five active browsers');
    expect(feature.agent).toContain('Never stop another chat');
    expect(employeeRouteAllowed('GET', '/bot-workflows/guide')).toBe(true);
    expect(coreVeneerRules({ workspaceDir: '/repo', assistantSlug: 'business-bot', elevated: false })).toContain(feature.agent);
  });
  it('announces flexible question cards and teaches all providers the approval boundary', () => {
    const feature = botFeatureCatalog(Date.parse('2026-09-25')).features.find(f => f.id === 'question-cards')!;
    expect(feature.isNew).toBe(true);
    expect(feature.steps.join(' ')).toContain('Send answer');
    expect(feature.agent).toContain('All providers');
    expect(feature.agent).toContain('raise_decision with proposal.choices');
    expect(botFeatureInstructions()).toContain(feature.agent);
  });
  it('announces owner scope review without widening employee or service inventory access',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-25')).features.find(f=>f.id==='routine-scope-handoff')!;
    expect(f.isNew).toBe(true);expect(f.limits).toContain('does not approve');
    expect(botFeatureInstructions()).toContain(f.agent);
    for(const path of ['list','review','bind','handoffs','handoffs/revoke'])expect(employeeRouteAllowed('POST','/bot-communication/routine-messages/hold-scopes/'+path)).toBe(false);
  });
  it('announces owner photo setup without granting employee enrollment',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-25')).features.find(f=>f.id==='routine-owner-setup')!;
    expect(f.isNew).toBe(true);expect(f.limits).toContain('Registration does not prove');
    expect(botFeatureInstructions()).toContain(f.agent);
    expect(employeeRouteAllowed('POST','/bot-communication/routine-messages/setup')).toBe(false);
  });
  it('discovers versioned reply editing and allows its narrow employee route',()=>{
    const feature=botFeatureCatalog(Date.parse('2026-09-24')).features.find(f=>f.id==='decision-reply-editing')!;
    expect(feature.isNew).toBe(true);
    expect(botFeatureInstructions()).toContain(feature.agent);
    expect(employeeRouteAllowed('POST','/bots/decisions/fixture/reply')).toBe(true);
    expect(employeeRouteAllowed('POST','/bots/decisions/fixture/proposal')).toBe(false);
  });
  it('labels policy enrollment separately from disabled execution and protects enrollment routes',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-23')).features.find(f=>f.id==='routine-policy-enrollment')!;
    expect(f.isNew).toBe(true);expect(f.limits).toContain('All categories currently disabled in production');
    expect(employeeRouteAllowed('GET','/bot-communication/drafts/fixture/routine-status')).toBe(true);
    expect(employeeRouteAllowed('POST','/bot-communication/routine-policies/enroll')).toBe(false);
    expect(employeeRouteAllowed('POST','/bot-communication/routine-messages/trust')).toBe(false);
    expect(f.agent).toContain('claim_routine_message');
    expect(f.limits).toContain('return service credentials never');
  });
  it('announces optional teaching narration with accurate access and review limits',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-23')).features.find(f=>f.id==='teach')!;
    expect(f.isNew).toBe(true);expect(f.steps.join(' ')).toContain('Record microphone narration');
    expect(f.limits).toContain('not screen video');expect(f.limits).toContain('Restricted customer-service');
    expect(f.agent).toContain('never permission');
  });
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
