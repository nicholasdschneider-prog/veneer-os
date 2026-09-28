import fs from 'node:fs';
import {it,expect} from 'vitest';
import {composeOriginalHashes} from '../src/bots/composedSmsAuthority.js';
import {verifyAuthority,composeHash,bindingHash} from '../src/bots/composedSmsContract.js';
import {canonicalJson} from '../src/bots/canonical.js';
const fixture=JSON.parse(fs.readFileSync(new URL('../../docs/reports/composed-sms/build437-golden.json',import.meta.url),'utf8'));
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
