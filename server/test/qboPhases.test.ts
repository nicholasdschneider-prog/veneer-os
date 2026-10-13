import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { qboRoutes } from '../src/qbo/routes.js';
import { mintAgentToken } from '../src/runtime/agentTokens.js';
import type { AppContext } from '../src/context.js';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { H } from '../src/qbo/contract.js';
import { phaseBoundary, grantDigest, type PhaseResolver, type HelperTransport } from '../src/qbo/phaseBoundary.js';
import { helperHash, authorityScopeV2, providerRequestHash, type FactsV2, type Phase, type RequestV2 } from '../src/qbo/phaseContract.js';
import { ownedHelperTransport } from '../src/qbo/helperProcess.js';
const id=()=>crypto.randomUUID(), h='a'.repeat(64), sha=(v:string|Buffer)=>crypto.createHash('sha256').update(v).digest('hex');
describe('QBO v2 phases and private helper transport (offline)',()=>{
  let db:Database.Database,time:number,refreshes:number,caller:any,f:FactsV2,r:RequestV2,input:any,service:ReturnType<typeof phaseBoundary>,resolver:PhaseResolver,transport:HelperTransport;
  let script:(value:any,event:(v:unknown)=>any)=>Promise<void>,prepareCount:number,assertionErrors:unknown[];
  beforeEach(()=>{
    db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const chat = id(), business = id(); time = Date.now(); refreshes = 0;
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'fixture@example.test','Fixture','owner')").run();
    db.prepare('INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,1)').run(business, 'Fixture');
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,'Fixture','claude',?,'team',?)").run(chat,id(),business);
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,'Fixture',1)").run(chat);
    db.prepare("INSERT INTO business_bot_members(team_id,conversation_id,role) VALUES(?,?,'bot')").run(business,chat);
    caller={userId:1,conversationId:chat,executionConversationId:null,sessionExpiresAt:new Date(time+60000).toISOString()};
    const context=[{system:'source-document' as const,id:'fixture-bill',revision:h,contentHash:h}];
    const helper={runtime:'node' as const,dependencyClosureHash:h,executable:{path:'/fixture/runtime',sha256:h},script:{path:'/fixture/helper.mjs',sha256:h},dependencies:[],uid:501,acceptanceHash:h};
    f={bindingRef:id(),businessId:business,accountRef:'fixture-account',existingGrantRef:'fixture-grant',companyRealm:'123',companyName:'Fixture',companyInfoId:'1',jobId:id(),assignmentRevision:h,assignmentEvidenceHash:h,executorConversationId:chat,ownerUserId:1,authorityRef:'fixture-policy',authorityRevision:h,authorityEvidenceHash:h,authorityScopeHash:h,logicalEffectId:'fixture-read',operation:{kind:'read-bill',target:{entity:'Bill',id:'42',syncToken:null},payloadHash:sha('fixture'),providerRequest:{method:'GET',path:'/bill/42'},attachments:[],sourceContext:context,sourceContextHash:H('qbo/source-context/v1',context),observationHash:null},sourceRevision:h,expiresAt:new Date(time+60000).toISOString(),assignmentState:'assigned',authorityState:'current',integration:{audience:'qbo-canonical-helper/v1',helperImplementationHash:helperHash(helper),acceptanceReceiptHash:h,custodyRevision:h,expiresAt:new Date(time+60000).toISOString()},helper};
    f.authorityScopeHash=authorityScopeV2(f);
    r={schemaVersion:'qbo-operation/v2',bindingRef:f.bindingRef,assignmentRevision:h,authorityRevision:h,audience:'qbo-canonical-helper/v1',requestKey:id(),operation:structuredClone(f.operation)};
    input={request:r,bytes:{payloadBase64:Buffer.from('fixture').toString('base64'),attachmentsBase64:[]}};
    assertionErrors=[];resolver={current:()=>structuredClone(f),reconciliation:()=>structuredClone(f.helper)};prepareCount=0;
    script=async()=>{};transport={prepare:async()=>{prepareCount++;return async(v,e)=>{try{await script(v,e);}catch(error){if(error instanceof Error&&error.name==='AssertionError')assertionErrors.push(error.message);throw error;}};}};
    service=phaseBoundary(db,resolver,transport,()=>time);
  });
  afterEach(()=>{db.close();expect(assertionErrors).toEqual([]);});
  function driver(value:any,event:(v:unknown)=>any){
    let phase:Phase=value.phase??value.phases.at(-1);
    return (action:string,extra:Record<string,unknown>={})=>{
      const e={schemaVersion:'qbo-helper-event/v2',invocationId:phase.invocationId,receiptId:id(),sequence:phase.sequence+1,previousHash:H('qbo/phase/v2',phase),action,evidenceHash:h,providerRequestHash:null,billResult:null,...extra};
      const result=event(e);phase=result.phase;if(result.refreshEntitlement)refreshes++;return {e,result};
    };
  }
  function accepted(value:any,event:(v:unknown)=>any){const emit=driver(value,event);emit('refresh-start');emit('refresh-confirmed');emit('persistence-confirmed');emit('dispatch-start',{providerRequestHash:providerRequestHash(r,f)});return emit('dispatch-accepted',{providerRequestHash:providerRequestHash(r,f),billResult:{billId:'42',companyRealm:'123',syncToken:'7',sourceRevision:h,resultDigest:h,capturedAt:new Date(time).toISOString()}});}
  it('records durable before-call phases and a separate read observation',async()=>{
    script=async(v,e)=>{accepted(v,(raw)=>{const out=e(raw);if(out.refreshEntitlement||out.operationEntitlement)expect(db.prepare('SELECT 1 FROM qbo_v2_phases WHERE receipt_id=?').get(out.phase.receiptId)).toBeTruthy();return out;});};
    const out=await service.invoke(()=>caller,input);expect(out.observation).toMatchObject({billId:'42',syncToken:'7'});expect(out.phases.at(-1)?.dispatch).toBe('accepted');expect(out.operationEntitlement).toBe(false);expect(refreshes).toBe(1);
    await service.invoke(()=>caller,input);expect(refreshes).toBe(1);
  });
  it.each(['assignment','permission','session','bytes','company'])('denies %s without spawning or refresh',async(field)=>{
    if(field==='assignment')f.assignmentState='revoked';if(field==='permission')f.authorityState='revoked';if(field==='session')caller.sessionExpiresAt=new Date(time).toISOString();if(field==='bytes')input.bytes.payloadBase64=Buffer.from('tampered').toString('base64');if(field==='company')f.companyRealm='456';
    await expect(service.invoke(()=>caller,input)).rejects.toThrow();expect(prepareCount).toBe(0);expect(refreshes).toBe(0);
  });
  it.each(['refresh-start','refresh-confirmed','persistence-confirmed','dispatch-start'])('crash after %s is conservative and cannot retry',async(stop)=>{
    script=async(v,e)=>{const emit=driver(v,e);for(const action of ['refresh-start','refresh-confirmed','persistence-confirmed','dispatch-start']){emit(action,action==='dispatch-start'?{providerRequestHash:providerRequestHash(r,f)}:{});if(action===stop)throw Error('offline crash');}};
    const out=await service.invoke(()=>caller,input),last=out.phases.at(-1)!;expect(last.closed).toBe(true);expect(last.refresh==='UNKNOWN'||last.refresh==='confirmed').toBe(true);
    if(stop==='dispatch-start')expect(last.dispatch).toBe('UNKNOWN');
    r.requestKey=id();await expect(service.invoke(()=>caller,input)).rejects.toThrow();expect(refreshes).toBe(1);
  });
  it('fences all same-grant effects until receipt-only persistence reconciliation',async()=>{
    script=async(v,e)=>{driver(v,e)('refresh-start');throw Error('crash');};await service.invoke(()=>caller,input);
    const key=r.requestKey;r.requestKey=id();f.logicalEffectId='different-effect';await expect(service.invoke(()=>caller,input)).rejects.toThrow('SHARED_GRANT');
    script=async(v,e)=>{const emit=driver(v,e);expect(emit('refresh-confirmed').result.refreshEntitlement).toBe(false);expect(emit('persistence-confirmed').result.operationEntitlement).toBe(false);};
    await service.reconcile(()=>caller,{requestKey:key});expect(refreshes).toBe(1);
  });
  it('expired session still records persistence but denies dispatch',async()=>{
    script=async(v,e)=>{const emit=driver(v,e);emit('refresh-start');emit('refresh-confirmed');time+=16000;emit('persistence-confirmed');expect(()=>emit('dispatch-start',{providerRequestHash:providerRequestHash(r,f)})).toThrow('EXPIRED');};
    const out=await service.invoke(()=>caller,input);expect(out.phases.at(-1)).toMatchObject({persistence:'confirmed',dispatch:'not-started',closed:true});
  });
  it('retains exact phase replay after terminal result; changed same ID conflicts',async()=>{
    script=async(v,e)=>{const emit=driver(v,e),a=emit('refresh-start');emit('refresh-confirmed');emit('persistence-confirmed');emit('dispatch-start',{providerRequestHash:providerRequestHash(r,f)});emit('dispatch-unknown',{providerRequestHash:providerRequestHash(r,f)});const before=db.prepare('SELECT count(*) n FROM qbo_v2_phases').get();expect(e(a.e).refreshEntitlement).toBe(false);expect(db.prepare('SELECT count(*) n FROM qbo_v2_phases').get()).toEqual(before);expect(()=>e({...a.e,evidenceHash:'b'.repeat(64)})).toThrow('RECEIPT_CONFLICT');};await service.invoke(()=>caller,input);
  });
  it('observation cannot authorize a write and stale/changed observations fail',async()=>{
    script=async(v,e)=>{accepted(v,e);};const out=await service.invoke(()=>caller,input);const observation=out.phases.at(-1)!.observationHash!;
    r.requestKey=id();f.logicalEffectId='fixture-write';f.operation={...f.operation,kind:'update-bill',target:{entity:'Bill',id:'42',syncToken:'8'},providerRequest:{method:'POST',path:'/bill'},observationHash:observation};r.operation=structuredClone(f.operation);f.authorityScopeHash=authorityScopeV2(f);
    await expect(service.invoke(()=>caller,input)).rejects.toThrow('OBSERVATION');
    f.operation.target.syncToken='7';r.operation=structuredClone(f.operation);f.authorityScopeHash=authorityScopeV2(f);time+=15000;await expect(service.invoke(()=>caller,input)).rejects.toThrow('OBSERVATION');expect(refreshes).toBe(1);
  });
  it('serializes competing same-grant invocations before refresh',async()=>{
    let release!:()=>void;script=async(v,e)=>{driver(v,e)('refresh-start');await new Promise<void>(r=>release=r);};
    const first=service.invoke(()=>caller,input);await new Promise(r=>setTimeout(r,0));
    const other=structuredClone(input);other.request.requestKey=id();f.logicalEffectId='other';await expect(service.invoke(()=>caller,other)).rejects.toThrow('SHARED_GRANT');release();await first;expect(refreshes).toBe(1);
  });
  it('checks observation freshness again immediately before dispatch',async()=>{
    script=async(v,e)=>{accepted(v,e);};const out=await service.invoke(()=>caller,input);
    r.requestKey=id();f.logicalEffectId='write-after-read';f.operation={...f.operation,kind:'update-bill',target:{entity:'Bill',id:'42',syncToken:'7'},providerRequest:{method:'POST',path:'/bill'},observationHash:out.phases.at(-1)!.observationHash};f.authorityScopeHash=authorityScopeV2(f);r.operation=structuredClone(f.operation);
    time+=1000;script=async(v,e)=>{const emit=driver(v,e);emit('refresh-start');emit('refresh-confirmed');emit('persistence-confirmed');time+=14000;expect(()=>emit('dispatch-start',{providerRequestHash:providerRequestHash(r,f)})).toThrow('OBSERVATION');};
    const result=await service.invoke(()=>caller,input);expect(result.phases.at(-1)?.dispatch).toBe('not-started');
  });
  it('records rotation persistence after revocation without permitting dispatch',async()=>{
    script=async(v,e)=>{const emit=driver(v,e);emit('refresh-start');emit('refresh-confirmed');f.authorityState='revoked';emit('persistence-confirmed');expect(()=>emit('dispatch-start',{providerRequestHash:providerRequestHash(r,f)})).toThrow('REVOKED');};
    expect((await service.invoke(()=>caller,input)).phases.at(-1)).toMatchObject({persistence:'confirmed',dispatch:'not-started'});
  });
  it('denies skipped stages, foreign invocation and forged provider scope',async()=>{
    script=async(v,e)=>{const emit=driver(v,e);expect(()=>emit('persistence-confirmed')).toThrow('PERSISTENCE');expect(()=>emit('refresh-start',{invocationId:id()})).toThrow('CORRELATION');emit('refresh-start');emit('refresh-confirmed');emit('persistence-confirmed');expect(()=>emit('dispatch-start',{providerRequestHash:h})).toThrow('DISPATCH_PREREQUISITES');};
    expect((await service.invoke(()=>caller,input)).phases.at(-1)?.dispatch).toBe('not-started');
  });
  it('readback after dispatch uncertainty resolves evidence without new dispatch or observation lifetime',async()=>{
    script=async(v,e)=>{const emit=driver(v,e);emit('refresh-start');emit('refresh-confirmed');emit('persistence-confirmed');emit('dispatch-start',{providerRequestHash:providerRequestHash(r,f)});throw Error('lost response');};
    const first=await service.invoke(()=>caller,input),capturedAt=new Date(time).toISOString();time+=20000;
    script=async(v,e)=>{const emit=driver(v,e);expect(()=>emit('refresh-start')).toThrow('RECONCILIATION_ONLY');const result=emit('dispatch-accepted',{providerRequestHash:providerRequestHash(r,f),billResult:{billId:'42',companyRealm:'123',syncToken:'7',sourceRevision:h,resultDigest:h,capturedAt}});expect(result.result.operationEntitlement).toBe(false);};
    const out=await service.reconcile(()=>caller,{requestKey:r.requestKey});expect(out.phases.at(-1)?.dispatch).toBe('accepted');expect(Date.parse(out.observation!.expiresAt)).toBeLessThan(time);expect(refreshes).toBe(1);expect(first.phases.at(-1)?.dispatch).toBe('UNKNOWN');
  });
  it('production cannot invoke helper without accepted facts',async()=>{await expect(phaseBoundary(db).invoke(()=>caller,input)).rejects.toThrow('UNAVAILABLE');expect(prepareCount).toBe(0);});
  it('uses the canonical existing grant fence across company/business labels',()=>{
    expect(grantDigest(f)).toBe(grantDigest({...f,businessId:id(),companyRealm:'456'}));
  });
  it('HTTP v2 authenticates before disabled admission and rejects public phase imports',async()=>{
    const app=express();app.use(qboRoutes({db} as AppContext));const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
    try{const url=`http://127.0.0.1:${(server.address() as any).port}/qbo/v2/invoke`;const token=mintAgentToken(db,'fixture@example.test',caller.conversationId),headers={'content-type':'application/json','X-VP-Agent-Token':token};
      expect((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).status).toBe(403);
      expect((await fetch(url,{method:'POST',headers,body:JSON.stringify(input)})).status).toBe(503);
      expect((await fetch(url.replace('invoke','reconcile'),{method:'POST',headers,body:JSON.stringify({requestKey:r.requestKey,phase:{refresh:'confirmed'}})})).status).toBe(400);
    }finally{await new Promise<void>(r=>server.close(()=>r()));}expect(prepareCount).toBe(0);
  });
  it('unknown v1 receipt/history cannot synthesize v2 phases',()=>{expect(service.read(()=>caller,{requestKey:id()})).toMatchObject({status:'ABSENT',phases:[],observation:null});});
  it('runs only frozen helper bytes on private pipes with no native token or inherited env',async()=>{
    const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'qbo-fixture-')));
    try{const executable=path.join(dir,'fake-runtime'),file=path.join(dir,'fake.mjs');
      const c=path.join(dir,'fixture.c');
      await fs.writeFile(c,'#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(){char line[4096]; if(getenv("VP_AGENT_TOKEN")||getenv("NODE_OPTIONS"))return 9; if(!fgets(line,sizeof(line),stdin)||!strstr(line,"exact"))return 8; puts("{\\\"seen\\\":\\\"exact\\\"}");fflush(stdout);return fgets(line,sizeof(line),stdin)?0:7;}');
      execFileSync('/usr/bin/clang',[c,'-o',executable],{stdio:'pipe'});await fs.chmod(executable,0o500);
      const code='// Synthetic runtime fixture, no provider functionality.';
      await fs.writeFile(file,code,{mode:0o600});const descriptor={...f.helper,uid:process.getuid!(),executable:{path:executable,sha256:sha(await fs.readFile(executable))},script:{path:file,sha256:sha(code)}};
      const run=await ownedHelperTransport().prepare(descriptor);let calls=0;await run({marker:'exact'},raw=>{expect(raw).toEqual({seen:'exact'});calls++;return {ack:true};});expect(calls).toBe(1);
      await fs.writeFile(file,'tampered');await expect(run({marker:'exact'},()=>{})).rejects.toThrow('UNAVAILABLE');
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  });
});
