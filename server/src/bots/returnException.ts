import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {z} from 'zod';
import {BotError,createBotService,type Actor} from './service.js';
import {canonicalSha256,canonicalJson} from './canonical.js';
import type {UserRow} from '../db/db.js';
const key=z.string().trim().min(1).max(200);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
// Explicit, reviewed interpretation of ONE retained approval, not a prose parser
// or a synthetic historical typed approval. Different hashes require review/code.
export const RETURN_INTERPRETATION={
 decisionId:'d98cec40-27a3-4dfa-9748-167b1913cea2',version:1,
 proposalHash:'0e5222445ebc86410c56191666a3b171e42a927ac99ba26e2f61be573d2ad134',
 approvalEventId:'08985b94-b132-4cfc-a0b4-695193f8529b',
 businessId:'5bcfe66f-1bc1-46fb-bc8d-bdc217fe3d86',executorId:'170ab267-448c-4b13-97f4-5f24db2f3652',
 canonicalCase:'606d8062-4628-4f32-aae9-648f529a4774',orderId:'f86d9ba5-58a9-4178-96b6-29bfa03f07d2',orderNumber:'100117518',
 draftId:'26574a06-f1c7-4f90-a14d-6103f697ee2e',sku:'STP54-067',authorizedQty:1,
} as const;
export type ReturnInterpretation={ [K in keyof typeof RETURN_INTERPRETATION]:typeof RETURN_INTERPRETATION[K] extends number?number:string };
export const returnTrustSchema=z.object({business_id:key,executor_id:key,client_id:key,audience:key,account_id:key,principal_id:key,source_origin:z.string().url(),request_key:key}).strict();
export const returnCaptureSchema=z.object({
 schema_version:z.literal('orderops-return-source/v1'),trust_id:key,request_key:key,
 captured_at:z.string().datetime(),source_revision:key,account_id:key,principal_id:key,
 enrollment_revision:key,completeness:z.literal('complete-parent-and-child-material/v1'),lease:z.object({canonical_case:key,principal_id:key,expires_at:z.string().datetime(),revision:key}).strict(),
 conversation:z.object({id:key,customer_id:key,order_id:key,binding_version:key,binding_kind:z.literal('persisted')}).strict(),
 order:z.object({id:key,number:key,shopify_order_id:key,version:hash,items:z.array(z.object({id:key,order_id:key,shopify_line_id:key,sku:z.string().max(500).nullable(),quantity:z.number().int().positive()}).strict()).min(1).max(500)}).strict(),
 draft:z.object({id:key,order_id:key,conversation_id:key,version:hash,type:z.literal('return'),state:z.literal('draft'),selected_items:z.array(z.object({order_item_id:key,quantity:z.number().int().positive()}).strict()).max(1),policy_snapshot_hash:hash}).strict(),
}).strict();
export type ReturnCapture=z.infer<typeof returnCaptureSchema>;
type Trust=z.infer<typeof returnTrustSchema>&{id:string;owner_id:number};
type Mapping={id:string;trust_id:string;decision_id:string;decision_version:number;approval_event_id:string;proposal_hash:string;request_key:string;scope_hash:string;capture_json:string;receipt_json:string};
type Claim={id:string;mapping_id:string;decision_id:string;request_key:string;scope_hash:string};
export type ReturnServiceIdentity={clientId:string;audience:string};
export function returnExceptionService(db:Database.Database,opts:{now?:()=>number;interpretation?:ReturnInterpretation}={}){
 const now=opts.now??Date.now, spec=opts.interpretation??RETURN_INTERPRETATION,bots=createBotService(db);
 const deny=(message:string):never=>{throw new BotError(409,message);};
 function user(id:number){const u=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(id) as UserRow|undefined;if(!u)throw new BotError(403,'Active native identity required');return u;}
 function owner(a:Actor,business:string){user(a.user.id);if(a.conversationId || !db.prepare('SELECT 1 FROM business_teams WHERE id=? AND owner_id=?').get(business,a.user.id))throw new BotError(403,'Authenticated human business owner required');}
 function trust(id:string,identity?:ReturnServiceIdentity,current=true){const t=db.prepare('SELECT * FROM return_bridge_trust WHERE id=?').get(id) as Trust|undefined;if(!t)throw new BotError(404,'Trust not found');if(identity&&(identity.clientId!==t.client_id||identity.audience!==t.audience))throw new BotError(403,'Wrong verifier service identity');if(current){owner({user:user(t.owner_id)},t.business_id);if(db.prepare('SELECT 1 FROM return_bridge_revocations WHERE trust_id=?').get(id))deny('Trust revoked');const c=bots.chat({user:user(t.owner_id)},t.executor_id);if(c.business_team_id!==t.business_id||c.archived||c.user_id!==t.owner_id||!db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(c.id))deny('Executor binding revoked');}return t;}
 function proof(t:Trust){
  const d=bots.read({user:user(t.owner_id)},spec.decisionId);
  if(d.version!==spec.version || d.conversation_id!==spec.executorId || t.executor_id!==spec.executorId || t.business_id!==spec.businessId)deny('Decision/executor/business binding changed');
  if(!['decided','action_pending','blocked','running'].includes(d.state))deny('Decision is no longer an uncompleted approval');
  const p=JSON.parse(d.proposal_json),a=d.answer_json?JSON.parse(d.answer_json):null;
  if(canonicalSha256(p)!==spec.proposalHash)deny('Approved proposal hash changed');
  const events=db.prepare("SELECT rowid,* FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='answered'").all(d.id,d.version) as {rowid:number;id:string;actor_id:number;actor_conversation_id:string|null;payload_json:string;created_at:string}[];
  const e=events[0];if(events.length!==1||!e||e.id!==spec.approvalEventId||e.actor_conversation_id!==null)deny('Exact immutable human approval event required');
  const event=e!,raw=JSON.parse(event.payload_json);
  if(!a||raw.action!=='approve'||a.action!=='approve'||raw.scope!=='this_case'||a.actor_id!==event.actor_id||a.text!==raw.text||a.scope!==raw.scope)deny('Approval attribution or answer changed');
  if(!bots.view({user:user(event.actor_id)},d).can_answer)deny('Original approver authority revoked');
  const snap=db.prepare("SELECT kind,payload_json FROM bot_decision_events WHERE decision_id=? AND version=? AND kind IN ('raised','revised') AND rowid<? ORDER BY rowid DESC LIMIT 1").get(d.id,d.version,event.rowid) as {kind:string;payload_json:string}|undefined;
  if(!snap)deny('Missing original snapshot');const original=JSON.parse(snap!.payload_json);
  if(canonicalSha256(snap!.kind==='raised'?original.proposal:original)!==spec.proposalHash)deny('Original approved snapshot mismatch');
  return {d,event,raw};
 }
 function capture(t:Trust,c:ReturnCapture){
  if(c.trust_id!==t.id||c.account_id!==t.account_id||c.principal_id!==t.principal_id||c.lease.principal_id!==t.principal_id)deny('Source account/principal binding mismatch');
  const age=now()-Date.parse(c.captured_at);if(age< -5000||age>30000||Date.parse(c.lease.expires_at)<now()+30000)deny('Source capture or own lease is stale');
  if(c.conversation.id!==spec.canonicalCase||c.lease.canonical_case!==spec.canonicalCase||c.conversation.order_id!==spec.orderId||c.order.id!==spec.orderId||c.order.number!==spec.orderNumber||c.draft.id!==spec.draftId||c.draft.order_id!==spec.orderId||c.draft.conversation_id!==spec.canonicalCase)deny('Source case/order/draft/customer mismatch');
  if(new Set(c.order.items.map(i=>i.id)).size!==c.order.items.length||new Set(c.order.items.map(i=>i.shopify_line_id)).size!==c.order.items.length||c.order.items.some(i=>i.order_id!==spec.orderId))deny('Conflicting order item identities');
  const items=c.order.items.filter(i=>i.sku===spec.sku);if(items.length!==1)deny('Approved SKU has no unique authoritative order item');const item=items[0]!;
  if(item.quantity<spec.authorizedQty||c.draft.selected_items.some(i=>i.order_item_id!==item.id||i.quantity!==spec.authorizedQty))deny('Draft item set exceeds approved one-item scope');
  return item;
 }
 const mapping=(id:string)=>{const m=db.prepare('SELECT * FROM return_bridge_mappings WHERE id=?').get(id) as Mapping|undefined;if(!m)throw new BotError(404,'Mapping not found');return m;};
 function claimView(c:Claim){return {...c,authorized_submission:true,reusable:false,same_pending_intent_may_complete:true,external_effects_authorized_by_reconcile:false,acknowledgment:db.prepare('SELECT receipt_json FROM return_bridge_acknowledgments WHERE claim_id=?').get(c.id)??null,instruction:'Claim is the authorization linearization point. execute means newly claimed, not permission to repeat effects. Authenticated reconciliation allows finishing only the SAME durable pending intent after locked proof that no local commit/effect occurred, with unchanged exact scope and all current local safety gates. Never create a new intent/key or purchase/send from reconciliation. Native acknowledgment is local submission evidence, not label/refund completion.'};}
 return {
  enroll(a:Actor,raw:unknown){const p=returnTrustSchema.parse(raw);return db.transaction(()=>{owner(a,p.business_id);if(p.business_id!==spec.businessId||p.executor_id!==spec.executorId)deny('Only the reviewed return-exception business/executor is supported');const url=new URL(p.source_origin);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)deny('Canonical HTTPS source origin required');const old=db.prepare('SELECT * FROM return_bridge_trust WHERE request_key=?').get(p.request_key) as Trust|undefined;if(old){if(old.owner_id!==a.user.id||Object.entries(p).some(([k,v])=>old[k as keyof Trust]!==v))deny('Trust request conflict');return trust(old.id);}const id=crypto.randomUUID();db.prepare('INSERT INTO return_bridge_trust(id,business_id,owner_id,executor_id,client_id,audience,account_id,principal_id,source_origin,request_key) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,p.business_id,a.user.id,p.executor_id,p.client_id,p.audience,p.account_id,p.principal_id,p.source_origin,p.request_key);return trust(id);}).immediate();},
  revoke(a:Actor,id:string,reason:string){return db.transaction(()=>{const t=trust(id,undefined,false);owner(a,t.business_id);reason=z.string().trim().min(1).max(2000).parse(reason);const old=db.prepare('SELECT reason FROM return_bridge_revocations WHERE trust_id=?').get(id) as {reason:string}|undefined;if(old&&old.reason!==reason)deny('Revocation conflict');db.prepare('INSERT OR IGNORE INTO return_bridge_revocations(trust_id,actor_id,reason) VALUES(?,?,?)').run(id,a.user.id,reason);return {revoked:true,existing_claims_remain_authorized:true};}).immediate();},
  map(identity:ReturnServiceIdentity,raw:unknown){const c=returnCaptureSchema.parse(raw);return db.transaction(()=>{const t=trust(c.trust_id,identity),p=proof(t),item=capture(t,c);if(db.prepare('SELECT 1 FROM return_bridge_claims WHERE decision_id=?').get(p.d.id))deny('Already claimed; reconcile original pending intent');const old=db.prepare('SELECT * FROM return_bridge_mappings WHERE trust_id=? AND request_key=?').get(t.id,c.request_key) as Mapping|undefined;if(old){if(old.capture_json!==canonicalJson(c))deny('Mapping request conflict');return JSON.parse(old.receipt_json);}
   const id=crypto.randomUUID();const scope={businessId:t.business_id,accountId:t.account_id,executorId:t.executor_id,principalId:t.principal_id,decisionId:p.d.id,decisionVersion:p.d.version,proposalHash:spec.proposalHash,approvalEventId:p.event.id,orderId:c.order.id,shopifyOrderId:c.order.shopify_order_id,canonicalCase:c.conversation.id,customerId:c.conversation.customer_id,bindingVersion:c.conversation.binding_version,draftId:c.draft.id,draftVersion:c.draft.version,orderVersion:c.order.version,orderItemId:item.id,shopifyLineId:item.shopify_line_id,authorizedQty:spec.authorizedQty,kind:'unused_return_window_only',type:'return',allowNonreturnable:false,allowDamage:false,waiveShipping:false,refundAuthorized:false,policySnapshotHash:c.draft.policy_snapshot_hash};
   const receipt={schemaVersion:'veneer-return-exception/v1',issuer:'veneer',audience:t.audience,serviceClientId:t.client_id,mappingId:id,mappingRevision:1,sourceCaptureAt:c.captured_at,sourceRevision:c.source_revision,sourceOrigin:t.source_origin,sourceFingerprint:canonicalSha256(c),scope,scopeHash:canonicalSha256(scope),originalProposal:JSON.parse(p.d.proposal_json),originalApproval:{eventId:p.event.id,humanId:p.event.actor_id,at:p.event.created_at,raw:p.raw},interpretation:'Y4DYW5 reviewed one-item window-only interpretation; source mapping is later evidence, not a historical typed approval',notYetClaimed:true};
   db.prepare('INSERT INTO return_bridge_mappings(id,trust_id,decision_id,decision_version,approval_event_id,proposal_hash,request_key,scope_hash,capture_json,receipt_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,t.id,p.d.id,p.d.version,p.event.id,spec.proposalHash,c.request_key,receipt.scopeHash,canonicalJson(c),canonicalJson(receipt));return receipt;
  }).immediate();},
  claim(identity:ReturnServiceIdentity,raw:unknown){const p=z.object({mapping_id:key,request_key:key,scope_hash:hash,source_capture:returnCaptureSchema}).strict().parse(raw);return db.transaction(()=>{
   const m=mapping(p.mapping_id);trust(m.trust_id,identity,false);
   const prior=db.prepare('SELECT * FROM return_bridge_claims WHERE request_key=? OR decision_id=?').all(p.request_key,m.decision_id) as Claim[];
   if(prior.length){const c=prior[0]!;if(prior.length!==1||c.mapping_id!==m.id||c.request_key!==p.request_key||c.scope_hash!==p.scope_hash||canonicalJson(p.source_capture)!==m.capture_json)deny('Decision already claimed or key conflicts; reconcile original claim');return {...claimView(c),execute:false};}
   const t=trust(m.trust_id,identity);proof(t);capture(t,p.source_capture);
   if(p.source_capture.draft.selected_items.length!==1)deny('Final submission requires the exact singleton selected item');
   // A claim is for the exact captured source revision and mapping. Freshness
   // expires unclaimed mappings, never a successful claim into reusable scope.
   if(m.scope_hash!==p.scope_hash||canonicalJson(p.source_capture)!==m.capture_json)deny('Source binding drift; obtain a new mapping before claim');
   const c={id:crypto.randomUUID(),mapping_id:m.id,decision_id:m.decision_id,request_key:p.request_key,scope_hash:m.scope_hash};db.prepare('INSERT INTO return_bridge_claims(id,mapping_id,decision_id,request_key,scope_hash) VALUES(@id,@mapping_id,@decision_id,@request_key,@scope_hash)').run(c);return {...claimView(c),execute:true};
  }).immediate();},
  reconcile(identity:ReturnServiceIdentity,id:string){const c=db.prepare('SELECT * FROM return_bridge_claims WHERE request_key=?').get(id) as Claim|undefined;if(!c)throw new BotError(404,'Claim not found');trust(mapping(c.mapping_id).trust_id,identity,false);return {...claimView(c),execute:false};},
  acknowledge(identity:ReturnServiceIdentity,raw:unknown){const p=z.object({request_key:key,scope_hash:hash,local_submission_id:key,local_committed_at:z.string().datetime(),local_receipt_hash:hash}).strict().parse(raw);return db.transaction(()=>{const c=db.prepare('SELECT * FROM return_bridge_claims WHERE request_key=?').get(p.request_key) as Claim|undefined;if(!c)throw new BotError(404,'Claim not found');trust(mapping(c.mapping_id).trust_id,identity,false);if(c.scope_hash!==p.scope_hash)deny('Receipt scope mismatch');const json=canonicalJson(p),old=db.prepare('SELECT receipt_json FROM return_bridge_acknowledgments WHERE claim_id=?').get(c.id) as {receipt_json:string}|undefined;if(old&&old.receipt_json!==json)deny('Conflicting local receipt');db.prepare('INSERT OR IGNORE INTO return_bridge_acknowledgments(claim_id,receipt_json) VALUES(?,?)').run(c.id,json);return claimView(c);}).immediate();},
 };
}
