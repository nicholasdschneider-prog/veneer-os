import {z} from 'zod';
import {uuid,hash,time,runtimeSchema,composeHash} from './composedSmsContract.js';
import {canonicalSha256} from './canonical.js';
import type {ComposeRegistration} from './composedSmsTrust.js';
import {BotError} from './service.js';
const text=z.string().min(1).max(1000);
const account=z.string().regex(/^AC[0-9a-fA-F]{32}$/),phone=z.string().regex(/^\+[1-9][0-9]{7,14}$/);
// Matches source441 protected senderSchema; unknown-only correspondence v1 stays unchanged.
export const composeSenderReceiptSchema=z.object({schemaVersion:z.literal('compose-sms-sender/v1'),receiptId:uuid,revision:z.number().int().positive().safe(),issuerId:uuid,authorityEvidence:text,provider:z.literal('twilio'),providerAccountId:account,fromPhone:phone,ownershipVerified:z.literal(true),smsCapable:z.literal(true),active:z.literal(true),sourceAccountId:text,nativeBusinessId:uuid,sourceOrigin:z.literal('https://orderops-dev-web-production.up.railway.app'),runtime:runtimeSchema,verifiedAt:time,expiresAt:time,evidenceReferences:z.array(text).min(1).max(100),revokedAt:time.nullable()}).strict();
export const composeSenderObservationSchema=z.object({schemaVersion:z.literal('compose-sms-sender-observation/v1'),registrationId:uuid,sourceRegistrationHash:hash,receipt:composeSenderReceiptSchema,
 process:z.object({runtime:runtimeSchema,implementationRevision:z.string().min(1).max(200),processGenerationId:uuid,clientGenerationId:uuid,observedAt:time,configuredAccountId:account.nullable(),effectiveAccountId:account.nullable(),configuredFromPhone:phone.nullable(),effectiveFromPhone:phone.nullable()}).strict(),observedAt:time,expiresAt:time,snapshotHash:hash}).strict();
/** Server-authenticated source response only. Caller input is never sender proof. */
export function verifyComposeSender(value:unknown,r:ComposeRegistration,now:number){
 const v=composeSenderObservationSchema.parse(value),s=v.receipt,{observedAt,expiresAt,snapshotHash,...material}=v;
 if(v.registrationId!==r.registrationId||v.sourceRegistrationHash!==r.sourceRegistrationHash||s.issuerId!==r.senderReceiptIssuerId||s.nativeBusinessId!==r.businessId||s.sourceAccountId!==r.sourceAccountId||s.sourceOrigin!==r.sourceOrigin||canonicalSha256(s.runtime)!==canonicalSha256(r.runtime)||s.revokedAt!==null||composeHash('compose-sms-sender-observation/v1',material)!==snapshotHash)throw new BotError(409,'Sender identity, issuer, revocation or snapshot differs');
 if(Date.parse(s.verifiedAt)>now||Date.parse(s.expiresAt)<=now||Date.parse(s.expiresAt)-Date.parse(s.verifiedAt)>900000||Date.parse(expiresAt)<=now||Date.parse(observedAt)>now||Date.parse(expiresAt)-Date.parse(observedAt)>15000||Date.parse(expiresAt)<=Date.parse(observedAt)||Date.parse(expiresAt)>Math.min(Date.parse(s.expiresAt),Date.parse(r.expiresAt)))throw new BotError(409,'Sender evidence expired or invalid observation');
 if(canonicalSha256(v.process.runtime)!==canonicalSha256(r.runtime)||v.process.implementationRevision!==r.guardManifest?.implementationRevision||Date.parse(v.process.observedAt)>Date.parse(observedAt)||now-Date.parse(v.process.observedAt)>5000)throw new BotError(409,'Actual dispatcher generation provenance differs');
 if(v.process.configuredAccountId!==s.providerAccountId||v.process.effectiveAccountId!==s.providerAccountId||v.process.configuredFromPhone!==s.fromPhone||v.process.effectiveFromPhone!==s.fromPhone)throw new BotError(409,'Actual dispatch process sender identity differs');
 return {receiptId:s.receiptId,revision:s.revision,issuerId:s.issuerId,providerAccountId:s.providerAccountId,fromPhone:s.fromPhone,expiresAt:s.expiresAt};
}
