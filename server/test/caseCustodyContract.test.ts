import {it,expect} from 'vitest';import fs from 'node:fs';
import {authoritySchema,evidenceSchema,evidenceMaterial,sourceIntentSchema,validateSourceIntent,sourceRequestDigest,custodyHash,claimResponseSchema,claimReconciliationSchema} from '../src/bots/caseCustodyContract.js';
const fixture=JSON.parse(fs.readFileSync(new URL('../../docs/reports/case-custody/build485/golden.json',import.meta.url),'utf8'));
it('strict parser goldens preserve null chronology and all five domain digests',()=>{
 const a=authoritySchema.parse(fixture.authority),e=evidenceSchema.parse(fixture.evidence),i=validateSourceIntent(sourceIntentSchema.parse(fixture.lostResponseIntent)),applied=validateSourceIntent(sourceIntentSchema.parse(fixture.appliedIntent));const {authorityHash,...tuple}=a;
 expect(custodyHash('case-custody/authority/v1',tuple)).toBe(fixture.digests.authority);expect(authorityHash).toBe(fixture.digests.authority);
 expect(custodyHash('case-custody/evidence/v1',evidenceMaterial(e))).toBe(fixture.digests.evidence);expect(sourceRequestDigest(i)).toBe(fixture.digests.request);expect(custodyHash('case-custody/transition/v1',a.transition)).toBe(fixture.digests.transition);expect(custodyHash('case-custody/outcome/v1',applied.outcome)).toBe(fixture.digests.outcome);expect(i.claimId).toBeNull();expect(a.closedAt).toBeNull();expect(a.completion.chronology).toBe('event_after_case_version_unbound');
});
it('wrong version, extra fields, uncorrelated outcome and null-claim entitlement fail',()=>{
 expect(()=>authoritySchema.parse({...fixture.authority,execute:true})).toThrow();expect(()=>sourceIntentSchema.parse({...fixture.lostResponseIntent,schemaVersion:'v2'})).toThrow();expect(()=>validateSourceIntent({...fixture.appliedIntent,claimId:null})).toThrow();expect(()=>validateSourceIntent({...fixture.lostResponseIntent,receiptHash:'a'.repeat(64)})).toThrow();expect(()=>claimResponseSchema.parse({execute:false,custodyEntitlement:true,claim:null})).toThrow();expect(()=>claimReconciliationSchema.parse({execute:false,custodyEntitlement:true,claim:null})).toThrow();
});
