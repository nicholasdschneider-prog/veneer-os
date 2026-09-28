import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {z} from 'zod';
import type Database from 'better-sqlite3';
import {BotError} from './service.js';
import {canonicalSha256} from './canonical.js';
import {uuid,hash,text,time,runtimeSchema} from './composedSmsContract.js';
const segment=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
export const composeServiceRegistrationSchema=z.object({
 registrationId:uuid,revision:z.number().int().positive(),active:z.boolean(),businessId:uuid,businessOwnerUserId:z.number().int().positive(),
 sourceOrigin:z.literal('https://orderops-dev-web-production.up.railway.app'),runtime:runtimeSchema,sourceRegistrationHash:hash,sourceAccountId:text,
 servicePrincipalId:text,serviceCredentialHash:hash,nativeAudience:text,cfClientId:text,
 capabilities:z.tuple([z.literal('compose.authority.read'),z.literal('compose.permit.redeem'),z.literal('compose.association.read')]),
 executorBindings:z.array(z.object({conversationId:uuid,userId:z.number().int().positive(),principalId:text}).strict()).min(1).max(100),
 senderReceiptIssuerId:text,guardContractHash:hash,expiresAt:time,custodyReceipt:text,
 readbackCredential:z.object({project:segment,config:segment,name:z.string().regex(/^[A-Z][A-Z0-9_]{0,199}$/)}).strict(),
 readbackCustodyReceipt:text,
}).strict();
export const composeServiceRegistrySchema=z.object({schemaVersion:z.literal('compose-service-registry/v1'),registrations:z.array(composeServiceRegistrationSchema).max(30)}).strict();
export type ComposeRegistration=z.infer<typeof composeServiceRegistrationSchema>;
export function boundaryUnavailable():never{throw new BotError(503,'DISPATCH_BOUNDARY_UNAVAILABLE: dedicated service trust, verified sender and accepted source guards required');}
export function loadComposeServiceRegistry(file:string|null|undefined){let fd:number|undefined;try{if(!file||!path.isAbsolute(file))return boundaryUnavailable();fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600||s.size>128*1024)return boundaryUnavailable();const b=Buffer.alloc(128*1024+1),n=fs.readSync(fd,b,0,b.length,0);if(n>128*1024)return boundaryUnavailable();return composeServiceRegistrySchema.parse(JSON.parse(b.subarray(0,n).toString('utf8')));}catch{return boundaryUnavailable();}finally{if(fd!==undefined)fs.closeSync(fd);}}
export function bearerMatches(header:unknown,reg:ComposeRegistration){if(typeof header!=='string'||!/^Bearer [^\s]{32,512}$/.test(header))return false;const actual=crypto.createHash('sha256').update(header.slice(7)).digest();return crypto.timingSafeEqual(actual,Buffer.from(reg.serviceCredentialHash,'hex'));}
export function checkComposeRegistration(db:Database.Database,r:ComposeRegistration,now:number){
 if(!r.active||Date.parse(r.expiresAt)<=now)throw new BotError(403,'Composed service registration revoked or expired');
 const team=db.prepare('SELECT owner_id FROM business_teams WHERE id=?').get(r.businessId) as {owner_id:number}|undefined;
 if(team?.owner_id!==r.businessOwnerUserId||!db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(r.businessOwnerUserId))throw new BotError(403,'Composed service business owner changed');
 if(new Set(r.executorBindings.map(x=>x.conversationId)).size!==r.executorBindings.length||new Set(r.executorBindings.map(x=>x.principalId)).size!==r.executorBindings.length)throw new BotError(403,'Ambiguous service executor bindings');
 for(const b of r.executorBindings){const row=db.prepare('SELECT user_id,business_team_id,archived FROM conversations WHERE id=?').get(b.conversationId) as {user_id:number;business_team_id:string;archived:number}|undefined;if(!row||row.archived||row.user_id!==b.userId||row.business_team_id!==r.businessId||!db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(b.userId)||!db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(b.conversationId))throw new BotError(403,'Composed service executor access changed');}
 return canonicalSha256(r);
}
