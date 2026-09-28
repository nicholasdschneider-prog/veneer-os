import fs from 'node:fs';
import {it,expect} from 'vitest';
import {composeOriginalHashes} from '../src/bots/composedSmsAuthority.js';
import {verifyAuthority,composeHash,bindingHash,authorityTupleSchema,sourceReadbackSchema,associationInputSchema} from '../src/bots/composedSmsContract.js';
import {canonicalJson} from '../src/bots/canonical.js';
const fixture=JSON.parse(fs.readFileSync(new URL('../../docs/reports/composed-sms/build439-golden.json',import.meta.url),'utf8'));
it('matches the independently generated full authority and unchanged explicit binding hash vectors',()=>{
 const {authorityHash,...tuple}=fixture.authority;
 expect(canonicalJson(tuple)).toBe(fixture.canonicalAuthorityWithoutHash);
 expect(composeHash('native-compose-sms/authority/v1',tuple)).toBe(authorityHash);
 expect(verifyAuthority(fixture.authority)).toEqual(fixture.authority);
 expect(bindingHash(fixture.registration,fixture.authority)).toBe(fixture.bindingHash);
 expect(composeOriginalHashes(fixture.snapshot,tuple.sourceInstructionId,tuple.ownerConversationId)).toEqual({payloadHash:tuple.payloadHash,sourceInstructionHash:tuple.sourceInstructionHash});
});
it.each(['payloadHash','sourceInstructionHash'])('rejects missing or tampered %s without treating an old tuple as amended',field=>{
 const a={...fixture.authority};delete a[field];expect(()=>verifyAuthority(a)).toThrow();
 expect(()=>verifyAuthority({...fixture.authority,[field]:'0'.repeat(64)})).toThrow('hashes');
});
it.each(['payload','stored-payload','native-payload','source','consumption','provenance','missing'])('denies mismatched original %s proof',kind=>{
 const s=structuredClone(fixture.snapshot);
 if(kind==='payload')s.scope.payload.body+='!';if(kind==='stored-payload')s.binding.payload_hash='0'.repeat(64);
 if(kind==='native-payload')s.native.binding.payload_hash='0'.repeat(64);
 if(kind==='source')s.native.source.text+='!';if(kind==='consumption')s.native.existing_consumption.source_hash='0'.repeat(64);
 if(kind==='provenance')s.native.source.actor_id=2;if(kind==='missing')delete s.native.binding.source_hash;
 expect(()=>composeOriginalHashes(s,fixture.authority.sourceInstructionId,fixture.authority.ownerConversationId)).toThrow(/proof|provenance/);
});

it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER+1])('rejects unsafe/nonpositive sender revision %s',revision=>{
 expect(authorityTupleSchema.safeParse({...fixture.authority,senderReceiptRevision:revision}).success).toBe(false);
});
it.each(['fixture','AC'+'a'.repeat(31),'AC'+'g'.repeat(32),'ac'+'a'.repeat(32)])('rejects invalid sender account %s',senderAccountId=>{
 expect(authorityTupleSchema.safeParse({...fixture.authority,senderAccountId}).success).toBe(false);
});
it('accepts source438 case-sensitive AC prefix and either hex case, with safe revision',()=>{
 expect(authorityTupleSchema.safeParse({...fixture.authority,senderAccountId:'AC'+'A'.repeat(32),senderReceiptRevision:Number.MAX_SAFE_INTEGER}).success).toBe(true);
});
const readback=()=>({schemaVersion:'native-compose-sms/v1',nativeActionId:fixture.authority.nativeActionId,prepareId:fixture.authority.authorityId,bindingHash:fixture.bindingHash,nativeClaimId:null,associationId:null,attemptId:null,state:'PREPARED',authorityHash:fixture.authority.authorityHash,wirePayloadHash:fixture.authority.wirePayloadHash,idempotencyKey:fixture.authority.idempotencyKey,providerReceipt:null,observedAt:'2026-09-28T23:00:00.123456Z',prepareExpiresAt:'2026-09-28T23:00:10.123456Z',redeemRequestKey:null,execute:false});
it.each(['missing-expiry','invalid-expiry','missing-key','invalid-key','redeeming-null'])('rejects malformed readback %s',kind=>{
 const r:Record<string,unknown>=readback();
 if(kind==='missing-expiry')delete r.prepareExpiresAt;if(kind==='invalid-expiry')r.prepareExpiresAt='tomorrow';
 if(kind==='missing-key')delete r.redeemRequestKey;if(kind==='invalid-key')r.redeemRequestKey='arbitrary-key';
 if(kind==='redeeming-null')r.state='REDEEMING';
 expect(sourceReadbackSchema.safeParse(r).success).toBe(false);
});
it('accepts strict locator readback without an authority extension and UUID-only redemption',()=>{
 const r=readback();expect(sourceReadbackSchema.parse(r)).toEqual(r);
 expect(sourceReadbackSchema.safeParse({...r,state:'REDEEMING',redeemRequestKey:fixture.authority.authorityId}).success).toBe(true);
 expect(sourceReadbackSchema.safeParse({...r,authority:fixture.authority}).success).toBe(false);
 const a={schemaVersion:'native-compose-sms/v1',nativeActionId:fixture.authority.nativeActionId,authorityId:fixture.authority.authorityId,authorityRevision:1,nativeClaimId:fixture.authority.authorityId,sourcePrepareId:fixture.authority.authorityId,bindingHash:fixture.bindingHash,requestKey:fixture.authority.authorityId};
 expect(associationInputSchema.safeParse(a).success).toBe(true);
 expect(associationInputSchema.safeParse({...a,requestKey:'arbitrary-key'}).success).toBe(false);
});
