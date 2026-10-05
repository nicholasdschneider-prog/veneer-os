import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError } from '../bots/service.js';

export const PurchaseEvent = z.object({
  schema_version: z.literal('lippert.purchase_candidate/v1'),
  type: z.literal('order.purchase_candidate'),
  id: z.string().uuid(), task_id: z.string().uuid(), order_id: z.string().uuid(),
  order_revision: z.string().regex(/^[a-f0-9]{64}$/), occurred_at: z.string().datetime(),
}).strict();
export function canonicalPurchasePayload(payload: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map(k => [k, payload[k]])));
}
export function purchaseBinding(db: Database.Database, sourceId: string) {
  return db.prepare(`SELECT b.* FROM purchase_event_bindings b
    JOIN bot_event_sources s ON s.id=b.source_id AND s.team_id=b.team_id AND s.created_by=b.owner_id
    JOIN business_teams team ON team.id=b.team_id AND team.owner_id=b.owner_id
    JOIN users u ON u.id=b.owner_id AND u.status='active'
    JOIN scheduled_tasks t ON t.id=b.task_id AND t.user_id=b.owner_id AND t.project_id=b.project_id AND t.trigger_kind='schedule'
    JOIN projects p ON p.id=b.project_id
    WHERE b.source_id=? AND s.enabled=1 AND t.enabled=1`).get(sourceId) as
    { source_id: string; task_id: string; team_id: string; owner_id: number; project_id: string } | undefined;
}
export function pendingPurchaseBatch(db: Database.Database, source: string, task: string): string {
  const existing = db.prepare("SELECT id FROM purchase_event_batches WHERE task_id=? AND status='pending'").get(task) as {id:string}|undefined;
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO purchase_event_batches(id,source_id,task_id,status,created_at) VALUES(?,?,?,'pending',?)").run(id,source,task,new Date().toISOString());
  return id;
}
export function acceptPurchaseEvent(db: Database.Database, sourceId: string, input: unknown) {
  const p = PurchaseEvent.parse(input);
  const json = canonicalPurchasePayload(p);
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  return db.transaction(() => {
    const binding = purchaseBinding(db, sourceId);
    if (!binding || binding.task_id !== p.task_id) throw new BotError(403,'PURCHASE_BINDING_UNAVAILABLE');
    if (Date.parse(p.occurred_at)>Date.now()+300000) throw new BotError(400,'FUTURE_EVENT');
    const old = db.prepare('SELECT payload_hash,receipt_json FROM purchase_event_receipts WHERE source_id=? AND event_id=?').get(sourceId,p.id) as {payload_hash:string;receipt_json:string}|undefined;
    if (old) {
      if (old.payload_hash !== hash) throw new BotError(409,'EVENT_ID_CONFLICT');
      return JSON.parse(old.receipt_json);
    }
    const backlog = db.prepare(`SELECT count(*) AS n FROM purchase_event_links l JOIN purchase_event_batches b ON b.id=l.batch_id WHERE b.task_id=? AND b.status='pending'`).get(p.task_id) as {n:number};
    if (backlog.n>=256) throw new BotError(409,'PURCHASE_BACKLOG_FULL');
    const receipt = {schema_version:'lippert.purchase_candidate_receipt/v1',receipt_id:crypto.randomUUID(),source_id:sourceId,event_id:p.id,task_id:p.task_id,order_id:p.order_id,order_revision:p.order_revision,payload_hash:hash,accepted_at:new Date().toISOString(),status:'accepted',purchase_authority:false};
    db.prepare('INSERT INTO purchase_event_receipts VALUES(?,?,?,?,?)').run(sourceId,p.id,hash,json,JSON.stringify(receipt));
    db.prepare('INSERT INTO purchase_event_links VALUES(?,?,?)').run(sourceId,p.id,pendingPurchaseBatch(db,sourceId,p.task_id));
    return receipt;
  }).immediate();
}
export function readPurchaseEvent(db: Database.Database, sourceId: string, eventId: string) {
  z.string().uuid().parse(eventId);
  // Revocation/current membership fails closed even for retained readback.
  if (!purchaseBinding(db,sourceId)) throw new BotError(403,'PURCHASE_BINDING_UNAVAILABLE');
  const row = db.prepare(`SELECT r.receipt_json,b.id AS batch_id,b.status,b.blocked_reason,b.run_id,
    run.conversation_id,run.status AS run_status,start.turn_id,start.started_at
    FROM purchase_event_receipts r JOIN purchase_event_links l USING(source_id,event_id)
    JOIN purchase_event_batches b ON b.id=l.batch_id LEFT JOIN scheduled_task_runs run ON run.id=b.run_id
    LEFT JOIN purchase_worker_starts start ON start.run_id=b.run_id WHERE r.source_id=? AND r.event_id=?`).get(sourceId,eventId) as
    {receipt_json:string;batch_id:string;status:string;blocked_reason:string|null;run_id:string|null;conversation_id:string|null;run_status:string|null;turn_id:string|null;started_at:string|null}|undefined;
  if (!row) throw new BotError(404,'PURCHASE_EVENT_NOT_FOUND');
  const fenced = db.prepare("SELECT blocked_reason FROM purchase_event_batches WHERE task_id=(SELECT task_id FROM purchase_event_bindings WHERE source_id=?) AND status='blocked' LIMIT 1").get(sourceId) as {blocked_reason:string|null}|undefined;
  return {receipt:JSON.parse(row.receipt_json),delivery:{status:row.status==='pending' && fenced?'blocked':row.status,batch_id:row.batch_id,run_id:row.run_id,conversation_id:row.conversation_id,run_status:row.run_status,worker_started:!!row.turn_id,worker_started_at:row.started_at,turn_id:row.turn_id,blocked_reason:row.blocked_reason ?? (row.status==='pending' && fenced?fenced.blocked_reason:null),purchase_authority:false}};
}
/** Exact current worker's scheduling acknowledgment, never purchasing authorization. */
export function recordPurchasePass(db: Database.Database, conversationId: string, actorId: number, input: unknown) {
  const p=z.object({outcome:z.enum(['clear','blocked','unknown']),cursor:z.string().max(500).nullable().default(null)}).strict().parse(input);
  return db.transaction(()=>{
    const run=db.prepare(`SELECT r.id,b.source_id,b.status FROM scheduled_task_runs r JOIN purchase_event_batches b ON b.run_id=r.id
      JOIN scheduled_tasks t ON t.id=r.scheduled_task_id AND t.user_id=? JOIN purchase_worker_starts start ON start.run_id=r.id
      WHERE r.conversation_id=? AND r.status='running'`).get(actorId,conversationId) as {id:string;source_id:string;status:string}|undefined;
    if(!run || run.status==='blocked' || !purchaseBinding(db,run.source_id)) throw new BotError(403,'PURCHASE_WORKER_UNAVAILABLE');
    const old=db.prepare('SELECT outcome,cursor FROM purchase_worker_passes WHERE run_id=?').get(run.id) as {outcome:string;cursor:string|null}|undefined;
    if(old && (old.outcome!==p.outcome || old.cursor!==p.cursor)) throw new BotError(409,'PURCHASE_PASS_CONFLICT');
    if(!old)db.prepare('INSERT INTO purchase_worker_passes VALUES(?,?,?,?,?)').run(run.id,conversationId,p.outcome,p.cursor,new Date().toISOString());
    if(p.outcome!=='clear')db.prepare("UPDATE purchase_event_batches SET status='blocked',blocked_reason=? WHERE run_id=?").run(p.outcome==='unknown'?'SOURCE_UNKNOWN':'SOURCE_BLOCKED',run.id);
    return {recorded:true,run_id:run.id,outcome:p.outcome,purchase_authority:false};
  }).immediate();
}
