import type Database from 'better-sqlite3';
import {z} from 'zod';
import {canonicalJson,canonicalSha256} from './canonical.js';
import {composeHash,uuid,hash,time,runtimeSchema,type ComposeAuthority} from './composedSmsContract.js';
import type {ComposeRegistration} from './composedSmsTrust.js';
import {BotError} from './service.js';
const revision=z.string().min(1).max(200);
export const guardManifestSchema=z.object({schemaVersion:z.literal('compose-sms-guards/v1'),sourceOrigin:z.literal('https://orderops-dev-web-production.up.railway.app'),runtime:runtimeSchema,implementationRevision:revision,migrationRevisions:z.array(revision).min(1).max(100),sourceRegistrationHash:hash,nativeContextContract:z.enum(['compose-sms-current-context/v1','compose-sms-current-context/v2']),normalizationPolicy:z.literal('sms-identity-utf8/v1'),recipientTimePolicy:z.object({id:revision,revision,evidenceReference:z.string().min(1).max(1000),startInclusive:z.literal('07:00'),endExclusive:z.literal('22:00'),timezoneEvidenceRequired:z.literal(true),unknownTimezone:z.literal('deny')}).strict(),coverage:z.array(z.object({guard:z.enum(['enrollment','lease','material','suppression','duplicate','holds','local_time']),records:z.array(z.object({table:revision,revisionFields:z.array(revision).min(1).max(100)}).strict()).min(1).max(100),writers:z.array(z.object({id:revision,revision}).strict()).min(1).max(100),serialization:z.object({mechanism:revision,lockOrder:z.array(revision).min(1).max(100)}).strict(),validationRevision:revision}).strict()).length(7)}).strict().refine(x=>new Set(x.coverage.map(c=>c.guard)).size===7,'Complete unique guard inventory required');
export const contextRecordSchema=z.object({kind:z.enum(['decision','instruction','composition','draft','delegation','routine']),id:z.string().min(1).max(200),revision:hash,status:z.string().min(1).max(100),scopeEvidenceId:uuid.nullable(),scopeStatus:z.enum(['unknown','current_action','completed']),blocking:z.boolean()}).strict();
export const currentContextSchema=z.object({schemaVersion:z.literal('compose-sms-current-context/v1'),registrationId:uuid,registrationRevision:z.number().int().positive().safe(),sourceRegistrationHash:hash,nativeActionId:uuid,authorityId:uuid,authorityRevision:z.literal(1),authorityHash:hash,businessId:uuid,ownerConversationId:uuid,executorConversationId:uuid,canonicalCaseId:uuid,contactCaseId:uuid,contextRevision:hash,scopeEvidenceRevision:hash,observedAt:time,expiresAt:time,complete:z.literal(true),holds:z.array(contextRecordSchema).max(5000),obligations:z.array(contextRecordSchema).max(5000),blockingIds:z.array(z.string().max(240)).max(5000),execute:z.literal(false)}).strict();
type Row=Record<string,unknown>;type RecordView=z.infer<typeof contextRecordSchema>;
// Append-only historical membership prevents moving a chat from erasing its obligations.
// Scope exclusions require a future separately accepted compose proof. Routine trust
// does not supply compose scope. Unknown rows are always explicit blockers.
export function composeCurrentContext(db:Database.Database,r:ComposeRegistration,a:ComposeAuthority,now:number,authorityExpiry:number){
 const rows=(sql:string,...args:unknown[])=>{const xs=db.prepare(sql).all(...args) as Row[];if(xs.length>5000||Buffer.byteLength(canonicalJson(xs))>1024*1024)throw new BotError(503,'Native context inventory exceeds bounded coverage');return xs;};
 const owner=`SELECT conversation_id FROM compose_context_memberships WHERE business_id=?`;
 const holds:RecordView[]=[],obligations:RecordView[]=[];const projection:unknown[]=[];
 const g=db.prepare('SELECT draft_id FROM bot_composed_sms_authorities WHERE id=?').get(a.authorityId) as {draft_id:string};
 function add(kind:RecordView['kind'],row:Row,audit:Row[],status:string,scopeStatus:RecordView['scopeStatus']='unknown'){
  const id=String(row.id??row.draft_id),revision=canonicalSha256({row,audit});projection.push({kind,id,row,audit});
  (kind==='decision'?holds:obligations).push({kind,id,revision,status,scopeEvidenceId:null,scopeStatus,blocking:scopeStatus==='unknown'});
 }
 for(const d of rows(`SELECT * FROM bot_decisions WHERE conversation_id IN (${owner}) ORDER BY id`,r.businessId)){
  const audit=rows('SELECT * FROM bot_decision_events WHERE decision_id=? ORDER BY rowid',d.id);
  const proof=rows(`SELECT p.*,g.proposal_hash,g.payload_hash,g.scope_json FROM bot_message_delivery_proofs p JOIN bot_message_drafts f ON f.id=p.draft_id JOIN bot_message_delegations g ON g.id=f.delegation_id WHERE g.decision_id=? AND g.decision_version=? AND f.state='sent'`,d.id,d.version);
  const exact=proof.some(p=>{try{const v=JSON.parse(String(p.proof_json)),scope=JSON.parse(String(p.scope_json));return p.proposal_hash===canonicalSha256(JSON.parse(String(d.proposal_json)))&&v.payload_hash===p.payload_hash&&p.payload_hash===canonicalSha256(scope)&&v.idempotency_key===`veneer-message:${p.draft_id}`&&v.account===scope.payload.account&&canonicalJson(v.recipients)===canonicalJson(scope.payload.recipients)&&v.canonical_case===scope.canonical_case&&v.provider_message_id===p.provider_message_id;}catch{return false;}});
  const completed=audit.some(e=>e.kind==='result'&&e.version===d.version&&e.actor_conversation_id===d.conversation_id&&e.payload_json===d.result_json);
  add('decision',d,[...audit,...proof],String(d.state),d.state==='verified_completed'&&completed&&exact?'completed':'unknown');
 }
 for(const d of rows(`SELECT * FROM bot_instruction_obligations WHERE owner_id IN (${owner}) ORDER BY id`,r.businessId)){
  const rev=rows('SELECT * FROM bot_instruction_obligation_revocations WHERE obligation_id=?',d.id);add('instruction',d,rev,rev.length?'revoked':'outstanding');
 }
 for(const d of rows(`SELECT * FROM bot_composed_sms_authorities WHERE owner_id IN (${owner}) OR executor_id IN (${owner}) ORDER BY id`,r.businessId,r.businessId)){
  const audit=rows('SELECT * FROM bot_composed_sms_events WHERE authority_id=? ORDER BY id',d.id),receipts=rows('SELECT p.* FROM bot_composed_sms_service_receipts p JOIN bot_composed_sms_associations x ON x.id=p.association_id WHERE x.authority_id=?',d.id);
  const revoked=audit.some(e=>e.kind==='revoked'),unknown=audit.some(e=>e.kind==='unknown');
  add('composition',d,[...audit,...receipts],revoked?'revoked':unknown?'unknown':receipts.length?'sent_accepted':'outstanding',d.id===a.authorityId?'current_action':receipts.length?'completed':'unknown');
 }
 for(const d of rows(`SELECT * FROM bot_message_drafts WHERE conversation_id IN (${owner}) ORDER BY id`,r.businessId)){
  const proof=rows('SELECT * FROM bot_message_delivery_proofs WHERE draft_id=?',d.id),retired=rows('SELECT * FROM bot_message_retirements WHERE draft_id=?',d.id);
  add('draft',d,[...proof,...retired],String(d.state),d.id===g.draft_id?'current_action':d.state==='sent'&&proof.length?'completed':'unknown');
 }
 for(const d of rows(`SELECT * FROM bot_message_delegations WHERE owner_conversation_id IN (${owner}) OR executor_conversation_id IN (${owner}) ORDER BY id`,r.businessId,r.businessId)){
  const audit=rows('SELECT * FROM bot_message_delegation_events WHERE delegation_id=? ORDER BY rowid',d.id),proof=rows('SELECT p.* FROM bot_message_delivery_proofs p JOIN bot_message_drafts d ON d.id=p.draft_id WHERE d.delegation_id=? AND d.state=\'sent\'',d.id);add('delegation',d,[...audit,...proof],proof.length?'sent':'outstanding',proof.length?'completed':'unknown');
 }
 for(const d of rows(`SELECT * FROM routine_draft_authorizations WHERE executor_id IN (${owner}) ORDER BY draft_id`,r.businessId)){
  const proof=rows('SELECT * FROM routine_delivery_readbacks WHERE draft_id=?',d.draft_id),claims=rows('SELECT * FROM routine_draft_claims WHERE draft_id=?',d.draft_id);add('routine',d,[...claims,...proof],proof.length?'sent':'outstanding',proof.length?'completed':'unknown');
 }
 for(const d of rows('SELECT * FROM compose_context_deleted_drafts WHERE business_id=? ORDER BY id',r.businessId))add('draft',{...d,id:`deleted:${d.id}:${d.draft_id}`},[],'deleted_unknown');
 const sort=(x:RecordView,y:RecordView)=>x.kind<y.kind?-1:x.kind>y.kind?1:x.id<y.id?-1:x.id>y.id?1:0;holds.sort(sort);obligations.sort(sort);
 if(holds.length+obligations.length>5000||Buffer.byteLength(canonicalJson(projection))>1024*1024)throw new BotError(503,'Native context inventory exceeds bounded coverage');
 const clock=db.prepare('SELECT revision FROM compose_context_clock WHERE singleton=1').get() as {revision:number};
 if(!Number.isSafeInteger(clock.revision))throw new BotError(503,'Native change revision unavailable');
 const acl={team:rows('SELECT * FROM business_teams WHERE id=?',r.businessId),members:rows('SELECT * FROM business_team_members WHERE team_id=? ORDER BY user_id',r.businessId),delegations:rows('SELECT * FROM business_delegations WHERE team_id=? ORDER BY conversation_id',r.businessId),conversations:rows(`SELECT id,user_id,business_team_id,archived,visibility FROM conversations WHERE id IN (${owner}) ORDER BY id`,r.businessId),users:rows(`SELECT id,status,role FROM users WHERE id IN (SELECT user_id FROM conversations WHERE id IN (${owner})) OR id=? ORDER BY id`,r.businessId,r.businessOwnerUserId),registrations:rows(`SELECT * FROM bot_registrations WHERE conversation_id IN (${owner}) ORDER BY conversation_id`,r.businessId)};
 // Hash actual absence explicitly. No source closure or classification is asserted.
 const scopeEvidenceRevision=composeHash('compose-sms-scope-evidence/v1',{adapter:null,records:[...holds,...obligations].map(x=>({kind:x.kind,id:x.id,scopeEvidenceId:x.scopeEvidenceId,scopeStatus:x.scopeStatus}))});
 const contextRevision=composeHash('compose-sms-current-context/v1',{clock:clock.revision,registrationHash:canonicalSha256(r),authorityHash:a.authorityHash,scopeEvidenceRevision,projection,acl});
 const result=currentContextSchema.parse({schemaVersion:'compose-sms-current-context/v1',registrationId:r.registrationId,registrationRevision:r.revision,sourceRegistrationHash:r.sourceRegistrationHash,nativeActionId:a.nativeActionId,authorityId:a.authorityId,authorityRevision:a.authorityRevision,authorityHash:a.authorityHash,businessId:a.businessId,ownerConversationId:a.ownerConversationId,executorConversationId:a.executorConversationId,canonicalCaseId:a.canonicalCaseId,contactCaseId:a.contactCaseId,contextRevision,scopeEvidenceRevision,observedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(now+5000,authorityExpiry,Date.parse(r.expiresAt))).toISOString(),complete:true,holds,obligations,blockingIds:[...holds,...obligations].filter(x=>x.blocking).map(x=>`${x.kind}:${x.id}`),execute:false});
 if(Buffer.byteLength(canonicalJson(result))>1024*1024)throw new BotError(503,'Native context response exceeds bounded coverage');
 return result;
}
