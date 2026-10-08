import fs from 'node:fs';
import path from 'node:path';
import { claudeSessionFilePath } from '../providers/claude/transcript.js';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError } from '../bots/service.js';
import { canViewConversation } from '../conversations/access.js';
import type { ConversationRow } from '../db/db.js';
import { transcriptArchivePath } from '../runtime/transcriptArchive.js';
import { isClaudeSessionLimitMessage } from '../providers/claude/rateLimitMessage.js';
import { purchaseBinding } from './purchaseEvents.js';

// Startup failures keep their original run, batch and hinted orders permanently blocked.
// Only a separately reviewed disposition removes their task-wide successor fence.

const Input = z.object({run_id:z.string().uuid(), mode:z.enum(['inspect','reconcile']),
 expected_hash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
 coordination_reference:z.string().trim().min(1).max(1000).optional()}).strict();
const metadataTypes = new Set(['queue-operation','atis-latch','last-prompt','cost-state']);
const attachmentTypes = new Set(['environment','model','output_style_instructions','deferred_tools_delta',
 'agent_listing_delta','mcp_instructions_delta','skill_listing','auto_mode','total_tokens_reminder',
 'output_style','instructions','session_context','date','remote_session_change','prompt_snapshot']);

/** Reads only the server-owned full native archive; never takes supplied transcript/proof bytes. */
export function reconcilePurchaseStartup(db: Database.Database, dataDir: string, actorId: number,
 actorConversationId: string | undefined, input: unknown) {
 const p=Input.parse(input);
 return db.transaction(()=>{
  const r=db.prepare(`SELECT r.*,b.id batch_id,b.source_id,b.status batch_status,b.blocked_reason,
    c.native_session_id,c.provider FROM scheduled_task_runs r JOIN purchase_event_batches b ON b.run_id=r.id
    JOIN conversations c ON c.id=r.conversation_id WHERE r.id=?`).get(p.run_id) as
    {id:string;scheduled_task_id:string;conversation_id:string;status:string;error:string;started_at:string;finished_at:string;
     batch_id:string;source_id:string;batch_status:string;blocked_reason:string;native_session_id:string;provider:string}|undefined;
  if(!r) throw new BotError(404,'PURCHASE_RUN_NOT_FOUND');
  const binding=purchaseBinding(db,r.source_id);
  const user=db.prepare('SELECT role,status FROM users WHERE id=?').get(actorId) as {role:string;status:string}|undefined;
  const original=db.prepare('SELECT * FROM conversations WHERE id=?').get(r.conversation_id) as ConversationRow;
  if(!binding || binding.owner_id!==actorId || user?.role!=='owner' || user.status!=='active'
    || !canViewConversation({id:actorId,botSession:!!actorConversationId},original,db)) throw new BotError(403,'PURCHASE_RECONCILIATION_ACCESS');
  if(actorConversationId){
   const caller=db.prepare(`SELECT c.*,a.slug FROM conversations c JOIN assistants a ON a.id=c.assistant_id WHERE c.id=?`).get(actorConversationId) as (ConversationRow & {slug:string})|undefined;
   if(!caller || caller.user_id!==actorId || caller.slug!=='platform-dev'
    || !canViewConversation({id:actorId,botSession:true},caller,db)) throw new BotError(403,'PLATFORM_DEV_REQUIRED');
  }
  if(r.provider!=='claude' || r.status!=='failed' || r.batch_status!=='blocked'
    || !['WORKER_OUTCOME_UNRESOLVED','WORKER_FAILED'].includes(r.blocked_reason)
    || !r.finished_at || !z.string().uuid().safeParse(r.native_session_id).success
    || db.prepare('SELECT 1 FROM purchase_worker_passes WHERE run_id=?').get(r.id)
    || db.prepare("SELECT 1 FROM pending_turns WHERE conversation_id=? AND status='pending'").get(r.conversation_id)) throw new BotError(409,'STARTUP_FAILURE_NOT_PROVEN');
  const file=transcriptArchivePath(dataDir,'claude',r.native_session_id);
  let bytes:Buffer;
  try { const stat=fs.lstatSync(file);if(!stat.isFile() || stat.size>1024*1024) throw Error();bytes=fs.readFileSync(file); }
  catch { throw new BotError(409,'COMPLETE_NATIVE_ARCHIVE_REQUIRED'); }
  let rows:Record<string,any>[];
  try {rows=bytes.toString('utf8').trim().split('\n').map(line=>JSON.parse(line));}
  catch {throw new BotError(409,'COMPLETE_NATIVE_ARCHIVE_REQUIRED');}
  const users=rows.filter(row=>row.type==='user'), assistants=rows.filter(row=>row.type==='assistant');
  const start=Date.parse(r.started_at.replace(' ','T')+'Z'),end=Date.parse(r.finished_at.replace(' ','T')+'Z')+1000;
  if(users.length!==1 || assistants.length!==1 || !Number.isFinite(start) || !Number.isFinite(end)
    || rows.some(row=>row.sessionId!==r.native_session_id || row.isSidechain || row.toolUseResult || row.parent_tool_use_id
     || (row.type==='attachment' ? !attachmentTypes.has(row.attachment?.type)
      : !['user','assistant'].includes(row.type as string) && !metadataTypes.has(row.type as string)))
    || [users[0],assistants[0]].some(row=>!row || Date.parse(row.timestamp)<start || Date.parse(row.timestamp)>end || !Number.isFinite(Date.parse(row.timestamp))
     || !Array.isArray(row.message?.content) || !row.message.content.length || row.message.content.some((b:any)=>b.type!=='text' || typeof b.text!=='string')))
    throw new BotError(409,'STARTUP_FAILURE_NOT_PROVEN');
  // Compare the full retained archive with the current native session, never a tail.
  // Missing native provenance cannot be retroactively declared complete.
  try {
   if(typeof users[0]!.cwd!=='string' || !path.isAbsolute(users[0]!.cwd)) throw Error();
   const native=claudeSessionFilePath(users[0]!.cwd,r.native_session_id);
   const stat=fs.lstatSync(native);
   if(!stat.isFile() || stat.size!==bytes.length || !fs.readFileSync(native).equals(bytes)) throw Error();
  } catch {throw new BotError(409,'CURRENT_NATIVE_ARCHIVE_MISMATCH');}
  const assistant=assistants[0]!;
  const text=assistant.message.content.map((b:any)=>b.text).join('\n\n');
  if(assistant.isApiErrorMessage!==true || assistant.apiErrorStatus!==429 || assistant.error!=='rate_limit'
    || assistant.message.model!=='<synthetic>' || !isClaudeSessionLimitMessage(text,assistant) || text!==r.error
    || assistant.message.role!=='assistant' || users[0]!.message.role!=='user'
    || Date.parse(assistant.timestamp)<Date.parse(users[0]!.timestamp)) throw new BotError(409,'STARTUP_FAILURE_NOT_PROVEN');
  const nativeStart=db.prepare('SELECT * FROM purchase_worker_starts WHERE run_id=? AND conversation_id=?').get(r.id,r.conversation_id);
  const hinted=db.prepare('SELECT l.event_id FROM purchase_event_links l WHERE l.batch_id=?').all(r.batch_id) as {event_id:string}[];
  const prompt=users[0]!.message.content.map((b:any)=>b.text).join('\n\n');
  if(!nativeStart || !prompt.includes(r.scheduled_task_id) || hinted.some(h=>!prompt.includes(h.event_id))) throw new BotError(409,'STARTUP_NATIVE_BINDING_REQUIRED');
  // The manager permanently refuses this blocked original chat, including its retained
  // unconsumed continuation. Pin that queue; never consume, cancel or resume it here.
  const queued=db.prepare('SELECT * FROM queued_messages WHERE conversation_id=? ORDER BY id').all(r.conversation_id);
  // Hash also pins all current native run and permission material reviewed above.
  const hash=crypto.createHash('sha256').update(bytes).update(JSON.stringify({r,binding,nativeStart,hinted,queued})).digest('hex');
  const schemaReady=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_startup_dispositions'").get();
  if(p.mode==='reconcile' && !schemaReady) throw new BotError(409,'STARTUP_DISPOSITION_INSTALL_REQUIRED');
  const old=(schemaReady ? db.prepare('SELECT * FROM purchase_startup_dispositions WHERE run_id=?').get(r.id) : undefined) as {evidence_hash:string}|undefined;
  if(old && old.evidence_hash!==hash) throw new BotError(409,'STARTUP_EVIDENCE_CHANGED');
  if(p.mode==='reconcile'){
   if(p.expected_hash!==hash || !p.coordination_reference) throw new BotError(409,'FRESH_STARTUP_REVIEW_REQUIRED');
   if(!old) db.prepare('INSERT INTO purchase_startup_dispositions VALUES(?,?,?,?,?,?,?,?)').run(r.id,r.batch_id,r.conversation_id,hash,actorId,actorConversationId??null,p.coordination_reference,new Date().toISOString());
  }
  return {run_id:r.id,conversation_id:r.conversation_id,batch_id:r.batch_id,disposition:'failed_before_model_execution',
   retained_queued_messages:queued.length,schema_ready:schemaReady,evidence_hash:hash,reconciled:!!old || p.mode==='reconcile',original_status:r.status,original_blocked_reason:r.blocked_reason,
   failed_hints_remain_fenced:true,purchase_authority:false,execute:false};
 }).immediate();
}
