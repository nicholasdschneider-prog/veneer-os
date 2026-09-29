import fs from 'node:fs';
import {it,expect} from 'vitest';
import {guardManifestSchema,currentContextSchema} from '../src/bots/composedSmsContext.js';
import {composeHash,associationV2Schema,sourceReadbackV2Schema} from '../src/bots/composedSmsContract.js';
const f=JSON.parse(fs.readFileSync(new URL('../../docs/reports/composed-sms/build440-golden.json',import.meta.url),'utf8'));
it('matches shared independent v2 schema/hash vector without pretending manifest proves coverage',()=>{
 expect(guardManifestSchema.parse(f.guardManifest)).toEqual(f.guardManifest);
 expect(currentContextSchema.parse(f.currentContext)).toEqual(f.currentContext);
 expect(associationV2Schema.parse(f.association)).toEqual(f.association);
 expect(sourceReadbackV2Schema.parse(f.sourceReadback)).toEqual(f.sourceReadback);
 expect(composeHash('compose-sms-guards/v1',f.guardManifest)).toBe(f.association.guardManifestHash);
 expect(composeHash('compose-sms-scope-evidence/v1',f.scopeHashInput)).toBe(f.currentContext.scopeEvidenceRevision);
 expect(composeHash('compose-sms-current-context/v1',f.contextHashInput)).toBe(f.currentContext.contextRevision);
});
it.each(['missing','duplicate','boolean','hours','timezone','writer'])('rejects incomplete/misleading manifest %s',kind=>{
 const m=structuredClone(f.guardManifest);
 if(kind==='missing')m.coverage.pop();if(kind==='duplicate')m.coverage[1]=m.coverage[0];
 if(kind==='boolean')m.supported=true;if(kind==='hours')m.recipientTimePolicy.startInclusive='09:00';
 if(kind==='timezone')m.recipientTimePolicy.unknownTimezone='default';if(kind==='writer')m.coverage[0].writers=[];
 expect(guardManifestSchema.safeParse(m).success).toBe(false);
});
it.each(['contextRevision','scopeEvidenceRevision','guardManifestHash'])('requires persisted %s in both v2 directions',key=>{
 const a={...f.association},s={...f.sourceReadback};delete a[key];delete s[key];
 expect(associationV2Schema.safeParse(a).success).toBe(false);expect(sourceReadbackV2Schema.safeParse(s).success).toBe(false);
});
