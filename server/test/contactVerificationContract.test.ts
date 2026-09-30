import { it, expect } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { manifestSchema, evidenceSchema, authoritySchema, generationSchema, intentEvidenceSchema, associationInput, associationResponse, reconcileResponse, receiptResponse, CONTACT_CONTRACT_HASH, contactHash, evidenceMaterial, intentMaterial, intentDigest } from '../src/bots/contactVerificationContract.js';
const fixture = JSON.parse(fs.readFileSync(new URL('../../docs/reports/contact-verification/build487/golden.json', import.meta.url), 'utf8'));
it('parses both independent same-executor golden targets and all fixed domain digests', () => {
    for (const f of fixture.targets) {
        const m = manifestSchema.parse(f.manifest), e = evidenceSchema.parse(f.evidence), a = authoritySchema.parse(f.authority), g = generationSchema.parse(f.generation), i = intentEvidenceSchema.parse(f.intent), accepted = intentEvidenceSchema.parse(f.accepted);
        expect(associationInput.parse(f.request)).toEqual(f.request);
        expect(associationResponse.parse({ execute: false, dispatchEntitlement: true, association: f.association }).dispatchEntitlement).toBe(true);
        expect(reconcileResponse.parse({ execute: false, dispatchEntitlement: false, association: f.association }).execute).toBe(false);
        receiptResponse.parse({ execute: false, dispatchEntitlement: false, associationId: f.association.id, outcome: accepted.outcome });
        const { authorityHash, ...ab } = a, { generationHash, ...gb } = g;
        expect(contactHash('contact-verification/authority/v1', ab)).toBe(f.digests.authority);
        expect(contactHash('contact-verification/generation/v1', gb)).toBe(f.digests.generation);
        expect(contactHash('contact-verification/evidence/v1', evidenceMaterial(e))).toBe(f.digests.evidence);
        expect(contactHash('contact-verification/dispatch-evidence/v1', intentMaterial(i))).toBe(f.digests.dispatchEvidence);
        expect(contactHash('contact-verification/dispatch-evidence/v1', intentMaterial(accepted))).toBe(f.digests.acceptedEvidence);
        expect(g.intents.map(x => intentDigest(g, x))).toEqual([f.digests.emailIntent, f.digests.smsIntent]);
        const { outcomeHash, ...o } = accepted.outcome!;
        expect(contactHash('contact-verification/outcome/v1', o)).toBe(f.digests.outcome);
        expect(m.statementHash).toBe(f.digests.statement);
        expect(m.channels.map(c => c.templateHash)).toEqual([f.digests.templateEmail, f.digests.templateSms]);
        expect(m.manifestHash).toBe(f.digests.manifest);
    }
    expect(fixture.targets[0].manifest.executor).toEqual(fixture.targets[1].manifest.executor);
    expect(fixture.targets[0].manifest.target.caseId).not.toBe(fixture.targets[1].manifest.target.caseId);
});
it('strict parser rejects wrong version, raw secrets, missing fields, slot policy drift and channel duplication', () => { const f = fixture.targets[0]; for (const edit of [{ schemaVersion: 'paired-contact-authority/v2' }, { secret: 'forbidden' }, { manifestHash: undefined }])
    expect(() => authoritySchema.parse({ ...f.authority, ...edit })).toThrow(); for (const edit of [{ entropyBits: 128 }, { placement: 'query' }, { origin: 'http://unsafe.test' }, { path: '/verify?token=' }]) {
    const m = structuredClone(f.manifest);
    Object.assign(m.channels[0].slot, edit);
    expect(() => manifestSchema.parse(m)).toThrow();
} const m = structuredClone(f.manifest); m.channels[1] = m.channels[0]; expect(() => manifestSchema.parse(m)).toThrow(); expect(() => reconcileResponse.parse({ execute: false, dispatchEntitlement: true, association: f.association })).toThrow(); });

it('pins the exact published native contract bytes', () => { const bytes=fs.readFileSync(new URL('../../docs/reports/contact-verification/build487/contract.md', import.meta.url)); expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(CONTACT_CONTRACT_HASH); });

it('rejects all negative semantic goldens even after enclosing hashes are recomputed',()=>{
 const vectors=JSON.parse(fs.readFileSync(new URL('../../docs/reports/contact-verification/build487/negative-golden.json',import.meta.url),'utf8')).vectors;
 for(const v of vectors){const schema=v.schema==='authority'?authoritySchema:v.schema==='generation'?generationSchema:intentEvidenceSchema;expect(schema.safeParse(v.value).success,v.name).toBe(false);}
});
