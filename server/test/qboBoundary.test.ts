import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { migrate } from '../src/db/migrate.js';
import { mintAgentToken } from '../src/runtime/agentTokens.js';
import { qboBoundary, type QboFactResolver } from '../src/qbo/boundary.js';
import { qboRoutes, authenticatedQboCaller } from '../src/qbo/routes.js';
import { H, authorityScope, factsSchema, requestSchema, responseSchema, type Facts, type Caller } from '../src/qbo/contract.js';
import type { AppContext } from '../src/context.js';
const id = () => crypto.randomUUID(), h = 'a'.repeat(64);
describe('native QBO caller/job/independent authority boundary (offline)', () => {
  let db: Database.Database, f: Facts, p: any, caller: Caller, resolver: QboFactResolver, service: ReturnType<typeof qboBoundary>, time: number, refreshes: number;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const chat = id(), business = id(); time = Date.now(); refreshes = 0;
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'fixture@example.test','Fixture','owner')").run();
    db.prepare('INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,1)').run(business, 'Fixture');
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,'Fixture','claude',?,'team',?)").run(chat,id(),business);
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,'Fixture',1)").run(chat);
    db.prepare("INSERT INTO business_bot_members(team_id,conversation_id,role) VALUES(?,?,'bot')").run(business,chat);
    caller = { userId: 1, conversationId: chat, executionConversationId: null, sessionExpiresAt:new Date(time+60000).toISOString() };
    f = factsSchema.parse({ bindingRef:id(),businessId:business,accountRef:'fixture-existing-account',existingGrantRef:'fixture-existing-grant',companyRealm:'123',companyName:'Fixture Company',companyInfoId:'1',jobId:id(),assignmentRevision:h,assignmentEvidenceHash:h,executorConversationId:chat,ownerUserId:1,authorityRef:'fixture-standing-policy',authorityRevision:h,authorityEvidenceHash:h,authorityScopeHash:h,logicalEffectId:'fixture-invoice-1:create-bill',operation:{kind:'create-bill',target:{entity:'Bill',id:null,syncToken:null},payloadHash:h,attachments:[],sourceContext:[{system:'source-document',id:'fixture-invoice-1',revision:h,contentHash:h}],sourceContextHash:H('qbo/source-context/v1',[{system:'source-document',id:'fixture-invoice-1',revision:h,contentHash:h}])},sourceRevision:h,expiresAt:new Date(time+60000).toISOString(),assignmentState:'assigned',authorityState:'current',integration:{audience:'qbo-canonical-helper/v1',helperImplementationHash:h,acceptanceReceiptHash:h,custodyRevision:h,expiresAt:new Date(time+60000).toISOString()} });
    f.authorityScopeHash=authorityScope(f);
    p={schemaVersion:'qbo-operation/v1',bindingRef:f.bindingRef,assignmentRevision:h,authorityRevision:h,audience:'qbo-canonical-helper/v1',requestKey:id(),operation:structuredClone(f.operation)};
    resolver={current:()=>structuredClone(f),receipt:async(_c,r)=>({schemaVersion:'qbo-helper-receipt/v1',reservationId:r.reservationId,effectDigest:r.effectDigest,scopeHash:r.scopeHash,receiptId:id(),outcome:'UNKNOWN',providerEvidence:null,evidenceHash:h,recordedAt:new Date(time).toISOString()})};
    service=qboBoundary(db,resolver,()=>time);
  });
  afterEach(()=>db.close());
  function helper() { const result=responseSchema.parse(service.admit(()=>caller,p)); if(result.refreshEntitlement)refreshes++; return result; }
  it('admits once only after independent proof; inspect and replay never refresh',()=>{
    expect(service.inspect(()=>caller,p).refreshEntitlement).toBe(false);expect(refreshes).toBe(0);
    const first=helper();expect(first.operationEntitlement).toBe(true);expect(first.reservation.authenticatedCaller).toEqual(caller);
    expect(helper().refreshEntitlement).toBe(false);expect(refreshes).toBe(1);
    expect(service.read(()=>caller,{requestKey:p.requestKey})).toMatchObject({status:'RESERVED',refreshEntitlement:false});
  });
  it('production has no speculative assignment/permission resolver',()=>{
    expect(()=>qboBoundary(db).admit(()=>caller,p)).toThrow('QBO_ASSIGNMENT_AND_ACCOUNTING_BINDING_UNAVAILABLE');expect(refreshes).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM qbo_operation_reservations').get()).toEqual({n:0});
  });
  it.each(['caller','job','assignment','permission','revoked-assignment','revoked-permission','expired','integration-expired','payload','attachment','realm','grant','account','inactive'])('rejects %s before any refresh',field=>{
    if(field==='caller')caller.conversationId=id();if(field==='job')p.bindingRef=id();if(field==='assignment')p.assignmentRevision='b'.repeat(64);if(field==='permission')p.authorityRevision='b'.repeat(64);
    if(field==='revoked-assignment')f.assignmentState='revoked';if(field==='revoked-permission')f.authorityState='revoked';if(field==='expired')f.expiresAt=new Date(time).toISOString();if(field==='integration-expired')f.integration.expiresAt=new Date(time).toISOString();
    if(field==='payload')p.operation.payloadHash='b'.repeat(64);if(field==='attachment')p.operation.attachments=[{sha256:h,bytes:10,mime:'application/pdf'}];
    if(field==='realm')f.companyRealm='456';if(field==='grant')f.existingGrantRef='other';if(field==='account')f.accountRef='other';if(field==='inactive')db.prepare('UPDATE bot_registrations SET active=0').run();
    expect(helper).toThrow();expect(refreshes).toBe(0);
  });
  it('serializes concurrent reservations and preserves irrevocable claim-before-revoke',async()=>{
    const results=await Promise.all(Array.from({length:8},()=>Promise.resolve().then(helper)));
    expect(results.filter(x=>x.refreshEntitlement)).toHaveLength(1);f.authorityState='revoked';expect(helper().refreshEntitlement).toBe(false);
    p.requestKey=id();expect(helper).toThrow();expect(refreshes).toBe(1);
  });
  it('revocation before admission wins without refresh',()=>{f.authorityState='revoked';expect(helper).toThrow();expect(refreshes).toBe(0);});
  it('changed owner/job/key/payload/revision cannot escape permanent logical effect',()=>{
    helper();p.requestKey=id();f.bindingRef=id();p.bindingRef=f.bindingRef;f.jobId=id();f.operation.payloadHash='b'.repeat(64);p.operation=structuredClone(f.operation);f.authorityScopeHash=authorityScope(f);f.assignmentRevision='b'.repeat(64);p.assignmentRevision=f.assignmentRevision;
    expect(helper).toThrow('PERMANENTLY_RESERVED');expect(refreshes).toBe(1);
  });
  it('a second active executor and copied job cannot adopt an inflight effect',()=>{
    helper();const second=id();db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,'Second','claude',?,'team',?)").run(second,id(),f.businessId);
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,'Second',1)").run(second);
    db.prepare("INSERT INTO business_bot_members(team_id,conversation_id,role) VALUES(?,?,'bot')").run(f.businessId,second);
    caller.conversationId=second;f.executorConversationId=second;f.jobId=id();f.bindingRef=id();p.bindingRef=f.bindingRef;p.requestKey=id();f.authorityScopeHash=authorityScope(f);
    expect(helper).toThrow('PERMANENTLY_RESERVED');expect(refreshes).toBe(1);
  });
  it('binds exact source identifiers without accepting arbitrary digest labels',()=>{
    p.operation.sourceContext[0].id='different-source';expect(helper).toThrow();expect(refreshes).toBe(0);
    p.operation.sourceContextHash=H('qbo/source-context/v1',p.operation.sourceContext);expect(helper).toThrow('SCOPE_MISMATCH');
  });
  it('same key with changed scope conflicts, rather than returning old entitlement',()=>{helper();p.operation.payloadHash='b'.repeat(64);expect(helper).toThrow('REQUEST_CONFLICT');});
  it('lost response, UNKNOWN, no-effect failure and expiry never release or renew',async()=>{
    const first=helper();await service.reconcile(()=>caller,{requestKey:p.requestKey});
    resolver.receipt=async()=>({schemaVersion:'qbo-helper-receipt/v1',reservationId:first.reservation.reservationId,effectDigest:first.reservation.effectDigest,scopeHash:first.reservation.scopeHash,receiptId:id(),outcome:'FAILED_NO_RETRY',providerEvidence:null,evidenceHash:h,recordedAt:new Date(time).toISOString()});
    await service.reconcile(()=>caller,{requestKey:p.requestKey});time+=100000;
    expect(helper().refreshEntitlement).toBe(false);expect(refreshes).toBe(1);
    expect(()=>db.prepare('DELETE FROM qbo_operation_reservations').run()).toThrow('Permanent');
  });
  it('receipt must be independently fetched and exactly correlated',async()=>{
    helper();resolver.receipt=async()=>({schemaVersion:'qbo-helper-receipt/v1',reservationId:id(),effectDigest:h,scopeHash:h,receiptId:id(),outcome:'SUCCESS',providerEvidence:{requestId:'fixture-provider',responseHash:h,entityId:'42'},evidenceHash:h,recordedAt:new Date(time).toISOString()});
    await expect(service.reconcile(()=>caller,{requestKey:p.requestKey})).rejects.toThrow('SCOPE_MISMATCH');
    await expect(service.reconcile(()=>caller,{requestKey:p.requestKey,outcome:'SUCCESS'})).rejects.toThrow();
    expect(refreshes).toBe(1);
  });
  it('preserves UNKNOWN evidence but rejects conflicting terminal receipts',async()=>{
    const first=helper();await service.reconcile(()=>caller,{requestKey:p.requestKey});
    const terminal={schemaVersion:'qbo-helper-receipt/v1',reservationId:first.reservation.reservationId,effectDigest:first.reservation.effectDigest,scopeHash:first.reservation.scopeHash,receiptId:id(),outcome:'SUCCESS',providerEvidence:{requestId:'fixture-provider',responseHash:h,entityId:'42'},evidenceHash:h,recordedAt:new Date(time).toISOString()};
    resolver.receipt=async()=>terminal;expect((await service.reconcile(()=>caller,{requestKey:p.requestKey})).receipt.outcome).toBe('SUCCESS');
    resolver.receipt=async()=>({...terminal,receiptId:id(),outcome:'FAILED_NO_RETRY'});await expect(service.reconcile(()=>caller,{requestKey:p.requestKey})).rejects.toThrow('TERMINAL_RECEIPT_CONFLICT');expect(refreshes).toBe(1);
  });
  it.each([['SUCCESS','UNKNOWN'],['FAILED_NO_RETRY','SUCCESS']])('rejects terminal %s to %s with different audit IDs',async(before,after)=>{
    const first=helper();const value={schemaVersion:'qbo-helper-receipt/v1',reservationId:first.reservation.reservationId,effectDigest:first.reservation.effectDigest,scopeHash:first.reservation.scopeHash,receiptId:id(),outcome:before,providerEvidence:{requestId:'fixture-provider',responseHash:h,entityId:'42'},evidenceHash:h,recordedAt:new Date(time).toISOString()};
    resolver.receipt=async()=>value;await service.reconcile(()=>caller,{requestKey:p.requestKey});resolver.receipt=async()=>({...value,receiptId:id(),outcome:after});await expect(service.reconcile(()=>caller,{requestKey:p.requestKey})).rejects.toThrow('TERMINAL_RECEIPT_CONFLICT');
  });
  it('caps reservation at existing native session expiry',()=>{caller.sessionExpiresAt=new Date(time+1).toISOString();expect(helper().reservation.expiresAt).toBe(caller.sessionExpiresAt);});
  it('receipt is refused if original session is revoked during readback',async()=>{
    helper();let valid=true;const auth=()=>{if(!valid)throw Error('revoked');return caller;};const original=resolver.receipt;resolver.receipt=async(c,r)=>{const value=await original(c,r);valid=false;return value;};
    await expect(service.reconcile(auth,{requestKey:p.requestKey})).rejects.toThrow('revoked');
    expect(db.prepare('SELECT count(*) n FROM qbo_operation_receipts').get()).toEqual({n:0});
  });
  it.each(['query','update-bill','attach-pdf','verify-attachment'])('requires exact supported %s descriptor',kind=>{
    f.operation.kind=kind as any;f.operation.target=kind==='query'?{entity:'Query',id:null,syncToken:null}:{entity:'Bill',id:'42',syncToken:'7'};
    f.operation.attachments=['attach-pdf','verify-attachment'].includes(kind)?[{sha256:h,bytes:42,mime:'application/pdf'}]:[];
    f.authorityScopeHash=authorityScope(f);p.operation=structuredClone(f.operation);expect(helper().refreshEntitlement).toBe(true);
    p.requestKey=id();p.operation.target.id='43';expect(helper).toThrow();expect(refreshes).toBe(1);
  });
  it('rejects caller labels, generic endpoints and extra fields',()=>{
    expect(()=>requestSchema.parse({...p,caller:'Anna'})).toThrow();expect(()=>requestSchema.parse({...p,operation:{...p.operation,kind:'payment'}})).toThrow();
    expect(()=>service.read(()=>caller,{requestKey:p.requestKey,refresh:true})).toThrow();
  });
  it('authenticates actual existing native token, not human/JSON/env labels',()=>{
    const token=mintAgentToken(db,'fixture@example.test',caller.conversationId);
    const req={get:(key:string)=>key==='X-VP-Agent-Token'?token:undefined} as express.Request;
    expect(authenticatedQboCaller({db},req)).toMatchObject({userId:caller.userId,conversationId:caller.conversationId,executionConversationId:null});
    expect(()=>authenticatedQboCaller({db},{get:()=>undefined,body:{caller:caller.conversationId}} as any)).toThrow('SESSION_REQUIRED');
    db.prepare('DELETE FROM agent_tokens').run();expect(()=>authenticatedQboCaller({db},req)).toThrow('SESSION_REQUIRED');
  });
  it('HTTP boundary refuses missing auth and disabled facts without source calls',async()=>{
    const ctx={db} as AppContext,app=express();app.use(qboRoutes(ctx));const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
    try{const url=`http://127.0.0.1:${(server.address() as any).port}/qbo/admit`;const token=mintAgentToken(db,'fixture@example.test',caller.conversationId);const headers={'content-type':'application/json','X-VP-Agent-Token':token};expect((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)})).status).toBe(403);const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(p)});expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'QBO_ASSIGNMENT_AND_ACCOUNTING_BINDING_UNAVAILABLE'});expect((await fetch(url+'?caller=Anna',{method:'POST',headers,body:JSON.stringify(p)})).status).toBe(400);}
    finally{await new Promise<void>(r=>server.close(()=>r()));}expect(refreshes).toBe(0);
  });
});
