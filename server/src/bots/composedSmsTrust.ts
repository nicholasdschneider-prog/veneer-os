import {guardManifestSchema} from './composedSmsContext.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {z} from 'zod';
import type Database from 'better-sqlite3';
import {BotError} from './service.js';
import {canonicalSha256} from './canonical.js';
import {uuid,hash,text,time,runtimeSchema} from './composedSmsContract.js';
const segment=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
export const credentialExpirySchema=z.object({
 schemaVersion:z.literal('compose-credential-expiry/v1'),
 serviceTokenId:uuid,serviceTokenExpiresAt:time,custodyExpiresAt:time,
 bearerExpiresAt:time,readbackExpiresAt:time,
 verifiedAt:time,verifiedBy:uuid,receipt:text,receiptHash:hash,
}).strict();
export function credentialExpiryLimit(e:z.infer<typeof credentialExpirySchema>){return Math.min(...[e.serviceTokenExpiresAt,e.custodyExpiresAt,e.bearerExpiresAt,e.readbackExpiresAt].map(Date.parse));}
export const composeServiceRegistrationSchema=z.object({
 registrationId:uuid,revision:z.number().int().positive(),active:z.boolean(),businessId:uuid,businessOwnerUserId:z.number().int().positive(),
 sourceOrigin:z.literal('https://orderops-dev-web-production.up.railway.app'),runtime:runtimeSchema,sourceRegistrationHash:hash,sourceAccountId:text,
 servicePrincipalId:text,serviceCredentialHash:hash,nativeAudience:text,cfClientId:text,
 capabilities:z.tuple([z.literal('compose.authority.read'),z.literal('compose.permit.redeem'),z.literal('compose.association.read')]),
 executorBindings:z.array(z.object({conversationId:uuid,userId:z.number().int().positive(),principalId:text}).strict()).min(1).max(100),
 senderReceiptIssuerId:text,guardContractHash:hash,expiresAt:time,custodyReceipt:text,
 credentialExpiry:credentialExpirySchema,
 readbackCredential:z.object({project:segment,config:segment,name:z.string().regex(/^[A-Z][A-Z0-9_]{0,199}$/)}).strict(),
 readbackCustodyReceipt:text,
 correctionAcceptance:z.object({schemaVersion:z.literal('compose-correction-acceptance/v1'),nativeIssuer:z.string().url().refine(s=>new URL(s).protocol==='https:'&&new URL(s).origin===s),sourceRegistrationHash:hash,
  contractHash:hash,sourceImplementationHash:hash,lineageAdoptionReceiptHash:hash,custodyAmendmentHash:hash,
  reviewedBy:uuid,receipt:text,reviewedAt:time,expiresAt:time,
  capabilities:z.tuple([z.literal('compose.correction.read'),z.literal('compose.lineage.read'),z.literal('compose.correction.associate'),z.literal('compose.correction.readback'),z.literal('compose.correction.scope')]),
 }).strict().optional(),
 guardManifest:guardManifestSchema.optional(),
 guardAcceptance:z.object({manifestHash:hash,reviewedBy:uuid,receipt:text,reviewedAt:time,expiresAt:time}).strict().optional(),
}).strict().refine(r=>Date.parse(r.expiresAt)<=credentialExpiryLimit(r.credentialExpiry)&&Date.parse(r.credentialExpiry.verifiedAt)<credentialExpiryLimit(r.credentialExpiry),{message:'Registration exceeds verified credential/custody expiry'});
export const composeServiceRegistrySchema=z.object({schemaVersion:z.literal('compose-service-registry/v1'),registrations:z.array(composeServiceRegistrationSchema).max(30)}).strict();
export type ComposeRegistration=z.infer<typeof composeServiceRegistrationSchema>;
export function boundaryUnavailable():never{throw new BotError(503,'DISPATCH_BOUNDARY_UNAVAILABLE: dedicated service trust, verified sender and accepted source guards required');}
export function loadComposeServiceRegistry(file:string|null|undefined){let fd:number|undefined;try{if(!file||!path.isAbsolute(file))return boundaryUnavailable();fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600||s.size>128*1024)return boundaryUnavailable();const b=Buffer.alloc(128*1024+1),n=fs.readSync(fd,b,0,b.length,0);if(n>128*1024)return boundaryUnavailable();return composeServiceRegistrySchema.parse(JSON.parse(b.subarray(0,n).toString('utf8')));}catch{return boundaryUnavailable();}finally{if(fd!==undefined)fs.closeSync(fd);}}
export function bearerMatches(header:unknown,reg:ComposeRegistration){if(typeof header!=='string'||!/^Bearer [^\s]{32,512}$/.test(header))return false;const actual=crypto.createHash('sha256').update(header.slice(7)).digest();return crypto.timingSafeEqual(actual,Buffer.from(reg.serviceCredentialHash,'hex'));}
export function checkComposeRegistration(db:Database.Database,r:ComposeRegistration,now:number){
 if(!Number.isFinite(now)||!composeServiceRegistrationSchema.safeParse(r).success||Date.parse(r.credentialExpiry.verifiedAt)>now)throw new BotError(403,'Invalid composed service credential expiry evidence');
 if(!r.active||Math.min(Date.parse(r.expiresAt),credentialExpiryLimit(r.credentialExpiry))<=now)throw new BotError(403,'Composed service registration revoked or expired');
 const team=db.prepare('SELECT owner_id FROM business_teams WHERE id=?').get(r.businessId) as {owner_id:number}|undefined;
 if(team?.owner_id!==r.businessOwnerUserId||!db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(r.businessOwnerUserId))throw new BotError(403,'Composed service business owner changed');
 if(new Set(r.executorBindings.map(x=>x.conversationId)).size!==r.executorBindings.length||new Set(r.executorBindings.map(x=>x.principalId)).size!==r.executorBindings.length)throw new BotError(403,'Ambiguous service executor bindings');
 for(const b of r.executorBindings){const row=db.prepare('SELECT user_id,business_team_id,archived FROM conversations WHERE id=?').get(b.conversationId) as {user_id:number;business_team_id:string;archived:number}|undefined;if(!row||row.archived||row.user_id!==b.userId||row.business_team_id!==r.businessId||!db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(b.userId)||!db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(b.conversationId))throw new BotError(403,'Composed service executor access changed');}
 return canonicalSha256(r);
}

export function checkCorrectionAcceptance(r:ComposeRegistration,now:number){
 const p=r.correctionAcceptance;
 if(!p||p.contractHash!=='6457641ca5d576fbd43c7828e1da6d4e81af84549ac0b0c67b8f5ef1914b1479'||p.sourceRegistrationHash!==r.sourceRegistrationHash||Date.parse(p.reviewedAt)>now||Date.parse(p.expiresAt)<=now||Date.parse(p.expiresAt)>Math.min(Date.parse(r.expiresAt),credentialExpiryLimit(r.credentialExpiry)))return boundaryUnavailable();
 return p;
}
