import {fixtureCredentialExpiry} from './composeGuardFixture.js';
import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AddressInfo} from 'node:net';
import type {AppContext} from '../src/context.js';
import {migrate} from '../src/db/migrate.js';
import {composedSmsVerifierRoutes} from '../src/bots/composedSmsVerifierRoutes.js';
import {composeServiceRegistrySchema,loadComposeServiceRegistry,type ComposeRegistration} from '../src/bots/composedSmsTrust.js';
import {composeMaterialHash,composeHash,wireSchema} from '../src/bots/composedSmsContract.js';
const id='10000000-0000-4000-8000-000000000001',secret='synthetic-dedicated-service-secret-no-live-value';
function registration():ComposeRegistration{return {registrationId:id,revision:1,active:true,businessId:id,businessOwnerUserId:1,sourceOrigin:'https://orderops-dev-web-production.up.railway.app',runtime:{projectId:id,environmentId:id,serviceId:id},sourceRegistrationHash:'a'.repeat(64),sourceAccountId:'fixture',servicePrincipalId:'service',serviceCredentialHash:crypto.createHash('sha256').update(secret).digest('hex'),nativeAudience:'dedicated',cfClientId:'dedicated-client',capabilities:['compose.authority.read','compose.permit.redeem','compose.association.read'],executorBindings:[{conversationId:id,userId:1,principalId:'executor'}],senderReceiptIssuerId:'issuer',guardContractHash:'b'.repeat(64),expiresAt:'2099-01-01T00:00:00Z',credentialExpiry:fixtureCredentialExpiry(),custodyReceipt:'fixture',readbackCredential:{project:'fixture',config:'test',name:'SEPARATE_SERVICE'},readbackCustodyReceipt:'fixture-readback'};}
it.each(['no-cf','no-bearer','human-audience','shared-client','revoked','unknown-registry','valid'])('enforces independent service gates: %s',async mode=>{
 const db=new Database(':memory:');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'fixture@test','Human','owner')").run();db.prepare('INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,1)').run(id,'Fixture');
 db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,'Fixture','codex',?,'team',?)").run(id,id,id);db.prepare("INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,'Fixture',1,1)").run(id);
 const reg=registration();if(mode==='human-audience')reg.nativeAudience='human';if(mode==='shared-client')reg.cfClientId='return-client';if(mode==='revoked')reg.active=false;
 let reads=0;
 const app=express();app.use('/api/composed-sms/verifier',composedSmsVerifierRoutes({db,config:{cfAud:'human',returnVerifierClientId:'return-client'}} as AppContext,{io:{registration:()=>{if(mode==='unknown-registry')throw Error('absent');return reg;},now:Date.now,nativeCurrent:()=>{},readback:async()=>{reads++;throw Error('must not read');}},cf:async()=>mode!=='no-cf'}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 try{const r=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/composed-sms/verifier/actions/${id}/association`,{headers:{'x-compose-registration-id':id,Authorization:`Bearer ${mode==='no-bearer'?'wrong':secret}`}});expect(r.status).toBe(mode==='valid'?404:mode==='no-cf'||mode==='no-bearer'?401:mode==='revoked'?403:mode==='unknown-registry'?500:503);expect(r.headers.get('cache-control')).toBe('no-store');expect(reads).toBe(0);const context=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/composed-sms/verifier/authorities/${id}/current-context?revision=1&actionId=${id}`,{headers:{'x-compose-registration-id':id,Authorization:`Bearer ${mode==='no-bearer'?'wrong':secret}`}});expect(context.status).toBe(mode==='valid'?503:r.status);const scoped=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/composed-sms/verifier/authorities/${id}/current-context-v2?revision=1&actionId=${id}`,{headers:{'x-compose-registration-id':id,Authorization:`Bearer ${mode==='no-bearer'?'wrong':secret}`}});expect(scoped.status).toBe(mode==='valid'?503:r.status);expect(reads).toBe(0);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();}
});
it('strict protected registry denies symlinks, public modes, unknown fields and missing config',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'compose-trust-')),file=path.join(dir,'registry.json');const value={schemaVersion:'compose-service-registry/v1',registrations:[registration()]};
 try{fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});expect(loadComposeServiceRegistry(file)).toEqual(value);fs.symlinkSync(file,path.join(dir,'alias'));expect(()=>loadComposeServiceRegistry(path.join(dir,'alias'))).toThrow('DISPATCH_BOUNDARY_UNAVAILABLE');fs.chmodSync(file,0o644);expect(()=>loadComposeServiceRegistry(file)).toThrow();expect(()=>loadComposeServiceRegistry(null)).toThrow();expect(()=>composeServiceRegistrySchema.parse({...value,allow:true})).toThrow();}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
it('new material namespace removes only authenticated principal and retains all other identity and nulls',()=>{
 const base={identity:{principalId:'owner',accountId:'account',nativeBusinessId:id,runtime:{projectId:id}},cases:[{relatedOrderId:null}],messages:[]};
 expect(composeMaterialHash(base)).toBe(composeMaterialHash({...base,identity:{...base.identity,principalId:'executor'}}));
 expect(composeMaterialHash(base)).not.toBe(composeMaterialHash({...base,identity:{...base.identity,accountId:'foreign'}}));
 expect(composeMaterialHash(base)).not.toBe(composeHash('other',base));
});

it('preserves exact Unicode and whitespace wire bytes and rejects ill-formed UTF-8',()=>{
 const wire={senderAccountId:'AC'+'a'.repeat(32),fromPhone:'+12025550100',toPhone:'+12025550111',wireBody:'  café\n📷 e\u0301  ',media:[],normalizationPolicy:'sms-identity-utf8/v1'};
 expect(wireSchema.parse(wire).wireBody).toBe(wire.wireBody);
 expect(composeHash('native-compose-sms/wire/v1',wire)).not.toBe(composeHash('native-compose-sms/wire/v1',{...wire,wireBody:wire.wireBody.normalize('NFC')}));
 expect(()=>wireSchema.parse({...wire,wireBody:'\ud800'})).toThrow('UTF-8');
});
