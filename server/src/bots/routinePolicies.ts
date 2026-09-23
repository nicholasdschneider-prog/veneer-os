import { routineExecutionService } from './routineExecution.js';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError, createBotService, type Actor } from './service.js';
import { canonicalSha256 } from './canonical.js';
import { approvedMessageSchema } from './draftPayload.js';
import type { UserRow } from '../db/db.js';

const key=z.string().trim().min(1).max(200);
export const routineCategories = ['missing_information','no_order_catalog','unused_return','approved_status_restatement','factual_tracking'] as const;
export const routineCategory=z.enum(routineCategories);
// Describes a fixed maximum envelope, not a semantic eligibility decision.
export const routineEnvelope = {
  revision:'build203-envelope-v1',
  missing_information:'Only actually missing model/label/fitment/photo information; no remedy promise.',
  no_order_catalog:'Current qualified no-order catalog facts; no fit guarantee, purchase, discount or special order.',
  unused_return:'Existing eligible unused-return file-first checks and only labels that workflow authorizes; no refund, exception or separate postage.',
  approved_status_restatement:'Accurately restate existing approved RMA/claim/policy; no new money, timing or remedy promise; insurer identifiers remain internal.',
  factual_tracking:'Exact paid order/shipment and current authoritative carrier facts/link only. No delivery guarantee, cause, loss, split-shipment, vendor ETA or remedy. Preserve nonreceipt/dispute and all remaining duties; do not treat factual reply as case resolution.',
  exclusions:'No refund, cancellation, credit, replacement/reship, discount/MAP, purchase, return exception, chargeback, legal admission, risky address change or outside-workflow label. No extra email for acknowledgment-only, verified completion or no-contact closeout. Preserve explicit human hold/reject/defer/withdraw, foreign ownership, unknown effects and other specialist boundaries.',
  guards:'Retained named owner, own current exclusive lease, all-channel context, source identity and material freshness, duplicates, idempotency and verified delivery readback. Technical source access is not authority.',
};
export const enrollRoutineSchema=z.object({
 business_id:key, policy_key:key, expected_version:z.number().int().nonnegative(), request_key:key,
 source_reference:z.string().trim().min(1).max(2000), policy_text:z.string().trim().min(100).max(50000),
 executor_ids:z.array(key).min(1).max(100), categories:z.array(routineCategory).min(1).max(5),
}).strict();
type Input=z.infer<typeof enrollRoutineSchema>;
type Row={id:string;business_id:string;policy_key:string;version:number;issuer_id:number;request_key:string;snapshot_json:string;snapshot_hash:string};
export function routinePolicyService(db:Database.Database){
 const bots=createBotService(db);
 function active(a:Actor){
  const u=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(a.user.id) as UserRow|undefined;
  if(!u)throw new BotError(403,'Active authenticated identity required');
  return {...a,user:u};
 }
 function owner(a:Actor,business:string){
  a=active(a);
  if(a.conversationId)throw new BotError(403,'Policy enrollment requires the authenticated human business owner; bot membership is not policy authority');
  if(!db.prepare('SELECT 1 FROM business_teams WHERE id=? AND owner_id=?').get(business,a.user.id))throw new BotError(403,'Current business owner required');
 }
 function executor(a:Actor,id:string,business:string){
  a=active(a);const c=bots.chat(a,id);
  if(c.archived || c.business_team_id!==business || !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(id) || !db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(c.user_id))throw new BotError(403,'Executor must be active and accessible in this exact business');
  return c;
 }
 function read(id:string){const r=db.prepare('SELECT * FROM bot_routine_policies WHERE id=?').get(id) as Row|undefined;if(!r)throw new BotError(404,'Policy not found');return r;}
 function status(r:Row){
  if(db.prepare('SELECT 1 FROM bot_routine_policy_revocations WHERE policy_id=?').get(r.id))return 'revoked';
  if(db.prepare('SELECT 1 FROM bot_routine_policies WHERE business_id=? AND policy_key=? AND version>?').get(r.business_id,r.policy_key,r.version))return 'superseded';
  if(!db.prepare("SELECT 1 FROM business_teams t JOIN users u ON u.id=t.owner_id WHERE t.id=? AND t.owner_id=? AND u.status='active'").get(r.business_id,r.issuer_id))return 'issuer_revoked';
  return 'enrolled_setup_required';
 }
 function view(r:Row){return {...r,snapshot_json:undefined,snapshot:JSON.parse(r.snapshot_json),status:status(r),enabled_categories:[],setup_required:['Trusted business/source/account and own-principal connection binding','Server-trusted category eligibility verifier with current ownership, lease, holds, all-channel material and duplicate/unknown-effect evidence']};}
 return {
  enroll(a:Actor,raw:unknown){const p=enrollRoutineSchema.parse(raw);return db.transaction(()=>{
   owner(a,p.business_id);
   if(new Set(p.executor_ids).size!==p.executor_ids.length || new Set(p.categories).size!==p.categories.length)throw new BotError(400,'Duplicate executor or category');
   for(const id of p.executor_ids)executor(a,id,p.business_id);
   const snapshot={source_reference:p.source_reference,policy_text:p.policy_text,executor_ids:[...p.executor_ids].sort(),categories:[...p.categories].sort(),envelope:routineEnvelope};
   const hash=canonicalSha256(snapshot);
   const old=db.prepare('SELECT * FROM bot_routine_policies WHERE business_id=? AND request_key=?').get(p.business_id,p.request_key) as Row|undefined;
   if(old){if(old.snapshot_hash!==hash || old.policy_key!==p.policy_key || old.version!==p.expected_version+1 || old.issuer_id!==a.user.id)throw new BotError(409,'Enrollment request key conflict');return view(old);}
   const latest=db.prepare('SELECT COALESCE(MAX(version),0) version FROM bot_routine_policies WHERE business_id=? AND policy_key=?').get(p.business_id,p.policy_key) as {version:number};
   if(latest.version!==p.expected_version)throw new BotError(409,'Policy version changed; refresh before enrolling');
   const id=crypto.randomUUID();db.prepare('INSERT INTO bot_routine_policies(id,business_id,policy_key,version,issuer_id,request_key,snapshot_json,snapshot_hash) VALUES(?,?,?,?,?,?,?,?)').run(id,p.business_id,p.policy_key,p.expected_version+1,a.user.id,p.request_key,JSON.stringify(snapshot),hash);
   return view(read(id));
  }).immediate();},
  revoke(a:Actor,id:string,reason:string){return db.transaction(()=>{const r=read(id);owner(a,r.business_id);reason=z.string().trim().min(1).max(2000).parse(reason);const prior=db.prepare('SELECT reason FROM bot_routine_policy_revocations WHERE policy_id=?').get(id) as {reason:string}|undefined;if(prior && prior.reason!==reason)throw new BotError(409,'Revocation already recorded');db.prepare('INSERT OR IGNORE INTO bot_routine_policy_revocations(policy_id,actor_id,reason) VALUES(?,?,?)').run(id,a.user.id,reason);return view(r);}).immediate();},
  list(a:Actor,business:string){
   if(a.conversationId)executor(a,a.conversationId,business);else owner(a,business);
   return (db.prepare('SELECT * FROM bot_routine_policies WHERE business_id=? ORDER BY version DESC LIMIT 100').all(business) as Row[]).filter(r=>!a.conversationId || (JSON.parse(r.snapshot_json) as Input).executor_ids.includes(a.conversationId)).map(view);
  },
  inspect(a:Actor,raw:unknown){
   const p=z.object({policy_id:key,category:routineCategory,scope:approvedMessageSchema,proof_id:key.optional()}).strict().parse(raw);
   const r=read(p.policy_id);const c=executor(a,p.scope.executor_conversation_id,r.business_id);
   if(a.conversationId && (a.conversationId!==c.id || a.user.id!==c.user_id))throw new BotError(403,'Only the named own executor can inspect');
   if(!a.conversationId)owner(a,r.business_id);
   const snapshot=JSON.parse(r.snapshot_json) as Input;
   if(!snapshot.executor_ids.includes(c.id) || !snapshot.categories.includes(p.category))throw new BotError(403,'Executor or category outside enrolled scope');
   const missing=status(r)==='enrolled_setup_required'?[]:[`Policy is ${status(r)}`];
   missing.push(...view(r).setup_required);
   // Scope assertions alone never supply proof. A dedicated enrolled source may.
   if(p.proof_id){
    const verified=routineExecutionService(db).inspect(a,p.proof_id);
    if(verified.policy_id!==r.id || verified.category!==p.category || canonicalSha256(verified.scope)!==canonicalSha256(p.scope))throw new BotError(409,'Routine proof does not match exact requested scope');
    return {...verified,policy_version:r.version,policy_hash:r.snapshot_hash,missing_proof:[],enabled_categories:['missing_information']};
   }
   return {ready:false,execute:false,authorization_basis:'standing_policy',policy_id:r.id,policy_version:r.version,policy_hash:r.snapshot_hash,scope_hash:canonicalSha256({policy_id:r.id,policy_hash:r.snapshot_hash,category:p.category,scope:p.scope}),missing_proof:missing,enabled_categories:[]};
  },
 };
}
