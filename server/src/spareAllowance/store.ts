import type Database from 'better-sqlite3';
import type { ConversationRow } from '../db/db.js';
import { canSendToConversation } from '../conversations/access.js';
import { canUserAccessModel } from '../routes/modelAccess.js';
import { eligibility, type SpareAccount } from './policy.js';

export interface SpareTask {
  id: string; request_key: string; user_id: number; conversation_id: string;
  title: string; prompt: string; output: string; provider: 'claude'|'codex'; model: string;
  account_ids_json: string; priority: number; max_batches: number; completed_batches: number;
  status: 'ready'|'paused'|'blocked'|'completed'; cursor: string|null;
}
export interface SpareRun {
  id: string; task_id: string; conversation_id: string; provider: 'claude'|'codex';
  account_id: string; cycle_reset: string; batch: number; deadline: string; turn_id: string|null;
  status: string; reason: string|null; checkpoint_json: string|null; usage_before: number;
  credential_revision: string|null;
}
export function spareRun(db: Database.Database, conversationId: string): SpareRun | undefined {
  return db.prepare("SELECT * FROM spare_allowance_runs WHERE conversation_id=? AND status IN ('queued','running')").get(conversationId) as SpareRun|undefined;
}
export function taskAllowed(db: Database.Database, task: SpareTask): ConversationRow | undefined {
  const owner = db.prepare("SELECT id,email,role,status FROM users WHERE id=?").get(task.user_id) as {id:number;email:string;role:string;status:string}|undefined;
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(task.conversation_id) as ConversationRow|undefined;
  if (!owner || owner.status !== 'active' || owner.role !== 'owner' || !conv || conv.archived || conv.provider !== task.provider || conv.model !== task.model || !canSendToConversation({id:owner.id,botSession:true},conv,db) || !canUserAccessModel(owner.email,task.provider,task.model)) return;
  if (!db.prepare('SELECT 1 FROM assistants WHERE id=? AND deleted_at IS NULL').get(conv.assistant_id)) return;
  if (db.prepare('SELECT 1 FROM coordination_lanes WHERE conversation_id=? UNION SELECT 1 FROM team_room_workers WHERE conversation_id=?').get(conv.id,conv.id)) return;
  return conv;
}
export function stopSpare(db: Database.Database, run: SpareRun, reason: string, status = 'unknown'): void {
  db.transaction(() => {
    db.prepare("UPDATE spare_allowance_runs SET status=?,reason=?,finished_at=datetime('now') WHERE id=? AND status IN ('queued','running')").run(status,reason,run.id);
    // An interruption might have created files or launched tools; never automatically replay it.
    db.prepare("UPDATE spare_allowance_tasks SET status='blocked' WHERE id=? AND status!='completed'").run(run.task_id);
  }).immediate();
}
export function spareBinding(db: Database.Database, id: string, conversationId: string, now = Date.now()): SpareRun | undefined {
  const run = db.prepare("SELECT * FROM spare_allowance_runs WHERE id=? AND conversation_id=? AND status IN ('queued','running')").get(id,conversationId) as SpareRun|undefined;
  if (!run) return;
  const task = db.prepare('SELECT * FROM spare_allowance_tasks WHERE id=?').get(run.task_id) as SpareTask;
  const row = db.prepare('SELECT snapshot_json FROM spare_allowance_accounts WHERE provider=? AND account_id=?').get(run.provider,run.account_id) as {snapshot_json:string}|undefined;
  const enabled = db.prepare('SELECT enabled FROM spare_allowance_settings WHERE id=1').get() as {enabled:number};
  const account: SpareAccount|undefined = row ? JSON.parse(row.snapshot_json) : undefined;
  const e = account ? eligibility(account,now) : undefined;
  if (!enabled.enabled || task.status !== 'ready' || !taskAllowed(db,task) || !JSON.parse(task.account_ids_json).includes(run.account_id) || Date.parse(run.deadline) <= now || e?.reason !== 'Eligible' || e.reset !== run.cycle_reset || (account?.credentialRevision ?? null)!==run.credential_revision) return;
  return run;
}
export function recordCheckpoint(db: Database.Database, conversationId: string, input: {outcome:'progress'|'completed'|'blocked';cursor:string|null;summary:string}): void {
  const run = spareRun(db,conversationId);
  if (!run || run.status !== 'running' || !spareBinding(db,run.id,conversationId)) throw new Error('No eligible running spare-allowance batch');
  const json = JSON.stringify(input);
  if (run.checkpoint_json && run.checkpoint_json !== json) throw new Error('Checkpoint already recorded');
  db.prepare('UPDATE spare_allowance_runs SET checkpoint_json=? WHERE id=? AND checkpoint_json IS NULL').run(json,run.id);
}
