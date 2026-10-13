import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { BotError } from '../bots/service.js';
import { canonicalSha256 } from '../bots/canonical.js';
import { H, lookupSchema, reservationSchema, type Caller } from './contract.js';
import { authorityScopeV2, providerRequestHash, eventSchema, factsV2Schema, helperHash, invokeSchema, observationSchema, phaseSchema, type FactsV2, type RequestV2, type Phase, type HelperDescriptor } from './phaseContract.js';
const no={execute:false as const,refreshEntitlement:false as const,operationEntitlement:false as const,retryAllowed:false as const};
function deny(s:string):never{throw new BotError(409,'QBO_'+s);}
export interface PhaseResolver {
  current(c:Caller,r:RequestV2):unknown;
  // Must verify current same-grant custody, helper acceptance and original caller.
  // This grants historical evidence read only, never accounting execution.
  reconciliation?(c:Caller,saved:FactsV2):HelperDescriptor;
}
export interface HelperTransport {
  // Pin/verify files before reservation. Server-installed only, never supplied by caller.
  prepare(descriptor:HelperDescriptor):Promise<(input:unknown,event:(value:unknown)=>unknown)=>Promise<void>>;
}
export const unavailablePhaseResolver:PhaseResolver={current(){throw new BotError(503,'QBO_ASSIGNMENT_AND_ACCOUNTING_BINDING_UNAVAILABLE');}};
type Row={id:string;reservation_json:string;facts_json:string;request_json:string};
export const grantDigest=(f:{businessId:string;existingGrantRef:string;companyRealm:string})=>H('qbo/grant-fence/v1',{existingGrantRef:f.existingGrantRef});
export function assertGrantClear(db:Database.Database,f:Parameters<typeof grantDigest>[0],requirePhaseProof=false){
  if(requirePhaseProof){
    const legacy=db.prepare('SELECT reservation_json FROM qbo_operation_reservations WHERE id NOT IN (SELECT id FROM qbo_v2_invocations)').all() as {reservation_json:string}[];
    for(const row of legacy)if(grantDigest(reservationSchema.parse(JSON.parse(row.reservation_json)))===grantDigest(f))deny('LEGACY_PHASE_PROOF_REQUIRED');
  }
  const rows=db.prepare(`SELECT p.phase_json FROM qbo_v2_invocations i JOIN qbo_v2_phases p ON p.invocation_id=i.id
    WHERE i.grant_digest=? AND p.sequence=(SELECT MAX(sequence) FROM qbo_v2_phases WHERE invocation_id=i.id)`).all(grantDigest(f)) as {phase_json:string}[];
  for(const row of rows){const p=phaseSchema.parse(JSON.parse(row.phase_json));if(!p.closed || p.persistence==='uncertain')deny('SHARED_GRANT_RECONCILIATION_REQUIRED');}
}
export function phaseBoundary(db:Database.Database,resolver:PhaseResolver=unavailablePhaseResolver,transport?:HelperTransport,now=Date.now){
  const clockFaults=new Set<string>();
  const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
  function phaseTime(previous?:Phase){
    const at=now();
    if(!Number.isFinite(at)||!Number.isFinite(new Date(at).getTime())||(previous&&at<Date.parse(previous.recordedAt)))deny('CLOCK_REGRESSED');
    return at;
  }
  function current(auth:()=>Caller,r:RequestV2,at=now()){
    const c=auth(), f=factsV2Schema.parse(resolver.current(c,r));
    if(Date.parse(c.sessionExpiresAt)<=at)deny('NATIVE_SESSION_EXPIRED');
    if(f.bindingRef!==r.bindingRef || f.ownerUserId!==c.userId || f.executorConversationId!==c.conversationId)deny('FOREIGN_BINDING');
    if(f.assignmentState!=='assigned'||f.authorityState!=='current')deny('ASSIGNMENT_OR_AUTHORITY_REVOKED');
    if(f.assignmentRevision!==r.assignmentRevision || f.authorityRevision!==r.authorityRevision)deny('REVISION_CHANGED');
    if(Math.min(Date.parse(f.expiresAt),Date.parse(f.integration.expiresAt))<=at)deny('SCOPE_EXPIRED');
    if(!same(f.operation,r.operation)||f.authorityScopeHash!==authorityScopeV2(f)||f.integration.helperImplementationHash!==helperHash(f.helper)||f.integration.acceptanceReceiptHash!==f.helper.acceptanceHash)deny('OPERATION_OR_HELPER_SCOPE_MISMATCH');
    if(!db.prepare(`SELECT 1 FROM conversations c JOIN users u ON u.id=c.user_id JOIN bot_registrations b ON b.conversation_id=c.id JOIN business_bot_members m ON m.conversation_id=c.id AND m.team_id=c.business_team_id JOIN business_teams t ON t.id=c.business_team_id WHERE c.id=? AND c.user_id=? AND c.business_team_id=? AND c.archived=0 AND b.active=1 AND u.status='active' AND t.owner_id=u.id`).get(c.conversationId,c.userId,f.businessId))deny('EXECUTOR_ACCESS_REVOKED');
    if(r.operation.observationHash){
      const row=db.prepare('SELECT observation_json FROM qbo_bill_observations WHERE hash=?').get(r.operation.observationHash) as {observation_json:string}|undefined;
      if(!row)deny('BILL_OBSERVATION_REQUIRED');
      const o=observationSchema.parse(JSON.parse(row.observation_json));
      if(o.businessId!==f.businessId||o.existingGrantRef!==f.existingGrantRef||o.companyRealm!==f.companyRealm||o.executorConversationId!==c.conversationId||o.billId!==r.operation.target.id||o.sourceRevision!==f.sourceRevision||Date.parse(o.expiresAt)<=at||Date.parse(o.observedAt)>at||(r.operation.kind==='update-bill'&&o.syncToken!==r.operation.target.syncToken))deny('BILL_OBSERVATION_STALE_OR_FOREIGN');
    }
    return {c,f};
  }
  function history(id:string){return (db.prepare('SELECT phase_json FROM qbo_v2_phases WHERE invocation_id=? ORDER BY sequence').all(id) as {phase_json:string}[]).map(v=>phaseSchema.parse(JSON.parse(v.phase_json)));}
  function append(p:Phase){const value=phaseSchema.parse(p);db.prepare('INSERT INTO qbo_v2_phases VALUES(?,?,?,?,?,?)').run(value.receiptId,value.invocationId,value.sequence,value.eventHash,H('qbo/phase/v2',value),JSON.stringify(value));return value;}
  function read(auth:()=>Caller,raw:unknown){
    const key=lookupSchema.parse(raw),c=auth();
    const row=db.prepare('SELECT id FROM qbo_operation_reservations WHERE executor_id=? AND actor_user_id=? AND request_key=?').get(c.conversationId,c.userId,key.requestKey) as {id:string}|undefined;
    const phases=row?history(row.id):[];
    const o=row?db.prepare('SELECT observation_json FROM qbo_bill_observations WHERE invocation_id=?').get(row.id) as {observation_json:string}|undefined:undefined;
    return {...no,status:row?'RESERVED' as const:'ABSENT' as const,phaseProof:row?(phases.length?'V2' as const:'V1_ONLY' as const):'ABSENT' as const,phases,observation:o?observationSchema.parse(JSON.parse(o.observation_json)):null};
  }
  function record(row:Row,auth:()=>Caller,raw:unknown,reconciling=false){
    const e=eventSchema.parse(raw),r=JSON.parse(row.request_json) as RequestV2, saved=factsV2Schema.parse(JSON.parse(row.facts_json)),reservation=reservationSchema.parse(JSON.parse(row.reservation_json));
    if(e.invocationId!==row.id)deny('PHASE_CORRELATION');
    return db.transaction(()=>{
      if(reconciling){const c=auth();if(c.conversationId!==saved.executorConversationId||c.userId!==saved.ownerUserId||!resolver.reconciliation||!same(resolver.reconciliation(c,saved),saved.helper))deny('RECONCILIATION_CUSTODY');}
      const eventHash=H('qbo/helper-event/v2',e),old=db.prepare('SELECT event_hash,phase_json FROM qbo_v2_phases WHERE receipt_id=?').get(e.receiptId) as {event_hash:string;phase_json:string}|undefined;
      // Private owned process provenance remains required even for historical replay.
      if(old){if(old.event_hash!==eventHash)deny('RECEIPT_CONFLICT');return {...no,phase:phaseSchema.parse(JSON.parse(old.phase_json))};}
      const all=history(row.id),last=all.at(-1)!;
      if(all.length>=99||(last.closed&&!reconciling)||e.sequence!==last.sequence+1||e.previousHash!==H('qbo/phase/v2',last))deny('PHASE_SEQUENCE_OR_CLOSED');
      if(reconciling&&['refresh-start','dispatch-start','stop','persistence-uncertain','dispatch-unknown'].includes(e.action))deny('RECONCILIATION_ONLY');
      if(clockFaults.has(row.id)&&!reconciling)deny('CLOCK_REGRESSED');
      let at:number;try{at=phaseTime(last);}catch(error){clockFaults.add(row.id);throw error;}
      const p:Phase={...last,receiptId:e.receiptId,sequence:e.sequence,previousHash:e.previousHash,eventHash,recordedAt:new Date(at).toISOString(),evidenceHash:e.evidenceHash};
      if(e.billResult && e.action!=='dispatch-accepted')deny('UNEXPECTED_BILL_RESULT');
      if(e.action==='refresh-start'||e.action==='dispatch-start'){
        const fresh=current(auth,r,at);if(!same(fresh.f,saved)||Date.parse(reservation.expiresAt)<=at)deny('INVOCATION_DRIFT_OR_EXPIRED');
      }
      switch(e.action){
        case 'refresh-start': if(last.refresh!=='not-started')deny('REFRESH_ALREADY_STARTED');p.refresh='started';p.persistence='uncertain';p.persistenceReason='rotation-may-have-occurred';break;
        case 'refresh-confirmed': if(last.refresh!=='started'&&!(reconciling&&last.refresh==='UNKNOWN'))deny('REFRESH_PHASE');p.refresh='confirmed';break;
        case 'persistence-confirmed': if(last.refresh!=='confirmed'||last.persistence!=='uncertain')deny('PERSISTENCE_PHASE');p.persistence='confirmed';p.persistenceReason='durable-rotation-confirmed';break;
        case 'persistence-uncertain': if(last.refresh==='not-started'||last.persistence==='confirmed')deny('PERSISTENCE_PHASE');p.closed=true;p.refresh=last.refresh==='started'?'UNKNOWN':last.refresh;break;
        case 'dispatch-start': if(last.refresh!=='confirmed'||last.persistence!=='confirmed'||last.dispatch!=='not-started'||e.providerRequestHash!==providerRequestHash(r,saved))deny('DISPATCH_PREREQUISITES');p.dispatch='started';p.providerRequestHash=e.providerRequestHash;break;
        case 'dispatch-accepted': case 'dispatch-unknown':
          if((last.dispatch!=='started'&&!(reconciling&&last.dispatch==='UNKNOWN'))||!e.providerRequestHash||e.providerRequestHash!==last.providerRequestHash)deny('PROVIDER_CORRELATION');
          p.dispatch=e.action==='dispatch-accepted'?'accepted':'UNKNOWN';p.closed=true;
          if(e.action==='dispatch-accepted'&&r.operation.kind==='read-bill'){
            // Only the immutable transition for this invocation/request proves dispatch began.
            const starts=all.filter((phase,i)=>phase.dispatch==='started'&&all[i-1]?.dispatch==='not-started'
              &&phase.invocationId===row.id&&phase.reservationId===row.id&&phase.providerRequestHash===e.providerRequestHash);
            if(starts.length!==1)deny('BILL_DISPATCH_PROOF_REQUIRED');
            const b=e.billResult;if(!b||b.billId!==r.operation.target.id||b.companyRealm!==saved.companyRealm||b.sourceRevision!==saved.sourceRevision||Date.parse(b.capturedAt)>at||Date.parse(b.capturedAt)<Date.parse(starts[0]!.recordedAt))deny('BILL_RESULT_MISMATCH');
            const o=observationSchema.parse({schemaVersion:'qbo-bill-observation/v1',reservationId:row.id,businessId:saved.businessId,existingGrantRef:saved.existingGrantRef,companyRealm:b.companyRealm,executorConversationId:saved.executorConversationId,billId:b.billId,syncToken:b.syncToken,sourceRevision:b.sourceRevision,resultDigest:b.resultDigest,observedAt:b.capturedAt,expiresAt:new Date(Math.min(Date.parse(b.capturedAt)+15000,Date.parse(reservation.expiresAt))).toISOString()});
            p.observationHash=H('qbo/bill-observation/v1',o);db.prepare('INSERT INTO qbo_bill_observations VALUES(?,?,?)').run(p.observationHash,row.id,JSON.stringify(o));
          }else if(e.billResult)deny('UNEXPECTED_BILL_RESULT');break;
        case 'stop': p.closed=true;if(last.refresh==='started')p.refresh='UNKNOWN';if(last.dispatch==='started')p.dispatch='UNKNOWN';break;
      }
      if(e.action!=='dispatch-start'&&e.action!=='dispatch-accepted'&&e.action!=='dispatch-unknown'&&e.providerRequestHash!==null)deny('UNEXPECTED_PROVIDER_HASH');
      append(p);return {...no,refreshEntitlement:e.action==='refresh-start',operationEntitlement:e.action==='dispatch-start',phase:p};
    }).immediate();
  }
  return {read,async reconcile(auth:()=>Caller,raw:unknown){
    const key=lookupSchema.parse(raw),c=auth();
    const row=db.prepare('SELECT r.id,r.reservation_json,i.facts_json,i.request_json FROM qbo_operation_reservations r JOIN qbo_v2_invocations i ON i.id=r.id WHERE r.executor_id=? AND r.actor_user_id=? AND r.request_key=?').get(c.conversationId,c.userId,key.requestKey) as Row|undefined;
    if(!row)deny('V2_RESERVATION_REQUIRED');
    const saved=factsV2Schema.parse(JSON.parse(row.facts_json));
    if(!resolver.reconciliation||!transport)throw new BotError(503,'QBO_RECONCILIATION_TRANSPORT_UNAVAILABLE');
    const descriptor=resolver.reconciliation(c,saved);if(!same(descriptor,saved.helper))deny('RECONCILIATION_CUSTODY');
    const run=await transport.prepare(descriptor);
    await run({schemaVersion:'qbo-readback/v2',reservation:JSON.parse(row.reservation_json),phases:history(row.id)},v=>record(row,auth,v,true));
    return read(auth,key);
  },async invoke(auth:()=>Caller,raw:unknown){
    const input=invokeSchema.parse(raw),r=input.request,initial=current(auth,r);
    const decode=(s:string)=>{const b=Buffer.from(s,'base64');if(b.toString('base64')!==s)deny('NONCANONICAL_BYTES');return b;};
    const payload=decode(input.bytes.payloadBase64),attachments=input.bytes.attachmentsBase64.map(decode);
    if(crypto.createHash('sha256').update(payload).digest('hex')!==r.operation.payloadHash||attachments.length!==r.operation.attachments.length||attachments.some((b,i)=>b.length!==r.operation.attachments[i]!.bytes||crypto.createHash('sha256').update(b).digest('hex')!==r.operation.attachments[i]!.sha256))deny('INVOCATION_BYTES_MISMATCH');
    if(!transport)throw new BotError(503,'QBO_ACCEPTED_HELPER_TRANSPORT_UNAVAILABLE');
    const run=await transport.prepare(initial.f.helper);
    const row=db.transaction(()=>{
      const {c,f}=current(auth,r);if(!same(f,initial.f)||!same(c,initial.c))deny('INVOCATION_DRIFT');
      const existing=db.prepare('SELECT id,request_hash FROM qbo_operation_reservations WHERE executor_id=? AND request_key=?').get(c.conversationId,r.requestKey) as {id:string;request_hash:string}|undefined;
      if(existing){if(existing.request_hash!==H('qbo/request/v2',r))deny('REQUEST_CONFLICT');return null;}
      assertGrantClear(db,f,true);
      const effect=H('qbo/logical-effect/v1',{businessId:f.businessId,companyRealm:f.companyRealm,existingGrantRef:f.existingGrantRef,logicalEffectId:f.logicalEffectId});
      if(db.prepare('SELECT 1 FROM qbo_operation_reservations WHERE effect_digest=?').get(effect))deny('OPERATION_PERMANENTLY_RESERVED');
      const id=crypto.randomUUID(),at=phaseTime(),scope=H('qbo/operation/v2',r.operation),fh=canonicalSha256(f);
      const reservation=reservationSchema.parse({schemaVersion:'qbo-admission/v1',reservationId:id,requestKey:r.requestKey,authenticatedCaller:c,originalExecutor:c.conversationId,jobId:f.jobId,assignmentRevision:f.assignmentRevision,authorityRef:f.authorityRef,authorityRevision:f.authorityRevision,businessId:f.businessId,accountRef:f.accountRef,existingGrantRef:f.existingGrantRef,companyRealm:f.companyRealm,effectDigest:effect,scopeHash:scope,factsHash:fh,audience:r.audience,reservedAt:new Date(at).toISOString(),expiresAt:new Date(Math.min(at+15000,Date.parse(c.sessionExpiresAt),Date.parse(f.expiresAt),Date.parse(f.integration.expiresAt))).toISOString()});
      db.prepare('INSERT INTO qbo_operation_reservations VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,effect,c.userId,c.conversationId,r.requestKey,H('qbo/request/v2',r),f.jobId,scope,fh,JSON.stringify(reservation));
      db.prepare('INSERT INTO qbo_v2_invocations VALUES(?,?,?,?)').run(id,grantDigest(f),JSON.stringify(r),JSON.stringify(f));
      append({schemaVersion:'qbo-phase/v2',invocationId:id,reservationId:id,jobId:f.jobId,effectDigest:effect,scopeHash:scope,payloadHash:r.operation.payloadHash,receiptId:crypto.randomUUID(),sequence:0,previousHash:null,eventHash:H('qbo/initial-phase/v2',reservation),recordedAt:new Date(at).toISOString(),refresh:'not-started',persistence:'not-applicable',persistenceReason:'refresh-not-started',dispatch:'not-started',providerRequestHash:null,evidenceHash:helperHash(f.helper),closed:false,observationHash:null});
      return {id,reservation_json:JSON.stringify(reservation),facts_json:JSON.stringify(f),request_json:JSON.stringify(r)};
    }).immediate();
    if(!row)return read(auth,{requestKey:r.requestKey});
    try{await run({schemaVersion:'qbo-invocation/v2',reservation:JSON.parse(row.reservation_json),request:r,bytes:input.bytes,phase:history(row.id)[0]},v=>record(row,auth,v));}
    catch{/* Raw helper errors/output are never retained or returned. */}
    finally{db.transaction(()=>{const last=history(row.id).at(-1)!;if(last.closed||clockFaults.has(row.id))return;
      let at:number;
      try{at=phaseTime(last);}catch{
        // A failed clock cannot manufacture a receipt or replace the original transport failure.
        // Leave the durable open phase (and grant/effect fence) for receipt-only reconciliation.
        return;
      }
      append({...last,receiptId:crypto.randomUUID(),sequence:last.sequence+1,previousHash:H('qbo/phase/v2',last),eventHash:H('qbo/transport-ended/v2',{id:row.id,sequence:last.sequence+1}),recordedAt:new Date(at).toISOString(),closed:true,refresh:last.refresh==='started'?'UNKNOWN':last.refresh,dispatch:last.dispatch==='started'?'UNKNOWN':last.dispatch});}).immediate();}
    clockFaults.delete(row.id); // Persisted open phase fences future invocations; no command can resume.
    return read(auth,{requestKey:r.requestKey});
  }};
}
