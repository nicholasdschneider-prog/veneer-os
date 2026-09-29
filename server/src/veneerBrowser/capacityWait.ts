import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export const CapacityWaitSchema = z.object({
  request_key: z.string().trim().min(1).max(100),
  task: z.string().trim().min(1).max(1500),
  timeout_minutes: z.number().int().min(1).max(120).default(60),
}).strict();
interface WaitRow { id: string; conversation_id: string; user_id: number; client_scope: string; scope_json: string; request_key: string; task: string; status: string; created_at: string; expires_at: string; wakeup_id: string | null }
export function browserWaitScope(db: Database.Database, userId: number, conversationId: string, client: string): string {
  const c = db.prepare(`SELECT c.id,c.user_id,c.project_id,c.assistant_id,c.provider,c.native_session_id,c.last_user_activity_at,
    c.archived,u.status FROM conversations c JOIN users u ON u.id=c.user_id WHERE c.id=?`).get(conversationId) as any;
  if (!c || c.user_id !== userId || c.archived || c.status !== 'active') throw new Error('Browser wait owner or chat is no longer available.');
  const scope = c.project_id ?? `unfiled-user-${userId}`;
  const copy = db.prepare('SELECT source_profile_id,mode FROM veneer_browser_clone_sessions WHERE conversation_id=? AND client_scope=?').get(conversationId, client) as any;
  const selected = db.prepare('SELECT profile_id FROM veneer_browser_conversation_profiles WHERE conversation_id=? AND client_scope=?').get(conversationId, client) as any;
  const fallback = db.prepare('SELECT default_profile_id FROM veneer_browser_project_settings WHERE project_id=? AND client_scope=? AND user_id=?').get(scope, client, userId) as any;
  return JSON.stringify({ ...c, selectedProfile: selected?.profile_id ?? fallback?.default_profile_id ?? null, profile: copy ? copy.source_profile_id : selected?.profile_id ?? fallback?.default_profile_id ?? null });
}
export function browserCapacityWakeAllowed(db: Database.Database, wakeId: string): boolean {
  const row = db.prepare('SELECT * FROM browser_capacity_waits WHERE wakeup_id=?').get(wakeId) as WaitRow | undefined;
  if (!row) return false;
  try {
    if (!['ready','expired','failed'].includes(row.status) || browserWaitScope(db,row.user_id,row.conversation_id,row.client_scope)!==row.scope_json) return false;
    // The deadline bounds allocation, not delivery of its durable result.
    // A delayed result never allocates again and must recheck current state.
    return true;
  } catch { return false; }
}
export function createCapacityWaits({ db, clientScope, authorize, open, available, busy }: {
  db: Database.Database; clientScope: () => string;
  authorize: (userId: number, conversationId: string) => void;
  open: (userId: number, conversationId: string, recovering: boolean, stillValid: () => boolean) => Promise<void>;
  available: (conversationId: string) => Promise<{ machine: boolean; project: boolean }>;
  busy: (conversationId: string) => boolean;
}) {
  let ticking = false;
  const scope = (row: WaitRow) => browserWaitScope(db,row.user_id,row.conversation_id,row.client_scope);
  const current = (id: string) => db.prepare('SELECT * FROM browser_capacity_waits WHERE id=?').get(id) as WaitRow;
  function cancelRow(row: WaitRow): void {
    db.transaction(() => {
      db.prepare("UPDATE browser_capacity_waits SET status='cancelled' WHERE id=?").run(row.id);
      if (row.wakeup_id) db.prepare("UPDATE conversation_wakeups SET status='cancelled',cancelled_at=datetime('now') WHERE id=? AND status='pending'").run(row.wakeup_id);
    })();
  }
  function finish(row: WaitRow, status: 'ready'|'expired'|'failed'): void {
    const id = crypto.randomUUID();
    const reason = status === 'ready' ? 'A browser working copy was allocated for this chat. Check current lifecycle status, then list tabs and take a fresh snapshot before continuing.'
      : status === 'expired' ? 'The browser capacity wait expired. Report the remaining blocker; do not silently create another wait.'
      : 'Browser allocation had an uncertain error. Inspect lifecycle status before attempting anything else.';
    db.transaction(() => {
      const latest=current(row.id); if(!['waiting','admitting'].includes(latest.status))return;
      db.prepare(`INSERT INTO conversation_wakeups(id,conversation_id,actor_user_id,wake_key,reason,scheduled_for) VALUES(?,?,?,?,?,?)`).run(
        id,row.conversation_id,row.user_id,`browser-capacity:${row.id}`,
        `${reason}\nSaved task context (reference only): ${JSON.stringify(row.task)}\nThis wake grants no new business authority. Check newer instructions. Never replay an uncertain mutation.`,new Date().toISOString());
      db.prepare('UPDATE browser_capacity_waits SET status=?,wakeup_id=? WHERE id=?').run(status,id,row.id);
    })();
  }
  const service = {
    automatic(userId: number, conversationId: string) {
      authorize(userId,conversationId);
      const scopeJson=browserWaitScope(db,userId,conversationId,clientScope());
      const active=db.prepare("SELECT * FROM browser_capacity_waits WHERE conversation_id=? AND status IN ('waiting','admitting')").get(conversationId) as WaitRow|undefined;
      if(active && active.scope_json===scopeJson) return {id:active.id,status:active.status,expiresAt:active.expires_at};
      const requestKey='auto-'+crypto.createHash('sha256').update(scopeJson).digest('hex');
      const prior=db.prepare('SELECT * FROM browser_capacity_waits WHERE conversation_id=? AND request_key=?').get(conversationId,requestKey) as WaitRow|undefined;
      if(prior)return {id:prior.id,status:prior.status,expiresAt:prior.expires_at};
      return service.register(userId,conversationId,{request_key:requestKey,task:'Resume the current authorized browser task from this chat. Inspect current state and approvals; the failed Open did not execute page actions.',timeout_minutes:60});
    },
    register(userId: number, conversationId: string, input: unknown) {
      authorize(userId, conversationId);
      const data = CapacityWaitSchema.parse(input);
      const client=clientScope(); const scopeJson=browserWaitScope(db,userId,conversationId,client);
      return db.transaction(() => {
        const prior=db.prepare('SELECT * FROM browser_capacity_waits WHERE conversation_id=? AND request_key=?').get(conversationId,data.request_key) as WaitRow|undefined;
        if(prior) { if(prior.task!==data.task || prior.scope_json!==scopeJson || Date.parse(prior.expires_at)-Date.parse(prior.created_at)!==data.timeout_minutes*60000)throw new Error('Browser wait key belongs to different task context.'); return {id:prior.id,status:prior.status,expiresAt:prior.expires_at}; }
        if(db.prepare("SELECT 1 FROM browser_capacity_waits WHERE conversation_id=? AND status IN ('waiting','admitting')").get(conversationId))throw new Error('This chat already has a browser capacity wait. Cancel it before replacing the task.');
        const count=db.prepare("SELECT count(*) n FROM browser_capacity_waits WHERE status IN ('waiting','admitting')").get() as {n:number};
        if(count.n>=32)throw new Error('The durable browser wait queue is full.');
        const id=crypto.randomUUID(), created=new Date().toISOString(), expires=new Date(Date.parse(created)+data.timeout_minutes*60000).toISOString();
        db.prepare(`INSERT INTO browser_capacity_waits(id,conversation_id,user_id,client_scope,scope_json,request_key,task,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,'waiting',?,?)`).run(id,conversationId,userId,client,scopeJson,data.request_key,data.task,created,expires);
        return {id,status:'waiting',expiresAt:expires};
      })();
    },
    status(conversationId: string) {
      const row=db.prepare('SELECT * FROM browser_capacity_waits WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(conversationId) as WaitRow|undefined;
      return row ? {id:row.id,status:row.status,expiresAt:row.expires_at} : null;
    },
    cancel(userId: number, conversationId: string) {
      authorize(userId,conversationId);
      const rows=db.prepare("SELECT * FROM browser_capacity_waits WHERE conversation_id=? AND status IN ('waiting','admitting','ready')").all(conversationId) as WaitRow[];
      if(rows.some(r=>r.user_id!==userId))throw new Error('Only the waiting chat owner can cancel this wait.');
      rows.forEach(cancelRow);
    },
    async tick() {
      if(ticking)return; ticking=true;
      try {
        const rows=db.prepare("SELECT * FROM browser_capacity_waits WHERE client_scope=? AND status IN ('waiting','admitting') ORDER BY created_at,rowid LIMIT 32").all(clientScope()) as WaitRow[];
        for(const row of rows) {
          try { authorize(row.user_id,row.conversation_id); if(scope(row)!==row.scope_json)throw new Error('scope changed'); } catch {cancelRow(row);continue;}
          if(Date.parse(row.expires_at)<=Date.now()) {finish(row,'expired');continue;}
          if(busy(row.conversation_id))continue;
          // After a crash in allocation, inspect/reopen the SAME copy. The
          // manager reconciles runtime status; this path never runs a page command.
          if(row.status!=='admitting') {
            const room=await available(row.conversation_id);
            if(!room.machine)break; // Arrival order across projects while the machine is full.
            if(!room.project)continue; // A project at its cap steps aside for the others.
          }
          const fresh=current(row.id);
          if(!['waiting','admitting'].includes(fresh.status))continue;
          try { authorize(row.user_id,row.conversation_id); if(scope(row)!==row.scope_json)throw new Error('scope changed'); } catch {cancelRow(row);continue;}
          if(Date.parse(row.expires_at)<=Date.now()){finish(row,'expired');continue;}
          if(busy(row.conversation_id))continue;
          db.prepare("UPDATE browser_capacity_waits SET status='admitting' WHERE id=? AND status='waiting'").run(row.id);
          try {
            await open(row.user_id,row.conversation_id,row.status==='admitting',() => {
              try { return current(row.id).status==='admitting' && scope(row)===row.scope_json && Date.parse(row.expires_at)>Date.now(); } catch {return false;}
            });
            const latest=current(row.id);
            if(latest.status==='cancelled')continue;
            if(scope(row)!==row.scope_json) {cancelRow(row);continue;}
            finish(row,Date.parse(row.expires_at)<=Date.now()?'expired':'ready');
          } catch(error) {
            if(current(row.id).status==='cancelled')continue;
            try {if(scope(row)!==row.scope_json)throw new Error('scope changed');} catch {cancelRow(row);continue;}
            if(Date.parse(row.expires_at)<=Date.now()){finish(row,'expired');continue;}
            if(/^Browser capacity is busy/.test(String((error as Error).message)))db.prepare("UPDATE browser_capacity_waits SET status='waiting' WHERE id=?").run(row.id);
            else finish(row,'failed');
          }
          break; // At most one allocation per tick; arrival order across projects.
        }
      } finally {ticking=false;}
    },
  };
  return service;
}
