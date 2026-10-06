import { describe, expect, it } from 'vitest';
import { BOT_FEATURES, botFeatureCatalog, botFeatureInstructions, isNewFeature } from '../src/featureGuide/catalog.js';
import { coreVeneerRules } from '../src/instructions/context.js';
import { employeeRouteAllowed } from '../src/bots/employeeAccess.js';

describe('living bot guide release contract', () => {
  it('delivers staged strict evidence guidance to employees and fresh/resumed agents', () => {
    const f = botFeatureCatalog(Date.parse('2026-10-02')).features.find(f => f.id === 'decision-evidence-validation')!;
    expect(f.isNew).toBe(true); expect(f.limits).toContain('Staged');
    expect(f.agent).toContain('chat_file requires conversation_id+path');
    expect(f.agent).toContain('4096'); expect(f.agent).toContain('current exact decision version');
    expect(employeeRouteAllowed('GET', '/bot-workflows/guide')).toBe(true);
    expect(botFeatureInstructions()).toContain(f.agent);
    for (const elevated of [false, true]) expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'bot',elevated})).toContain(f.agent);
  });
  it('delivers exact vendor-email steps and limits to employees and resumed agents',()=>{
    const f=botFeatureCatalog(Date.parse('2026-10-02')).features.find(f=>f.id==='vendor-email-direction')!;
    expect(f.isNew).toBe(true);expect(f.limits).toContain('UNKNOWN');expect(f.limits).toContain('not server-authenticated Gmail');
    expect(f.agent).toContain('Never bind or claim as the builder');expect(f.agent).toContain('FIRST execute:true');
    expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
    for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'bot',elevated})).toContain(f.agent);
  });
  it('delivers the staged question desk and hotline boundaries to employees and resumed agents',()=>{
    const f=botFeatureCatalog(Date.parse('2026-10-05')).features.find(f=>f.id==='question-desk')!;
    expect(f.isNew).toBe(true);expect(f.limits).toContain('transient ordinary chat prompts');expect(f.agent).toContain('original owners/executors');
    for(const method of ['GET','POST'])expect(employeeRouteAllowed(method,'/question-line')).toBe(true);
    expect(employeeRouteAllowed('DELETE','/question-line')).toBe(false);
    for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'bot',elevated})).toContain(f.agent);
  });
  it('delivers periodic coalescing limits to employees and fresh/resumed agents', () => {
    const f = botFeatureCatalog(Date.parse('2026-10-01')).features.find(f => f.id === 'routines')!;
    expect(f.isNew).toBe(true);
    expect(f.announcement).toContain('one pending backup check per routine');
    expect(f.limits).toContain('UNKNOWN');
    expect(employeeRouteAllowed('GET', '/bot-workflows/guide')).toBe(true);
    for (const elevated of [false, true]) expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'business-bot',elevated})).toContain(f.agent);
    expect(botFeatureInstructions()).toContain(f.agent);
  });
  it('delivers staged UNKNOWN inspection and persistent command denial to employees and resumed agents',()=>{
    const f=botFeatureCatalog(Date.parse('2026-10-06')).features.find(f=>f.id==='browser-unknown-inspection')!;
    expect(f.isNew).toBe(true);expect(f.limits).toContain('Metadata only');expect(f.agent).toContain('never clears UNKNOWN');
    expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
    for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'browser-bot',elevated})).toContain(f.agent);
  });
  it('labels controller recovery as staged and retains original-owner UNKNOWN limits in employee and resumed guidance',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-30')).features.find(f=>f.id==='browser-controller-reconnect')!;
    expect(f.limits).toContain('pending deployment');expect(f.agent).toContain('UNKNOWN');
    expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
    for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'browser-bot',elevated})).toContain(f.agent);
  });
  it('delivers paired contact limits to employees and both resumed instruction modes',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-30')).features.find(x=>x.id==='paired-contact-verification')!;
    expect(f.isNew).toBe(true);expect(f.limits).toContain('Production is disabled');expect(f.agent).toContain('No outreach approval ask before executable manifest');expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
    for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'business-bot',elevated})).toContain(f.agent);
  });
  it('delivers unavailable-until-enrolled prospective custody guidance to employees and resumed agents',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-30')).features.find(f=>f.id==='prospective-case-custody')!;
    expect(f.isNew).toBe(true);expect(f.limits).toContain('historical');expect(f.agent).toContain('Never issue as builder');
    expect(f.agent).toContain('No production trust installed');expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
    for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'business-bot',elevated})).toContain(f.agent);
  });
  it('delivers startup recovery limits to employees and resumed bots', () => {
    const f = botFeatureCatalog(Date.parse('2026-09-29')).features.find(f => f.id === 'codex-startup-recovery')!;
    expect(f.isNew).toBe(true);
    expect(f.announcement).toContain('metadata-only');
    expect(f.limits).toContain('Previously omitted errors cannot be reconstructed');
    expect(f.agent).toContain('do not infer recovery from Working');
    expect(employeeRouteAllowed('GET', '/bot-workflows/guide')).toBe(true);
    for (const elevated of [false, true]) {
      expect(coreVeneerRules({ workspaceDir: '/repo', assistantSlug: 'business-bot', elevated })).toContain(f.agent);
    }
  });
  it('delivers general bot question guidance to employees and resumed bots', () => {
    const f=botFeatureCatalog(Date.parse('2026-09-29')).features.find(f=>f.id==='decision-review-context')!;
    expect(f.isNew).toBe(true);
    expect(f.steps.join(' ')).toContain('What the bot needs from you');
    expect(f.agent).toContain('Omit refund when irrelevant');
    expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
    for (const elevated of [false,true]) expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'business-bot',elevated})).toContain(f.agent);
  });
  it('announces the authorized Sol upgrade to employees and current agent instructions', () => {
    const feature = botFeatureCatalog(Date.parse('2026-09-29')).features.find(f => f.id === 'provider-model-updates')!;
    expect(feature.isNew).toBe(true);
    expect(feature.announcement).toContain('GPT-6.1 Sol replaces GPT-6 Sol');
    expect(feature.agent).toContain('owner-authorized migration');
    expect(feature.limits).toContain('does not migrate explicit conversation or bot selections');
    expect(employeeRouteAllowed('GET', '/bot-workflows/guide')).toBe(true);
    for (const elevated of [false, true]) {
      expect(coreVeneerRules({ workspaceDir: '/repo', assistantSlug: 'business-bot', elevated })).toContain(feature.agent);
    }
  });
  it('delivers integrated review steps and unaccepted source boundaries to full/restricted/resumed agents',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-29')).features.find(f=>f.id==='correction-integration')!;
    expect(f.isNew).toBe(true);expect(f.agent).toContain('context_review INPUT');expect(f.agent).toContain('no correction amendment');expect(f.limits).toContain('UNKNOWN');expect(f.steps.join(' ')).toContain('same key');
    expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'business-bot',elevated})).toContain(f.agent);
  });
  it('delivers native-only correction preflight limits to employees and resumed agents',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-29')).features.find(f=>f.id==='correction-preflight')!;
    expect(f.isNew).toBe(true);expect(f.agent).toContain('inspect_correction_preflight');expect(f.agent).toContain('EVERY later human message');expect(f.limits).toContain('Reviews are not persisted');
    expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
    for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'business-bot',elevated})).toContain(f.agent);
  });
  it('delivers prospective correction proof limits to employees and full/restricted resumed agents',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-29')).features.find(f=>f.id==='composed-sms-correction')!;
    expect(f.isNew).toBe(true);expect(f.steps.join(' ')).toContain('composition AND sending');expect(f.limits).toContain('CORRECTION_AUTHORITY_EXPORT_UNAVAILABLE');expect(f.agent).toContain('derive_composed_sms_correction');expect(f.agent).toContain('No replacement after UNKNOWN');
    expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
    for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'business-bot',elevated})).toContain(f.agent);
  });
  it('delivers composed SMS source and execution limits to full, restricted and resumed agents',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-29')).features.find(f=>f.id==='composed-sms')!;
    expect(f.agent).toContain('inspect_composed_sms_scope');expect(f.agent).toContain('native service/evidence registries are configured');expect(f.agent).toContain('Synthetic complete graphs do not establish Brian or global inventory readiness');expect(f.agent).toContain('association/readback v3');expect(f.steps.join(' ')).toContain('no extra customer approval');expect(f.agent).toContain('contextRevision');expect(f.agent).toContain('unknown scopes');expect(f.announcement).toContain('provisioned');
    expect(f.isNew).toBe(true);expect(f.limits).toContain('SMS_SENDER_OWNERSHIP_UNVERIFIED');expect(f.agent).toContain('inspect_composed_sms');expect(f.agent).toContain('do not ask for duplicate reader setup');expect(f.limits).toContain('Grant, Owen, Avery, Nora, Miles and Tess');expect(f.agent).toContain('no generic manual-SMS fallback');
    expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
    for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'business-bot',elevated})).toContain(f.agent);
  });
  it('delivers intent-only SMS guidance to employees and fresh/resumed agents',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-28')).features.find(f=>f.id==='instruction-obligations')!;
    expect(f.isNew).toBe(true);expect(f.steps.join(' ')).toContain('exact existing SMS draft');
    expect(f.agent).toContain('execute:false/ready:false');expect(f.agent).toContain('inspect_instruction_obligation');
    expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
    for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'business-bot',elevated})).toContain(f.agent);
  });
  it('announces same-owner approved delivery with unchanged authority limits',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-28')).features.find(f=>f.id==='approved-message-delegation')!;
    expect(f.isNew).toBe(true);expect(f.updated).toBe('2026-09-28');
    expect(f.steps.join(' ')).toContain('same bot performs both steps');
    expect(f.agent).toContain('existing claim key');expect(f.agent).toContain('Never reopen, reclaim, requeue or resend');
    expect(f.agent).toContain('no self-message');expect(f.agent).toContain('ordinary-draft retrofit');
    expect(botFeatureInstructions()).toContain(f.agent);
    expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
  });
  it('delivers authenticated mapping limits to full/restricted employees and resumed agents',()=>{
    const f=botFeatureCatalog(Date.parse('2026-09-28')).features.find(f=>f.id==='approved-message-delegation')!;
    expect(f.isNew).toBe(true);expect(f.announcement).toContain('dedicated read-only OrderOps resolver');expect(f.agent).toContain('/api/cs/approved-case/capabilities');expect(f.limits).toContain('No broad legacy endpoint fallback');
    expect(f.steps.join(' ')).toContain('each bot’s own identity');expect(f.limits).toContain('six verified ERVP callers');expect(f.limits).toContain('October 28, 2026');
    expect(f.agent).toContain('never normalize either approved string');
    expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
    for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'business-bot',elevated})).toContain(f.agent);
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
    const feature = botFeatureCatalog(Date.parse('2026-10-01')).features.find(f => f.id === 'browser')!;
    expect(feature.isNew).toBe(true);
    expect(feature.limits).toContain('Seven browsers run at once');
    expect(feature.limits).toContain('each project may hold four');
    expect(feature.limits).toContain('four hours after the last click or keystroke');
    expect(feature.announcement).toContain('seven on this Mac and four per project');
    expect(feature.agent).toContain('Seven browsers run at once and each project may hold four');
    expect(feature.agent).toContain('never park a browser');
    expect(feature.limits).toContain('two hours');
    expect(feature.steps.join(' ')).toContain('pauses automatically');
    expect(feature.agent).toContain('keep_open');
    expect(feature.agent).toContain('read_public');
    expect(feature.agent).toContain('wait_for_capacity');
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
    const f=botFeatureCatalog(Date.parse('2026-09-29')).features.find(f=>f.id==='routine-owner-setup')!;
    expect(f.isNew).toBe(true);expect(f.limits).toContain('does not resolve the case');expect(f.agent).toContain('standing_policy.applied');
    expect(employeeRouteAllowed('POST','/bot-communication/cs-standing-policy')).toBe(false);expect(employeeRouteAllowed('GET','/bot-communication/cs-standing-policy')).toBe(false);
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
  it('announces readiness as presentation that grants no authority and stays closed to restricted employees', () => {
    const f=botFeatureCatalog(Date.parse('2026-09-29')).features.find(f=>f.id==='cs-readiness')!;
    expect(f.isNew).toBe(true);expect(f.agent).toContain('read_cs_readiness');expect(f.agent).toContain('never resend');
    expect(f.limits).toContain('grants no authority');
    expect(employeeRouteAllowed('GET','/bot-communication/cs-readiness')).toBe(false);
    expect(employeeRouteAllowed('POST','/bot-communication/cs-outcomes')).toBe(false);
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
    expect(isNewFeature(feature, Date.parse('2026-09-30T23:59:59Z'))).toBe(false);
    expect(isNewFeature(feature, Date.parse('2026-10-01T00:00:00Z'))).toBe(true);
    expect(isNewFeature(feature, Date.parse('2026-10-30T23:59:59Z'))).toBe(true);
    expect(isNewFeature(feature, Date.parse('2026-10-31T00:00:00Z'))).toBe(false);
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
