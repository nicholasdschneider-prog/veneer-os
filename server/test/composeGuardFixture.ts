import type {ComposeRegistration} from '../src/bots/composedSmsTrust.js';
import {composeHash} from '../src/bots/composedSmsContract.js';
export function fixtureGuards(r:ComposeRegistration){
 r.guardManifest={schemaVersion:'compose-sms-guards/v1',sourceOrigin:r.sourceOrigin,runtime:r.runtime,implementationRevision:'synthetic-only',migrationRevisions:['fixture-v1'],sourceRegistrationHash:r.sourceRegistrationHash,nativeContextContract:'compose-sms-current-context/v1',normalizationPolicy:'sms-identity-utf8/v1',recipientTimePolicy:{id:'synthetic-policy',revision:'1',evidenceReference:'synthetic-only',startInclusive:'07:00',endExclusive:'22:00',timezoneEvidenceRequired:true,unknownTimezone:'deny'},coverage:(['enrollment','lease','material','suppression','duplicate','holds','local_time'] as const).map(guard=>({guard,records:[{table:'synthetic',revisionFields:['version']}],writers:[{id:'synthetic',revision:'1'}],serialization:{mechanism:'fixture-transaction',lockOrder:['synthetic']},validationRevision:'fixture-only'}))};
 r.guardContractHash=composeHash('compose-sms-guards/v1',r.guardManifest);
 r.guardAcceptance={manifestHash:r.guardContractHash,reviewedBy:r.registrationId,receipt:'synthetic-no-production-acceptance',reviewedAt:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'};
}

export function fixtureCredentialExpiry(){return {schemaVersion:'compose-credential-expiry/v1' as const,serviceTokenId:'40000000-0000-4000-8000-000000000009',serviceTokenExpiresAt:'2099-01-01T00:00:00Z',custodyExpiresAt:'2099-01-01T00:00:00Z',bearerExpiresAt:'2099-01-01T00:00:00Z',readbackExpiresAt:'2099-01-01T00:00:00Z',verifiedAt:'2020-01-01T00:00:00Z',verifiedBy:'40000000-0000-4000-8000-000000000008',receipt:'synthetic-only',receiptHash:'a'.repeat(64)};}
