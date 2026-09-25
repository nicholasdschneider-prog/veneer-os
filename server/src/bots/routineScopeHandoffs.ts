import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError, createBotService, type Actor } from './service.js';
import { canonicalSha256 } from './canonical.js';
import type { UserRow } from '../db/db.js';
import type { ScopeTrust } from './routineHoldScopes.js';

const key=z.string().min(1).max(200);
const tuple={decision_id:key,decision_version:z.number().int().positive(),proposal_hash:z.string().regex(/^[a-f0-9]{64}$/),event_revision:z.number().int().nonnegative()};
const root=z.object({canonical_case:z.string().uuid(),source_reference:z.string().url().max(2000)}).strict();
type Row={id:string;trust_id:string;decision_id:string;decision_version:number;proposal_hash:string;event_revision:number;owner_id:number;revision:number;previous_id:string|null;request_key:string;request_hash:string;source_request_key:string;roots_json:string;created_at:string};
export function routineScopeHandoffs(db:Database.Database) {
  const fail=(message:string):never=>{throw new BotError(409,message);};
  function human(a:Actor,t:ScopeTrust) {
    if(a.conversationId || a.user.id!==t.owner_id || !db.prepare("SELECT 1 FROM business_teams b JOIN users u ON u.id=b.owner_id WHERE b.id=? AND b.owner_id=? AND u.status='active'").get(t.business_id,a.user.id))throw new BotError(403,'Current authenticated human business owner required');
  }
  function latest(t:ScopeTrust,decisionId:string) {return db.prepare('SELECT * FROM routine_scope_handoffs WHERE trust_id=? AND decision_id=? ORDER BY revision DESC LIMIT 1').get(t.trust_id,decisionId) as Row|undefined;}
  function read(t:ScopeTrust,id:string) {const h=db.prepare('SELECT * FROM routine_scope_handoffs WHERE id=? AND trust_id=?').get(id,t.trust_id) as Row|undefined;if(!h)throw new BotError(404,'Scope handoff not found');return h;}
  function current(t:ScopeTrust,h:Row) {
    if(h.owner_id!==t.owner_id || latest(t,h.decision_id)?.id!==h.id || db.prepare('SELECT 1 FROM routine_scope_handoff_revocations WHERE handoff_id=?').get(h.id))fail('Scope handoff revoked, superseded or owner changed');
    const owner=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(t.owner_id) as UserRow|undefined;
    if(!owner)fail('Scope handoff owner is inactive');
    createBotService(db).read({user:owner!},h.decision_id);
    const d=db.prepare(`SELECT d.version,d.proposal_json,c.business_team_id,
      (SELECT COALESCE(MAX(rowid),0) FROM bot_decision_events e WHERE e.decision_id=d.id) event_revision
      FROM bot_decisions d JOIN conversations c ON c.id=d.conversation_id WHERE d.id=?`).get(h.decision_id) as {version:number;proposal_json:string;business_team_id:string;event_revision:number}|undefined;
    if(!d || d.business_team_id!==t.business_id || d.version!==h.decision_version || canonicalSha256(JSON.parse(d.proposal_json))!==h.proposal_hash || d.event_revision!==h.event_revision)fail('Scope handoff decision changed; owner must review a fresh handoff');
  }
  function view(t:ScopeTrust,h:Row,ownerView=false) {
    let status='current';try{current(t,h);}catch(e){if(!(e instanceof BotError))throw e;status='unavailable';}
    const roots=JSON.parse(h.roots_json) as z.infer<typeof root>[];
    return {handoff_id:h.id,revision:h.revision,previous_id:h.previous_id,status,created_at:h.created_at,
      trust_id:t.trust_id,account_id:t.account_id,source_origin:t.source_origin,principal_id:t.principal_id,executor_id:t.executor_id,adapter_digest:t.adapter_digest,
      source_request:{requestKey:h.source_request_key,roots:roots.map(r=>r.canonical_case),decision:{id:h.decision_id,version:h.decision_version,proposal_hash:h.proposal_hash,event_revision:h.event_revision}},
      ...(ownerView?{source_references:roots}:{}),execute:false as const};
  }
  return {
    latest,
    ownerView(a:Actor,t:ScopeTrust,decisionId:string) {human(a,t);createBotService(db).read(a,decisionId);const h=latest(t,decisionId);return h?view(t,h,true):null;},
    sourceRead(t:ScopeTrust,id:string) {const h=read(t,id);current(t,h);return view(t,h);},
    prepare(a:Actor,t:ScopeTrust,raw:unknown) {
      human(a,t);
      const x=z.object({trust_id:key,...tuple,expected_handoff_id:key.nullable(),request_key:z.string().uuid(),roots:z.array(root).min(1).max(100),confirmation:z.literal('source-locators-only-not-scope-classification')}).strict().parse(raw);
      if(x.trust_id!==t.trust_id)fail('Trust mismatch');
      createBotService(db).read(a,x.decision_id);
      if(new Set(x.roots.map(r=>r.canonical_case)).size!==x.roots.length)fail('Duplicate source roots');
      for(const r of x.roots){const u=new URL(r.source_reference);if(u.origin!==t.source_origin || u.username || u.password || u.search || u.hash || !u.pathname.split('/').includes(r.canonical_case))fail('Each source reference must be a canonical record URL on the registered source origin');}
      const requestHash=canonicalSha256(x);
      const old=db.prepare('SELECT * FROM routine_scope_handoffs WHERE trust_id=? AND request_key=?').get(t.trust_id,x.request_key) as Row|undefined;
      if(old){if(old.request_hash!==requestHash)fail('Scope handoff request conflict');current(t,old);return view(t,old,true);}
      const prior=latest(t,x.decision_id);if((prior?.id??null)!==x.expected_handoff_id)fail('Scope handoff changed; refresh review');
      const h={...x,id:crypto.randomUUID(),owner_id:a.user.id,revision:(prior?.revision??0)+1,previous_id:prior?.id??null,source_request_key:crypto.randomUUID(),request_hash:requestHash,
        roots_json:JSON.stringify([...x.roots].sort((a,b)=>a.canonical_case.localeCompare(b.canonical_case))),created_at:new Date().toISOString()} as Row;
      // Check the native tuple independently of the not-yet-persisted latest pointer.
      const d=createBotService(db).read(a,x.decision_id);
      const business=(db.prepare('SELECT business_team_id FROM conversations WHERE id=?').get(d.conversation_id) as {business_team_id:string}).business_team_id;
      const event=(db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM bot_decision_events WHERE decision_id=?').get(x.decision_id) as {n:number}).n;
      if(business!==t.business_id || d.version!==x.decision_version || canonicalSha256(JSON.parse(d.proposal_json))!==x.proposal_hash || event!==x.event_revision)fail('Decision tuple changed; refresh review');
      db.prepare(`INSERT INTO routine_scope_handoffs(id,trust_id,decision_id,decision_version,proposal_hash,event_revision,owner_id,revision,previous_id,request_key,request_hash,source_request_key,roots_json,created_at)
        VALUES(@id,@trust_id,@decision_id,@decision_version,@proposal_hash,@event_revision,@owner_id,@revision,@previous_id,@request_key,@request_hash,@source_request_key,@roots_json,@created_at)`).run(h);
      return view(t,h,true);
    },
    revoke(a:Actor,t:ScopeTrust,raw:unknown) {
      human(a,t);const x=z.object({trust_id:key,handoff_id:key,reason:z.string().min(1).max(2000)}).strict().parse(raw);
      if(x.trust_id!==t.trust_id)fail('Trust mismatch');const h=read(t,x.handoff_id);createBotService(db).read(a,h.decision_id);
      const old=db.prepare('SELECT reason FROM routine_scope_handoff_revocations WHERE handoff_id=?').get(h.id) as {reason:string}|undefined;
      if(old && old.reason!==x.reason)fail('Revocation conflict');
      db.prepare('INSERT OR IGNORE INTO routine_scope_handoff_revocations(handoff_id,actor_id,reason) VALUES(?,?,?)').run(h.id,a.user.id,x.reason);return {revoked:true,execute:false};
    },
    evidence(t:ScopeTrust,x:{decision:{id:string;version:number;proposal_hash:string;event_revision:number}|null;request_key:string;cases:{canonical_case:string}[]}) {
      if(!x.decision)return null;
      const h=latest(t,x.decision.id);if(!h)return null; // Existing manually reviewed scope contracts retain their semantics.
      current(t,h);
      if(h.decision_version!==x.decision.version || h.proposal_hash!==x.decision.proposal_hash || h.event_revision!==x.decision.event_revision)fail('Evidence does not match owner handoff tuple');
      const roots=JSON.parse(h.roots_json) as z.infer<typeof root>[];
      if(roots.some(r=>!x.cases.some(c=>c.canonical_case===r.canonical_case)))fail('Source closure omitted an owner-selected root');
      if(x.request_key!==h.source_request_key && !db.prepare('SELECT 1 FROM routine_scope_handoff_evidence WHERE handoff_id=?').get(h.id))fail('First source observation must match the owner handoff request key');
      return h.id;
    },
    link(evidenceId:string,handoffId:string|null) {if(handoffId)db.prepare('INSERT INTO routine_scope_handoff_evidence(evidence_id,handoff_id) VALUES(?,?)').run(evidenceId,handoffId);},
    covers(t:ScopeTrust,decisionId:string,evidenceId:string) {
      const h=latest(t,decisionId);if(!h)return true;
      try{current(t,h);}catch(e){if(e instanceof BotError)return false;throw e;}
      return !!db.prepare('SELECT 1 FROM routine_scope_handoff_evidence WHERE handoff_id=? AND evidence_id=?').get(h.id,evidenceId);
    },
    revision(t:ScopeTrust) {return {
      prepared:(db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM routine_scope_handoffs WHERE trust_id=?').get(t.trust_id) as {n:number}).n,
      revoked:(db.prepare('SELECT COALESCE(MAX(r.rowid),0) n FROM routine_scope_handoff_revocations r JOIN routine_scope_handoffs h ON h.id=r.handoff_id WHERE h.trust_id=?').get(t.trust_id) as {n:number}).n,
    };},
  };
}
