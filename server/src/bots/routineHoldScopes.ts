import { routineScopeHandoffs } from './routineScopeHandoffs.js';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError, createBotService, type Actor } from './service.js';
import { canonicalSha256 } from './canonical.js';

const key = z.string().min(1).max(200), hash = z.string().regex(/^[a-f0-9]{64}$/);
export type ScopeTrust = { trust_id: string; business_id: string; account_id: string; source_origin: string; principal_id: string; executor_id: string; adapter_digest: string; owner_id: number };
export const scopeEvidenceSchema = z.object({
  schema_version:z.literal('routine-hold-identities/v1'),
  trust_id:key, business_id:key, request_key:key,
  decision:z.object({id:key,version:z.number().int().positive(),proposal_hash:hash,event_revision:z.number().int().nonnegative()}).strict().nullable(),
  target_case:key.nullable(),
  account_id:key, source_origin:z.string().url(), principal_id:key, executor_id:key, adapter_digest:hash,
  captured_at:z.string().datetime(), source_revision:key,
  completeness:z.literal('complete-customer-sister-alias-order-closure/v1'),
  next_cursor:z.null(), truncation:z.literal('none'), case_count:z.number().int().min(1).max(100),
  cases:z.array(z.object({canonical_case:z.string().uuid(),ticket:key,customer_id:z.string().uuid(),
    customer_alias_ids:z.array(z.string().uuid()).max(100),
    orders:z.array(z.object({order_id:z.string().uuid(),binding_id:key,binding_version:key,binding_explicit:z.literal(true),audit_id:key.nullable()}).strict()).max(100),
    source_reference:z.string().min(1).max(1000)
  }).strict()).min(1).max(100),
  identity_manifest_hash:hash, closure_hash:hash,
}).strict();
export const coverageEvidenceSchema=z.object({target_evidence_id:key,scope_evidence_ids:z.array(key).max(2000)}).strict();
export type CoverageEvidence=z.infer<typeof coverageEvidenceSchema>;
type Evidence = z.infer<typeof scopeEvidenceSchema>;
type Row = { id: string; trust_id: string; decision_id: string | null; decision_version: number; proposal_hash: string; event_revision: number; scope_hash: string; snapshot_json: string; captured_ms: number };
type Binding = { id: string; trust_id: string; decision_id: string | null; decision_version: number; proposal_hash: string; event_revision: number; scope_hash: string; owner_id: number; request_hash: string; evidence_id: string };
export type CoverageDecision = { id: string; version: number; state: string; proposal_json: string; business_id: string | null; event_revision:number };
// Source proves identities; only a genuine current owner establishes the entire
// decision's supplemental scope. Neither fact is a new business approval.
export function routineHoldScopes(db: Database.Database, now: () => number) {
  const handoffs=routineScopeHandoffs(db);
  const fail = (s: string): never => { throw new BotError(409, s); };
  function decision(t: ScopeTrust, id: string, version: number, proposalHash: string) {
    const d = db.prepare('SELECT d.*,c.business_team_id business_id FROM bot_decisions d JOIN conversations c ON c.id=d.conversation_id WHERE d.id=?').get(id) as CoverageDecision | undefined;
    if (!d || d.business_id !== t.business_id) throw new BotError(403, 'Decision must belong to the exact current business');
    if (d.version !== version || canonicalSha256(JSON.parse(d.proposal_json)) !== proposalHash) fail('Decision version or proposal hash changed');
    return d;
  }
  function human(a: Actor, t: ScopeTrust) {
    if (a.conversationId || a.user.id !== t.owner_id || !db.prepare("SELECT 1 FROM business_teams b JOIN users u ON u.id=b.owner_id WHERE b.id=? AND b.owner_id=? AND u.status='active'").get(t.business_id,a.user.id)) throw new BotError(403,'Current authenticated human business owner required');
  }
  function fresh(e: Row) { return e.captured_ms <= now()+5000 && e.captured_ms >= now()-15000; }
  function scope(x: Evidence,handoffId:string|null) {
    return canonicalSha256({...(handoffId?{handoff_id:handoffId}:{}),account_id:x.account_id,source_origin:x.source_origin,principal_id:x.principal_id,executor_id:x.executor_id,cases:x.cases,closure_hash:x.closure_hash});
  }
  function overlap(a:Evidence,b:Evidence) {
    const identities=(x:Evidence)=>new Set(x.cases.flatMap(c=>['case:'+c.canonical_case,...[c.customer_id,...c.customer_alias_ids].map(id=>'customer:'+id),...c.orders.map(o=>'order:'+o.order_id)]));
    const left=identities(a);return [...identities(b)].some(id=>left.has(id));
  }
  function eventRevision(id:string) {return (db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM bot_decision_events WHERE decision_id=?').get(id) as {n:number}).n;}
  function latest(trust: string, id: string) { return db.prepare('SELECT * FROM routine_scope_evidence WHERE trust_id=? AND decision_id=? ORDER BY rowid DESC LIMIT 1').get(trust,id) as Row | undefined; }
  function currentBinding(trust: string, id: string) { return db.prepare('SELECT * FROM routine_hold_bindings WHERE trust_id=? AND decision_id=? ORDER BY rowid DESC LIMIT 1').get(trust,id) as Binding | undefined; }
  return {
    auditRevision(t:ScopeTrust) {
      return {
        handoffs:handoffs.revision(t),
        evidence:(db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM routine_scope_evidence WHERE trust_id=?').get(t.trust_id) as {n:number}).n,
        bindings:(db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM routine_hold_bindings WHERE trust_id=?').get(t.trust_id) as {n:number}).n,
        revocations:(db.prepare('SELECT COALESCE(MAX(r.rowid),0) n FROM routine_hold_revocations r JOIN routine_hold_bindings b ON b.id=r.binding_id WHERE b.trust_id=?').get(t.trust_id) as {n:number}).n,
      };
    },
    validateTarget(t:ScopeTrust,evidence:CoverageEvidence,material:{case_id:string;ticket:string;customer_id:string;context:{snapshot_revision:string;conversation_ids:string[]}}) {
      const e=db.prepare('SELECT * FROM routine_scope_evidence WHERE id=? AND trust_id=?').get(evidence.target_evidence_id,t.trust_id) as Row|undefined;
      if(!e || !fresh(e))fail('Fresh target identity evidence required');
      const x=JSON.parse(e!.snapshot_json) as Evidence,root=x.cases.find(c=>c.canonical_case===material.case_id);
      if(x.target_case!==material.case_id || !root || root.ticket!==material.ticket || root.customer_id!==material.customer_id || x.source_revision!==material.context.snapshot_revision || canonicalSha256(x.cases.map(c=>c.canonical_case).sort())!==canonicalSha256([...material.context.conversation_ids].sort()))fail('Target closure must match exact captured identity/context revision');
    },
    inventory(a:Actor,t:ScopeTrust) {
      human(a,t);
      const rows=db.prepare(`SELECT d.id,d.version,d.state,d.proposal_json FROM bot_decisions d JOIN conversations c ON c.id=d.conversation_id
        WHERE c.business_team_id=? OR d.id IN (SELECT decision_id FROM routine_hold_bindings WHERE business_id=?) ORDER BY d.id`).all(t.business_id,t.business_id) as {id:string;version:number;state:string;proposal_json:string}[];
      const visible=[];let unavailable=0;
      for(const d of rows){try{createBotService(db).read(a,d.id);}catch{unavailable++;continue;}
        visible.push({decision_id:d.id,decision_version:d.version,state:d.state,proposal_hash:canonicalSha256(JSON.parse(d.proposal_json)),event_revision:eventRevision(d.id),binding:currentBinding(t.trust_id,d.id)??null});}
      return {business_id:t.business_id,records:visible,unavailable_count:unavailable,total_count:rows.length,execute:false};
    },
    evidence(t: ScopeTrust, raw: unknown) {
      const x=scopeEvidenceSchema.parse(raw);
      if(x.business_id!==t.business_id || x.trust_id!==t.trust_id || x.account_id!==t.account_id || x.source_origin!==t.source_origin || x.principal_id!==t.principal_id || x.executor_id!==t.executor_id || x.adapter_digest!==t.adapter_digest) fail('Scope evidence source binding mismatch');
      if((x.decision===null)===(x.target_case===null))fail('Exactly one decision or target identity projection required');
      if(x.decision){decision(t,x.decision.id,x.decision.version,x.decision.proposal_hash);if(eventRevision(x.decision.id)!==x.decision.event_revision)fail('Native event revision changed');}
      if(x.target_case && !x.cases.some(c=>c.canonical_case===x.target_case))fail('Target missing from closure');
      const sorted=[...x.cases].sort((a,b)=>a.canonical_case.localeCompare(b.canonical_case));
      if(canonicalSha256(sorted)!==canonicalSha256(x.cases) || x.case_count!==x.cases.length || x.identity_manifest_hash!==canonicalSha256(x.cases) || x.closure_hash!==canonicalSha256({completeness:x.completeness,cases:x.cases}))fail('Complete sorted identity manifest/hash required');
      for(const c of x.cases){if(new Set(c.customer_alias_ids).size!==c.customer_alias_ids.length || canonicalSha256([...c.customer_alias_ids].sort())!==canonicalSha256(c.customer_alias_ids) || new Set(c.orders.map(o=>o.order_id)).size!==c.orders.length || canonicalSha256([...c.orders].sort((a,b)=>a.order_id.localeCompare(b.order_id)))!==canonicalSha256(c.orders))fail('Sorted unique aliases/orders required');}
      const captured_ms=Date.parse(x.captured_at);
      if(!fresh({captured_ms} as Row) || new Set(x.cases.map(c=>c.canonical_case)).size!==x.cases.length) fail('Fresh complete unique case identity evidence required');
      const handoffId=handoffs.evidence(t,x);
      const requestHash=canonicalSha256(x), old=db.prepare('SELECT id,request_hash FROM routine_scope_evidence WHERE trust_id=? AND request_key=?').get(t.trust_id,x.request_key) as {id:string;request_hash:string}|undefined;
      if(old){if(old.request_hash!==requestHash)fail('Scope evidence request conflict');return {evidence_id:old.id,execute:false};}
      const id=crypto.randomUUID();
      db.prepare('INSERT INTO routine_scope_evidence(id,trust_id,decision_id,target_case,decision_version,proposal_hash,event_revision,scope_hash,snapshot_json,captured_ms,request_key,request_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,t.trust_id,x.decision?.id??null,x.target_case,x.decision?.version??0,x.decision?.proposal_hash??'',x.decision?.event_revision??0,scope(x,handoffId),JSON.stringify(x),captured_ms,x.request_key,requestHash);
      handoffs.link(id,handoffId);
      return {evidence_id:id,execute:false};
    },
    review(a:Actor,t:ScopeTrust,decisionId:string) {
      human(a,t); createBotService(db).read(a,decisionId);
      const d=db.prepare('SELECT version,proposal_json FROM bot_decisions WHERE id=?').get(decisionId) as {version:number;proposal_json:string};
      decision(t,decisionId,d.version,canonicalSha256(JSON.parse(d.proposal_json)));
      const e=latest(t.trust_id,decisionId), b=currentBinding(t.trust_id,decisionId);
      return {proposal:JSON.parse(d.proposal_json),decision_id:decisionId,decision_version:d.version,proposal_hash:canonicalSha256(JSON.parse(d.proposal_json)),event_revision:eventRevision(decisionId),evidence:e?{id:e.id,snapshot:JSON.parse(e.snapshot_json),fresh:fresh(e),handoff_current:handoffs.covers(t,decisionId,e.id)}:null,binding:b??null,binding_revoked:!!b && !!db.prepare('SELECT 1 FROM routine_hold_revocations WHERE binding_id=?').get(b.id),handoff:handoffs.ownerView(a,t,decisionId),execute:false,
        required_action:'Review the original decision and complete source case set. Record a current supplemental scope only if every affected case is established. Unknown/global scope must remain unbound. This is not business approval.'};
    },
    bind(a:Actor,t:ScopeTrust,raw:unknown) {
      human(a,t);
      const x=z.object({trust_id:key,evidence_id:key.nullable(),request_key:key,expected_binding_id:key.nullable(),decision_id:key,decision_version:z.number().int().positive(),proposal_hash:hash,event_revision:z.number().int().nonnegative(),scope_kind:z.enum(['case_set','business_wide','unknown']),
        review_reference:z.string().min(1).max(2000),confirmation:z.literal('complete-current-scope-not-business-approval')}).strict().parse(raw);
      if(x.trust_id!==t.trust_id)fail('Trust mismatch');
      createBotService(db).read(a,x.decision_id); decision(t,x.decision_id,x.decision_version,x.proposal_hash);
      if(eventRevision(x.decision_id)!==x.event_revision)fail('Native event revision changed');
      const h=canonicalSha256(x), old=db.prepare('SELECT * FROM routine_hold_bindings WHERE trust_id=? AND request_key=?').get(t.trust_id,x.request_key) as Binding|undefined;
      if(old){if(old.request_hash!==h)fail('Scope binding request conflict');return {binding_id:old.id,execute:false};}
      const prior=currentBinding(t.trust_id,x.decision_id);
      if((prior?.id??null)!==x.expected_binding_id)fail('Scope binding changed; refresh review');
      const e=latest(t.trust_id,x.decision_id);
      if(x.scope_kind==='case_set' && (!e || e.id!==x.evidence_id || e.decision_version!==x.decision_version || e.proposal_hash!==x.proposal_hash || e.event_revision!==x.event_revision))fail('Latest exact source evidence required; refresh review after drift');
      if(x.scope_kind==='case_set' && !handoffs.covers(t,x.decision_id,e!.id))fail('Evidence must match the current unrevoked owner handoff');
      const id=crypto.randomUUID();
      db.prepare('INSERT INTO routine_hold_bindings(id,trust_id,business_id,decision_id,decision_version,proposal_hash,event_revision,scope_kind,scope_hash,evidence_id,owner_id,request_key,request_hash,review_reference) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,t.trust_id,t.business_id,x.decision_id,x.decision_version,x.proposal_hash,x.event_revision,x.scope_kind,x.scope_kind==='case_set'?e!.scope_hash:'',x.scope_kind==='case_set'?e!.id:null,a.user.id,x.request_key,h,x.review_reference);
      return {binding_id:id,execute:false};
    },
    revoke(a:Actor,t:ScopeTrust,raw:unknown) {
      human(a,t);const x=z.object({trust_id:key,binding_id:key,reason:z.string().min(1).max(2000)}).strict().parse(raw);
      const b=db.prepare('SELECT * FROM routine_hold_bindings WHERE id=? AND trust_id=?').get(x.binding_id,t.trust_id) as Binding|undefined;
      if(!b || x.trust_id!==t.trust_id)throw new BotError(404,'Scope binding not found');
      const old=db.prepare('SELECT reason FROM routine_hold_revocations WHERE binding_id=?').get(b.id) as {reason:string}|undefined;
      if(old && old.reason!==x.reason)fail('Scope revocation conflict');
      db.prepare('INSERT OR IGNORE INTO routine_hold_revocations(binding_id,actor_id,reason) VALUES(?,?,?)').run(b.id,a.user.id,x.reason);
      return {revoked:true,execute:false};
    },
    coverage(t:ScopeTrust,caseId:string,rows:CoverageDecision[],submitted?:CoverageEvidence) {
      const target=submitted?db.prepare('SELECT * FROM routine_scope_evidence WHERE id=? AND trust_id=?').get(submitted.target_evidence_id,t.trust_id) as Row|undefined:undefined;
      const targetData=target?JSON.parse(target.snapshot_json) as Evidence:null;
      const newestTarget=db.prepare('SELECT id FROM routine_scope_evidence WHERE trust_id=? AND target_case=? ORDER BY rowid DESC LIMIT 1').get(t.trust_id,caseId) as {id:string}|undefined;
      const targetValid=!!target && fresh(target) && newestTarget?.id===target.id && target.decision_id===null && targetData?.target_case===caseId;
      const ids=submitted?.scope_evidence_ids??[];
      if(new Set(ids).size!==ids.length)fail('Duplicate coverage evidence');
      const observations=ids.map(id=>{const e=db.prepare('SELECT * FROM routine_scope_evidence WHERE id=? AND trust_id=?').get(id,t.trust_id) as Row|undefined;if(!e || !e.decision_id || !rows.some(d=>d.id===e.decision_id))fail('Foreign or unknown coverage evidence');return e!;});
      if(new Set(observations.map(e=>e.decision_id)).size!==observations.length)fail('Duplicate decision coverage');
      const classifications=rows.map(d=>{
        const b=currentBinding(t.trust_id,d.id) as (Binding & {scope_kind:string})|undefined,e=observations.find(e=>e.decision_id===d.id);
        const revoked=b?!!db.prepare('SELECT 1 FROM routine_hold_revocations WHERE binding_id=?').get(b.id):false;
        let status='unbound';
        if(d.state==='verified_completed')status='completed';
        else if(b){
          if(revoked)status='revoked';
          else if(b.scope_kind!=='case_set')status=b.scope_kind;
          else if(b.owner_id!==t.owner_id || d.business_id!==t.business_id || b.decision_version!==d.version || b.event_revision!==d.event_revision || b.proposal_hash!==canonicalSha256(JSON.parse(d.proposal_json)))status='decision_changed';
          else if(!handoffs.covers(t,d.id,b.evidence_id) || (e && !handoffs.covers(t,d.id,e.id)))status='handoff_changed';
          else if(!e || !fresh(e) || !targetValid)status='source_stale';
          else if(latest(t.trust_id,d.id)?.id!==e.id || e.scope_hash!==b.scope_hash || e.decision_version!==b.decision_version || e.event_revision!==b.event_revision || e.proposal_hash!==b.proposal_hash)status='source_changed';
          else status=overlap(JSON.parse(e.snapshot_json),targetData!)?'same_case_or_closure':'verified_other_case';
        }
        return {decision_id:d.id,status,blocking:status!=='completed' && status!=='verified_other_case',binding_id:b?.id??null,evidence_id:e?.id??null,evidence_hash:e?canonicalSha256(JSON.parse(e.snapshot_json)):null};
      });
      return {classifications,target_valid:targetValid,target_evidence_id:target?.id??null,target_evidence_hash:targetData?canonicalSha256(targetData):null};
    },
  };
}
