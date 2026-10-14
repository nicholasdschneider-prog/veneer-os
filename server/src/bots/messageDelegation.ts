import {guardVendorEmailDraft} from './vendorEmail.js';
import {gmailBindSchema, gmailBindingReceiptSchema, gmailContextReviewSchema, type GmailMappingEvidence} from './approvedGmailContract.js';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError, createBotService, type Actor, type Proposal } from './service.js';
import { approvedMessageSchema } from './draftPayload.js';
import { canonicalJson, canonicalSha256 } from './canonical.js';
import { canSendToConversation } from '../conversations/access.js';
import { refuseUnregisteredChat } from './unregisteredChat.js';
import type { UserRow } from '../db/db.js';

type Scope = z.infer<typeof approvedMessageSchema>;
export interface CaseMappingEvidence {
  schema_version: 'approved-case-mapping/v1';
  fingerprint: string; source_revision: string; observed_at: string;
  registration_id: string; registration_hash: string; source_origin: string;
  account_id: string; business_id: string; principal_id: string; caller_id: string;
  canonical_case: string; ticket: string; customer_id: string;
  related_order_id: string | null; order_binding_version: number | null; order_binding_explicit: boolean | null;
  runtime: {projectId:string;environmentId:string;serviceId:string};
  provenance: {custodian_id:string;receipt:string;registered_at:string;authority:'approved-message-resolver-custody'};
}
export type CaseMappingCheck = (a: Actor, decision: {id:string;version:number;conversation_id:string;proposal_json:string}, scope: Scope) => CaseMappingEvidence | GmailMappingEvidence;
export interface Delegation {
  id: string; decision_id: string; decision_version: number; owner_conversation_id: string;
  executor_conversation_id: string; executor_user_id: number; delegator_user_id: number; approver_user_id: number;
  approval_event_id: string; proposal_hash: string; payload_hash: string; scope_json: string; request_key: string;
}
interface BoundDraft { id: string; delegation_id: string | null; conversation_id: string; decision_id: string | null; decision_version: number | null; authorized_by: number | null; payload_json: string; claim_key?: string | null; version?:number; state?:string; receipt?:string|null; }
export const sendCheckSchema = z.object({
  payload_hash: z.string().regex(/^[a-f0-9]{64}$/), material_evidence_unchanged: z.literal(true),
  recipient_account_case_verified: z.literal(true), lease_and_duplicates_checked: z.literal(true),
  evidence: z.string().trim().min(1).max(2000),
}).strict();
export const deliveryProofSchema = z.object({
  provider: z.string().trim().min(1).max(100), provider_message_id: z.string().trim().min(1).max(500),
  account: z.string().min(1).max(500), recipients: z.array(z.string().min(1).max(500)).min(1).max(20),
  canonical_case: z.string().min(1).max(500), payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotency_key: z.string().min(1).max(200), verified: z.literal(true),
}).strict();
export class MissingMessageProof extends BotError {
  constructor(public missing_proof: string[]) { super(409, `Approved-message bridge needs proof: ${missing_proof.join('; ')}. No approval imported. Do not automatically request another approval.`); }
}
export function messageDelegationService(db: Database.Database, mappingCheck?: CaseMappingCheck) {
  const bots = createBotService(db);
  const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  function user(id: number) {
    const u = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(id) as UserRow | undefined;
    if (!u) throw new BotError(403, 'Participant authorization is revoked');
    return u;
  }
  function activeBot(a: Actor, id: string, own = false) {
    const u = user(a.user.id);
    const c = bots.chat({ ...a, user: u }, id);
    if (id === a.conversationId) refuseUnregisteredChat(db, id);
    if (c.archived || !canSendToConversation(u, c, db) || !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(id)) throw new BotError(403, 'Bot access or registration is inactive');
    if (own && (a.conversationId !== id || c.user_id !== u.id)) throw new BotError(403, 'Only this named bot may perform the operation');
    user(c.user_id);
    return c;
  }
  function proof(a: Actor, id: string, version: number, completedReceipt = false) {
    // Read-only: never clear a running conversation's discussion context.
    const d = bots.read({ user: user(a.user.id) }, id);
    bots.chat(a, d.conversation_id);
    if (d.version !== version) throw new BotError(409, 'Decision version changed');
    const p = JSON.parse(d.proposal_json) as Proposal;
    const answer = d.answer_json ? JSON.parse(d.answer_json) : null;
    if (answer?.action !== 'approve' || !(['decided','action_pending','blocked','running'].includes(d.state) || (completedReceipt && d.state === 'verified_completed'))) throw new BotError(409, 'A current uncompleted approve decision is required');
    const events = db.prepare("SELECT rowid,id,actor_id,actor_conversation_id,payload_json FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='answered'").all(id,version) as {rowid:number;id:string;actor_id:number;actor_conversation_id:string|null;payload_json:string}[];
    if (events.length !== 1) throw new MissingMessageProof(['one immutable human approval event for this exact version']);
    const approval = events[0]!;
    const raw = JSON.parse(approval.payload_json);
    if (approval.actor_conversation_id || raw.action !== 'approve' || approval.actor_id !== answer.actor_id || raw.text !== answer.text || raw.scope !== answer.scope) throw new MissingMessageProof(['unchanged human approval attribution and answer']);
    const approver = user(approval.actor_id);
    if (!bots.view({user:approver},d).can_answer) throw new BotError(403, 'Original approver no longer has authority');
    const snapshot = db.prepare("SELECT kind,payload_json FROM bot_decision_events WHERE decision_id=? AND version=? AND kind IN ('raised','revised') AND rowid<? ORDER BY rowid DESC LIMIT 1").get(id,version,approval.rowid) as {kind:string;payload_json:string}|undefined;
    const stored = snapshot ? JSON.parse(snapshot.payload_json) : null;
    if (!snapshot || !equal(snapshot.kind === 'raised' ? stored.proposal : stored,p)) throw new MissingMessageProof(['unchanged proposal snapshot preceding human approval']);
    const parsed = approvedMessageSchema.safeParse(p.message_delivery);
    if (!parsed.success) throw new MissingMessageProof(['proposal.message_delivery in the approved snapshot: exact channel/account/recipients/subject/body/customer/ticket/attachments, canonical_case and named executor; legacy EXACT DRAFT prose is not a structured transport authorization']);
    const scope = parsed.data;
    let mapping: CaseMappingEvidence | GmailMappingEvidence | undefined;
    if (scope.canonical_case !== scope.payload.ticket) {
      if (!mappingCheck) throw new MissingMessageProof(['canonical_case must equal the approved payload.ticket unless a registered authenticated source mapping is available']);
      mapping = mappingCheck(a,d,scope);
    }
    const owner = activeBot({user:approver},d.conversation_id);
    const executor = activeBot({user:approver},scope.executor_conversation_id);
    if (!owner.business_team_id || executor.business_team_id !== owner.business_team_id) throw new BotError(403, 'Delegation requires the same explicit business');
    return { d, scope, approval, approver, mapping, proposal_hash: canonicalSha256(p), payload_hash: canonicalSha256(scope) };
  }
  function record(a: Actor, g: Delegation, kind: string, key: string, payload: unknown) {
    const json = canonicalJson(payload);
    const prior = db.prepare('SELECT actor_id,actor_conversation_id,payload_json FROM bot_message_delegation_events WHERE delegation_id=? AND kind=? AND request_key=?').get(g.id,kind,key) as {actor_id:number;actor_conversation_id:string;payload_json:string}|undefined;
    if (prior) {
      if (prior.actor_id !== a.user.id || prior.actor_conversation_id !== a.conversationId || prior.payload_json !== json) throw new BotError(409,'Conflicting delegation replay');
      return;
    }
    db.prepare('INSERT INTO bot_message_delegation_events(id,delegation_id,actor_id,actor_conversation_id,kind,request_key,payload_json) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(),g.id,a.user.id,a.conversationId,kind,key,json);
  }
  function read(a: Actor, id: string) {
    const g = db.prepare('SELECT * FROM bot_message_delegations WHERE id=?').get(id) as Delegation|undefined;
    if (!g) throw new BotError(404,'Delegation not found');
    bots.chat(a,g.owner_conversation_id); bots.chat(a,g.executor_conversation_id);
    if (a.conversationId && ![g.owner_conversation_id,g.executor_conversation_id].includes(a.conversationId)) throw new BotError(403,'Only the named owner or executor may use this delegation');
    return g;
  }
  function authorityContext(id:string){
    const d=db.prepare('SELECT proposal_json,answer_json,handling_revision FROM bot_decisions WHERE id=?').get(id);
    const threads=db.prepare('SELECT * FROM bot_decision_threads WHERE decision_id=? ORDER BY rowid').all(id);
    return canonicalSha256({decision:d,threads});
  }
  function valid(a: Actor, g: Delegation, running = false, completedReceipt = false) {
    const found = proof(a,g.decision_id,g.decision_version,completedReceipt);
    const delegator = user(g.delegator_user_id);
    activeBot({user:delegator,conversationId:g.owner_conversation_id},g.owner_conversation_id,true);
    const executor = activeBot({user:delegator},g.executor_conversation_id);
    if (executor.user_id !== g.executor_user_id) throw new BotError(403, 'Executor ownership changed');
    user(g.executor_user_id);
    if (found.d.conversation_id !== g.owner_conversation_id || found.approval.id !== g.approval_event_id || found.approver.id !== g.approver_user_id || found.proposal_hash !== g.proposal_hash || found.payload_hash !== g.payload_hash || !equal(found.scope,JSON.parse(g.scope_json))) throw new BotError(409,'Delegation proof changed');
    if (db.prepare("SELECT 1 FROM bot_message_delegation_events WHERE delegation_id=? AND kind='revoked'").get(g.id)) throw new BotError(403,'Delegation revoked');
    if(found.mapping){
      const binding=db.prepare('SELECT fingerprint,source_revision FROM approved_case_mapping_bindings WHERE delegation_id=?').get(g.id) as {fingerprint:string;source_revision:string}|undefined;
      if(!binding||binding.fingerprint!==found.mapping.fingerprint||(!completedReceipt && binding.source_revision!==found.mapping.source_revision))throw new BotError(409,'Authenticated case mapping or source revision changed; no new send');
    }
    const gmailContext=db.prepare('SELECT authority_context_hash FROM approved_gmail_draft_bindings WHERE delegation_id=?').get(g.id) as {authority_context_hash:string}|undefined;
    if(gmailContext&&gmailContext.authority_context_hash!==authorityContext(g.decision_id))throw new BotError(409,'Approved Gmail native context changed; no renewed delivery');
    if (running && found.d.state !== 'running' && !(completedReceipt && found.d.state === 'verified_completed')) throw new BotError(409,'The owner must record current material checks and RUNNING through the existing decision lifecycle before delivery');
    return found;
  }
  function bound(a: Actor, draft: BoundDraft, running = false, completedReceipt = false) {
    if (!draft.delegation_id) throw new BotError(409,'Not a delegated draft');
    const g = read(a,draft.delegation_id); const found = valid(a,g,running,completedReceipt);
    activeBot(a,g.executor_conversation_id,true);
    const supplemental=db.prepare('SELECT * FROM approved_gmail_draft_bindings WHERE delegation_id=?').get(g.id) as {draft_id:string;draft_version:number;draft_payload_hash:string;approved_payload_hash:string;review_json:string}|undefined;
    let matches=equal(JSON.parse(draft.payload_json),found.scope.payload);
    if(supplemental){
      if(found.mapping?.schema_version!=='approved-gmail-source/v1'||supplemental.draft_id!==draft.id||supplemental.draft_version!==draft.version||supplemental.draft_payload_hash!==canonicalSha256(JSON.parse(draft.payload_json))||supplemental.approved_payload_hash!==canonicalSha256(found.scope.payload))throw new BotError(409,'Existing Gmail draft binding changed');
      contextReview(found.scope.payload,JSON.parse(draft.payload_json),JSON.parse(supplemental.review_json));
      matches=true;
    }
    if (draft.conversation_id !== g.executor_conversation_id || draft.decision_id !== g.decision_id || draft.decision_version !== g.decision_version || draft.authorized_by !== g.approver_user_id || !matches) throw new BotError(409,'Draft differs from its immutable delegation');
    return {g,...found};
  }

  function contextReview(approved:Scope['payload'],draft:Scope['payload'],raw:unknown){
    const review=gmailContextReviewSchema.parse(raw);
    const {context:ac,...am}=approved,{context:dc,...dm}=draft;
    if(ac!==''||!dc||!equal(am,dm)||review.approved_context_hash!==canonicalSha256(ac)||review.draft_context_hash!==canonicalSha256(dc))throw new BotError(409,'Exact send material or context commitment changed');
    let end=0;for(const part of review.segments){if(part.start!==end||part.end>dc.length||part.end<=part.start||dc.slice(part.start,part.end)!==part.text)throw new BotError(409,'Complete exact context citations required');end=part.end;}
    if(end!==dc.length)throw new BotError(409,'Complete exact context citations required');
    return review;
  }
  function existingInspection(a:Actor,id:string,version:number,draftId:string,draftVersion:number){
    const p=proof(a,id,version);activeBot(a,p.d.conversation_id,true);
    if(p.scope.executor_conversation_id!==a.conversationId||p.mapping?.schema_version!=='approved-gmail-source/v1')throw new MissingMessageProof(['authenticated own-account Gmail source and original owner/executor required']);
    const d=db.prepare('SELECT * FROM bot_message_drafts WHERE id=?').get(draftId) as BoundDraft|undefined;
    if(!d||d.version!==draftVersion||d.conversation_id!==a.conversationId||d.decision_id!==id||d.decision_version!==version)throw new BotError(409,'Exact existing decision draft required');
    const payload=JSON.parse(d.payload_json) as Scope['payload'];
    guardVendorEmailDraft(db,d.conversation_id,payload);
    const {context:ac,...am}=p.scope.payload,{context:dc,...dm}=payload;
    if(ac!==''||!dc||!equal(am,dm))throw new BotError(409,'Only separately reviewed operational context may differ; send material must be identical');
    const context={decision:p.d,events:db.prepare('SELECT * FROM bot_decision_events WHERE decision_id=? ORDER BY rowid LIMIT 1001').all(id),discussion:db.prepare('SELECT * FROM bot_decision_threads WHERE decision_id=? ORDER BY rowid LIMIT 1001').all(id)};
    if(context.events.length>1000||context.discussion.length>1000||Buffer.byteLength(JSON.stringify(context))>1024*1024)throw new BotError(409,'Complete approval context exceeds bounded review');
    const visible=bots.thread(a,id);
    if(visible.events.some(e=>JSON.parse(e.payload_json)?.text==='Historical proposal context is no longer accessible.'))throw new BotError(403,'Complete historical approval context is not accessible');
    const snapshot={schema_version:'approved-gmail-inspection/v1',decision_id:id,decision_version:version,approval_event_id:p.approval.id,proposal_hash:p.proposal_hash,
      approval_hash:canonicalSha256(p.approval),decision_context_hash:canonicalSha256(context),native_context:context,
      draft_id:draftId,draft_version:draftVersion,approved_scope_hash:p.payload_hash,approved_payload_hash:canonicalSha256(p.scope.payload),draft_payload_hash:canonicalSha256(payload),
      approved_context:ac,draft_context:dc,approved_scope:p.scope,existing_payload:payload,source_fingerprint:p.mapping.fingerprint,source_revision:p.mapping.source_revision};
    return {p,d,snapshot,inspection_hash:canonicalSha256(snapshot)};
  }
  return {

    inspectExisting(a:Actor,id:string,version:number,draftId:string,draftVersion:number){
      const x=existingInspection(a,id,version,draftId,draftVersion);
      if(x.d.claim_key||x.d.receipt||!['draft','queued'].includes(x.d.state!))throw new BotError(409,'Draft already claimed or closed; reconcile only');
      return {execute:false,...x.snapshot,inspection_hash:x.inspection_hash};
    },
    bindExisting(a:Actor,raw:unknown){const input=gmailBindSchema.parse(raw);return db.transaction(()=>{
      const x=existingInspection(a,input.decision_id,input.expected_version,input.draft_id,input.draft_version);
      const requestHash=canonicalSha256(input);
      const prior=db.prepare('SELECT * FROM approved_gmail_draft_bindings WHERE decision_id=? OR draft_id=?').all(input.decision_id,input.draft_id) as {request_key:string;request_hash:string;delegation_id:string;draft_id:string;approved_payload_hash:string;draft_payload_hash:string;inspection_hash:string}[];
      if(prior.length){if(prior.length!==1||prior[0]!.request_key!==input.request_key||prior[0]!.request_hash!==requestHash)throw new BotError(409,'Existing Gmail action permanently bound');const g=read(a,prior[0]!.delegation_id);valid(a,g);return gmailBindingReceiptSchema.parse({schema_version:'approved-gmail-binding/v1',execute:false,replayed:true,delegation_id:g.id,draft_id:prior[0]!.draft_id,decision_id:g.decision_id,decision_version:g.decision_version,approved_payload_hash:prior[0]!.approved_payload_hash,draft_payload_hash:prior[0]!.draft_payload_hash,inspection_hash:prior[0]!.inspection_hash});}
      if(x.inspection_hash!==input.inspection_hash)throw new BotError(409,'Inspection changed; inspect again');
      const review=contextReview(x.p.scope.payload,JSON.parse(x.d.payload_json),input.review);
      if(x.d.state!=='draft'||x.d.authorized_by!==null||x.d.claim_key||x.d.receipt||x.d.delegation_id)throw new BotError(409,'Existing draft is not unclaimed and unauthorized');
      if(db.prepare('SELECT 1 FROM bot_message_delegations WHERE decision_id=?').get(input.decision_id))throw new BotError(409,'Decision already bound; no competing action');
      const peers=db.prepare("SELECT id,state,claim_key,authorized_by,delegation_id,receipt FROM bot_message_drafts WHERE decision_id=? AND id<>?").all(input.decision_id,input.draft_id) as {state:string;claim_key:string|null;authorized_by:number|null;delegation_id:string|null;receipt:string|null}[];
      if(peers.some(d=>d.state!=='discarded'||d.claim_key||d.authorized_by||d.delegation_id||d.receipt))throw new BotError(409,'Competing or uncertain decision draft');
      const g:Delegation={id:crypto.randomUUID(),decision_id:input.decision_id,decision_version:input.expected_version,owner_conversation_id:a.conversationId!,executor_conversation_id:a.conversationId!,executor_user_id:a.user.id,delegator_user_id:a.user.id,approver_user_id:x.p.approver.id,approval_event_id:x.p.approval.id,proposal_hash:x.p.proposal_hash,payload_hash:x.p.payload_hash,scope_json:canonicalJson(x.p.scope),request_key:input.request_key};
      db.prepare('INSERT INTO bot_message_delegations(id,decision_id,decision_version,owner_conversation_id,executor_conversation_id,executor_user_id,delegator_user_id,approver_user_id,approval_event_id,proposal_hash,payload_hash,scope_json,request_key) VALUES(@id,@decision_id,@decision_version,@owner_conversation_id,@executor_conversation_id,@executor_user_id,@delegator_user_id,@approver_user_id,@approval_event_id,@proposal_hash,@payload_hash,@scope_json,@request_key)').run(g);
      const m=x.p.mapping!;
      db.prepare('INSERT INTO approved_case_mapping_bindings(delegation_id,fingerprint,source_revision,evidence_json) VALUES(?,?,?,?)').run(g.id,m.fingerprint,m.source_revision,canonicalJson(m));
      const target={decision_id:input.decision_id,expected_version:input.expected_version,draft_id:input.draft_id,draft_version:input.draft_version,thread_id:input.thread_id,reply_message_id:input.reply_message_id,reply_rfc_message_id:input.reply_rfc_message_id};
      if(m.schema_version!=='approved-gmail-source/v1'||m.thread_id!==target.thread_id||m.reply_message_id!==target.reply_message_id||m.reply_rfc_message_id!==target.reply_rfc_message_id)throw new BotError(409,'Gmail target changed');
      db.prepare("UPDATE bot_message_drafts SET delegation_id=?,authorized_by=?,state='queued',updated_at=datetime('now') WHERE id=?").run(g.id,g.approver_user_id,x.d.id);
      const {context:ignoredContext,...sendMaterial}=x.p.scope.payload;
      const sendMaterialHash=canonicalSha256(sendMaterial);
      const actionHash=canonicalSha256({schema:'approved-gmail-action/v1',business_id:m.business_id,account:x.p.scope.payload.account,thread_id:target.thread_id,reply_message_id:target.reply_message_id,send_material_hash:sendMaterialHash});
      db.prepare('INSERT INTO approved_gmail_draft_bindings(decision_id,delegation_id,draft_id,draft_version,request_key,request_hash,action_hash,send_material_hash,draft_payload_hash,approved_payload_hash,target_json,review_json,inspection_hash,authority_context_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(g.decision_id,g.id,x.d.id,input.draft_version,input.request_key,requestHash,actionHash,sendMaterialHash,x.snapshot.draft_payload_hash,x.snapshot.approved_payload_hash,canonicalJson(target),canonicalJson(review),x.inspection_hash,authorityContext(g.decision_id));
      record(a,g,'accepted',input.request_key,{draft_id:x.d.id,payload_hash:g.payload_hash,draft_payload_hash:x.snapshot.draft_payload_hash,approved_payload_hash:x.snapshot.approved_payload_hash,context_review:review,inspection_hash:x.inspection_hash});
      return gmailBindingReceiptSchema.parse({schema_version:'approved-gmail-binding/v1',execute:false,replayed:false,delegation_id:g.id,draft_id:x.d.id,decision_id:g.decision_id,decision_version:g.decision_version,approved_payload_hash:x.snapshot.approved_payload_hash,draft_payload_hash:x.snapshot.draft_payload_hash,inspection_hash:x.inspection_hash});
    }).immediate();},
    // Public pre-send validation never admits completed decisions.
    bound: (a: Actor, draft: BoundDraft, running = false) => bound(a,draft,running), record,
    // Read-only preflight for the server resolver, including receipt reconciliation.
    mappingTarget: (a:Actor,id:string,version:number,receiptOnly=false) => proof(a,id,version,receiptOnly),
    inspect(a: Actor, id: string, version: number) {
      try {const p=proof(a,id,version);
        if(p.mapping){const existing=db.prepare('SELECT * FROM bot_message_delegations WHERE decision_id=? AND decision_version=?').get(id,version) as Delegation|undefined;if(existing)valid(a,existing);}
        return {ready:true,decision_id:id,decision_version:version,owner_conversation_id:p.d.conversation_id,scope:p.scope,payload_hash:p.payload_hash,approval_event_id:p.approval.id,...(p.mapping?{case_mapping:p.mapping}:{})};}
      catch(e){if(e instanceof MissingMessageProof)return {ready:false,missing_proof:e.missing_proof};throw e;}
    },
    delegate(a: Actor, id: string, version: number, executor: string, key: string, scope: Scope) {
      return db.transaction(()=>{
        const p=proof(a,id,version);if(p.mapping?.schema_version==='approved-gmail-source/v1')throw new BotError(409,'Use prospective existing Gmail draft binding; no new draft');activeBot(a,p.d.conversation_id,true);activeBot(a,executor);
        // The immutable approval may name its owner as executor. Both roles
        // still require their own actor checks; this does not authorize an ordinary draft.
        if (executor !== p.scope.executor_conversation_id || !equal(scope,p.scope)) throw new BotError(409,'Named executor or exact approved scope differs');
        if(db.prepare('SELECT 1 FROM approved_gmail_draft_bindings WHERE decision_id=?').get(id))throw new BotError(409,'Gmail action permanently bound');
        const prior=db.prepare('SELECT * FROM bot_message_delegations WHERE (decision_id=? AND decision_version=?) OR (owner_conversation_id=? AND request_key=?)').all(id,version,p.d.conversation_id,key) as Delegation[];
        if(prior.length){const g=prior[0]!;if(prior.length!==1||g.request_key!==key||g.decision_id!==id||g.decision_version!==version||g.delegator_user_id!==a.user.id||g.payload_hash!==p.payload_hash)throw new BotError(409,'Decision version or request key already bound; no new delivery');valid(a,g);return g;}
        const g:Delegation={id:crypto.randomUUID(),decision_id:id,decision_version:version,owner_conversation_id:p.d.conversation_id,executor_conversation_id:executor,executor_user_id:bots.chat(a,executor).user_id,delegator_user_id:a.user.id,approver_user_id:p.approver.id,approval_event_id:p.approval.id,proposal_hash:p.proposal_hash,payload_hash:p.payload_hash,scope_json:canonicalJson(p.scope),request_key:key};
        db.prepare('INSERT INTO bot_message_delegations(id,decision_id,decision_version,owner_conversation_id,executor_conversation_id,executor_user_id,delegator_user_id,approver_user_id,approval_event_id,proposal_hash,payload_hash,scope_json,request_key) VALUES(@id,@decision_id,@decision_version,@owner_conversation_id,@executor_conversation_id,@executor_user_id,@delegator_user_id,@approver_user_id,@approval_event_id,@proposal_hash,@payload_hash,@scope_json,@request_key)').run(g);
        if(p.mapping)db.prepare('INSERT INTO approved_case_mapping_bindings(delegation_id,fingerprint,source_revision,evidence_json) VALUES(?,?,?,?)').run(g.id,p.mapping.fingerprint,p.mapping.source_revision,canonicalJson(p.mapping));
        return g;
      }).immediate();
    },
    revoke(a:Actor,id:string,key:string,reason:string){return db.transaction(()=>{const g=read(a,id);activeBot(a,g.owner_conversation_id,true);record(a,g,'revoked',key,{reason});return {revoked:true,delegation_id:id};}).immediate();},
    accept(a:Actor,id:string,key:string,scope:Scope){return db.transaction(()=>{
      const g=read(a,id);const p=valid(a,g);activeBot(a,g.executor_conversation_id,true);
      if(!equal(scope,p.scope))throw new BotError(409,'Acceptance differs from exact approved scope');
      const old=db.prepare('SELECT * FROM bot_message_drafts WHERE delegation_id=? OR (conversation_id=? AND request_key=?)').all(id,g.executor_conversation_id,key) as (BoundDraft & {request_key:string})[];
      if(old.length){if(old.length!==1||old[0]!.delegation_id!==id||old[0]!.request_key!==key)throw new BotError(409,'Acceptance already bound; do not create another draft');bound(a,old[0]!);return old[0]!;}
      const draftId=crypto.randomUUID();
      db.prepare("INSERT INTO bot_message_drafts(id,conversation_id,decision_id,decision_version,request_key,payload_json,state,authorized_by,delegation_id) VALUES(?,?,?,?,?,?,'queued',?,?)").run(draftId,g.executor_conversation_id,g.decision_id,g.decision_version,key,JSON.stringify(p.scope.payload),g.approver_user_id,g.id);
      record(a,g,'accepted',key,{draft_id:draftId,payload_hash:g.payload_hash,...(p.mapping?{case_mapping:p.mapping}:{})});
      return db.prepare('SELECT * FROM bot_message_drafts WHERE id=?').get(draftId) as BoundDraft;
    }).immediate();},
    checkSend(a:Actor,draft:BoundDraft,check:unknown){const p=bound(a,draft,true);const parsed=sendCheckSchema.parse(check);if(parsed.payload_hash!==p.g.payload_hash)throw new BotError(409,'Fresh send check has a different payload hash');return p;},
    delivery(a:Actor,draft:BoundDraft,state:string,receipt:string,proofInput:unknown){
      // Only positive receipt reconciliation may inspect completed approval proof.
      // This never reaches inspect/delegate/accept/claim or changes the decision.
      const p=bound(a,draft,true,state==='sent');
      if(p.d.state==='verified_completed'){
        const events=db.prepare("SELECT rowid,id,actor_id,actor_conversation_id,kind,request_key,payload_json FROM bot_message_delegation_events WHERE delegation_id=? AND kind IN ('accepted','claimed') ORDER BY rowid").all(p.g.id) as {rowid:number;id:string;actor_id:number;actor_conversation_id:string;kind:string;request_key:string;payload_json:string}[];
        const accepted=events.filter(e=>e.kind==='accepted');const claimed=events.filter(e=>e.kind==='claimed');
        if(accepted.length!==1||claimed.length!==1||!draft.claim_key)throw new BotError(409,'Completed receipt requires one original durable acceptance and claim');
        const accept=accepted[0]!, claim=claimed[0]!;
        const acceptPayload=JSON.parse(accept.payload_json), claimPayload=JSON.parse(claim.payload_json);
        const check=sendCheckSchema.safeParse(claimPayload.send_check);
        if(accept.rowid>=claim.rowid||[accept,claim].some(e=>e.actor_id!==a.user.id||e.actor_conversation_id!==a.conversationId)||claim.request_key!==draft.claim_key||acceptPayload.draft_id!==draft.id||acceptPayload.payload_hash!==p.g.payload_hash||claimPayload.draft_id!==draft.id||!check.success||check.data.payload_hash!==p.g.payload_hash)throw new BotError(409,'Completed receipt does not match the original durable claim');
      }
      if(state==='sent'){
        const v=deliveryProofSchema.parse(proofInput);
        if(/^(unknown|pending|queued|none|n\/a)$/i.test(v.provider_message_id)||v.account!==p.scope.payload.account||!equal(v.recipients,p.scope.payload.recipients)||v.canonical_case!==p.scope.canonical_case||v.payload_hash!==p.g.payload_hash||v.idempotency_key!==`veneer-message:${draft.id}`)throw new BotError(409,'Delivery proof does not match this approved message');
        const prior=db.prepare('SELECT draft_id,proof_json FROM bot_message_delivery_proofs WHERE draft_id=? OR (account=? AND provider=? AND provider_message_id=?)').all(draft.id,v.account,v.provider,v.provider_message_id) as {draft_id:string;proof_json:string}[];
        if(prior.length && (prior.length!==1||prior[0]!.draft_id!==draft.id||prior[0]!.proof_json!==canonicalJson(v)))throw new BotError(409,'Conflicting or duplicate provider delivery');
        if(!prior.length)db.prepare('INSERT INTO bot_message_delivery_proofs(draft_id,account,provider,provider_message_id,proof_json) VALUES(?,?,?,?,?)').run(draft.id,v.account,v.provider,v.provider_message_id,canonicalJson(v));
      } else if(proofInput!==undefined)throw new BotError(400,'Only a verified sent outcome accepts delivery proof');
      record(a,p.g,state,canonicalSha256({state,receipt,proof:proofInput}),{draft_id:draft.id,state,receipt,proof:proofInput});
    },
  };
}
