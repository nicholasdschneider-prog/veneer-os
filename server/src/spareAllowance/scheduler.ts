import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConversationManager } from '../runtime/conversationManager.js';
import { businessHours, eligibility, type SpareAccount } from './policy.js';
import { spareBinding, stopSpare, taskAllowed, type SpareRun, type SpareTask } from './store.js';

export function normalWorkWaiting(db: Database.Database): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM pending_turns p WHERE NOT EXISTS
    (SELECT 1 FROM spare_allowance_runs r WHERE r.conversation_id=p.conversation_id AND r.status IN ('queued','running'))
    UNION SELECT 1 FROM queued_messages q WHERE COALESCE(json_extract(q.origin_json,'$.spareRunId'),'')='' LIMIT 1`).get());
}
export function createSpareScheduler(opts: {
  db: Database.Database; manager: ConversationManager;
  loadAccounts: () => Promise<SpareAccount[]>; now?: () => number;
}) {
  const {db,manager} = opts;
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setInterval>|undefined;
  let refreshing = false;
  let lastRefresh = 0;
  const active = () => db.prepare("SELECT * FROM spare_allowance_runs WHERE status IN ('queued','running')").get() as SpareRun|undefined;
  function stop(run: SpareRun, reason: string) {
    stopSpare(db,run,reason);
    manager.interrupt(run.conversation_id,'timeout');
  }
  function monitor() {
    const run = active();
    if (!run) return;
    if (normalWorkWaiting(db)) return stop(run,'Normal work takes priority; reconcile saved output before continuing');
    if (!spareBinding(db,run.id,run.conversation_id,now())) return stop(run,'Paused at time, allowance, account, or task boundary; reconcile saved output');
    if (manager.statusOf(run.conversation_id) === 'needs_you') stop(run,'Approval or input needed; optional work paused');
  }
  function terminal(conversationId: string, event: {type:string;outcome?:string}) {
    if (event.type !== 'turn_done') return;
    const run = active();
    if (!run || run.conversation_id !== conversationId) return;
    if (event.outcome !== 'completed' || !run.checkpoint_json) return stopSpare(db,run,'Batch did not complete with an explicit checkpoint; reconcile before continuing');
    const checkpoint = JSON.parse(run.checkpoint_json) as {outcome:string;cursor:string|null;summary:string};
    db.transaction(() => {
      const snapshot = db.prepare('SELECT snapshot_json FROM spare_allowance_accounts WHERE provider=? AND account_id=?').get(run.provider,run.account_id) as {snapshot_json:string}|undefined;
      const windows = snapshot ? (JSON.parse(snapshot.snapshot_json) as SpareAccount).windows : [];
      db.prepare("UPDATE spare_allowance_runs SET status=?,reason=?,finished_at=datetime('now'),usage_after=? WHERE id=?").run(checkpoint.outcome === 'blocked' ? 'blocked' : 'completed',checkpoint.summary,windows.length ? Math.max(...windows.map(w=>w.usedPercent)) : null,run.id);
      const task = db.prepare('SELECT * FROM spare_allowance_tasks WHERE id=?').get(run.task_id) as SpareTask;
      const count = task.completed_batches + (checkpoint.outcome === 'blocked' ? 0 : 1);
      const status = checkpoint.outcome === 'blocked' ? 'blocked' : checkpoint.outcome === 'completed' ? 'completed' : count >= task.max_batches ? 'blocked' : task.status;
      db.prepare('UPDATE spare_allowance_tasks SET completed_batches=?,cursor=?,status=? WHERE id=?').run(count,checkpoint.cursor,status,task.id);
    }).immediate();
    // Each successor requires a new genuine usage read.
    lastRefresh = 0;
  }
  async function tick() {
    monitor();
    if (refreshing || now()-lastRefresh < 10_000) return;
    const enabled = db.prepare('SELECT enabled FROM spare_allowance_settings WHERE id=1').get() as {enabled:number};
    if (!enabled.enabled || businessHours(now()) || normalWorkWaiting(db)) return;
    const tasks = db.prepare("SELECT * FROM spare_allowance_tasks WHERE status='ready' AND completed_batches<max_batches ORDER BY priority DESC,created_at,id").all() as SpareTask[];
    if (!tasks.length) return;
    refreshing = true;
    try {
      const accounts = await opts.loadAccounts();
      lastRefresh = now();
      db.transaction(() => {
        db.prepare('DELETE FROM spare_allowance_accounts').run();
        for (const account of accounts) db.prepare('INSERT INTO spare_allowance_accounts VALUES(?,?,?,?,?)').run(account.provider,account.accountId,JSON.stringify(account),eligibility(account,now()).reason,new Date(now()).toISOString());
      }).immediate();
      monitor();
      if (active() || normalWorkWaiting(db) || businessHours(now())) return;
      for (const task of tasks) {
        const conv = taskAllowed(db,task);
        if (!conv || manager.statusOf(conv.id) !== 'idle' || manager.queueSnapshot(conv.id).messages.length) continue;
        for (const account of accounts) {
          if (account.provider !== task.provider || !(JSON.parse(task.account_ids_json) as string[]).includes(account.accountId)) continue;
          const e = eligibility(account,now());
          if (e.reason !== 'Eligible') continue;
          const id = crypto.randomUUID();
          const batch = task.completed_batches+1;
          const reserved = db.transaction(() => {
            if (active() || normalWorkWaiting(db) || !db.prepare("SELECT 1 FROM spare_allowance_settings WHERE enabled=1").get() || !db.prepare("SELECT 1 FROM spare_allowance_tasks WHERE id=? AND status='ready' AND completed_batches=?").get(task.id,task.completed_batches)) return false;
            if (db.prepare('SELECT 1 FROM spare_allowance_runs WHERE task_id=? AND batch=?').get(task.id,batch)) return false;
            db.prepare("INSERT INTO spare_allowance_runs(id,task_id,conversation_id,provider,account_id,cycle_reset,credential_revision,batch,deadline,status,usage_before) VALUES(?,?,?,?,?,?,?,?,?,'queued',?)").run(id,task.id,conv.id,task.provider,account.accountId,e.reset,account.credentialRevision ?? null,batch,e.deadline,e.used);
            return true;
          }).immediate();
          if (!reserved) continue;
          try {
            manager.postMessage(conv,`[Optional spare-allowance batch ${batch}/${task.max_batches}]\nTask: ${task.title}\nRequired output: ${task.output}\n${task.prompt}\nSaved checkpoint: ${task.cursor ?? 'none'}\n\nWork in one small resumable batch. Deadline ${e.deadline}. Save useful artifacts before that deadline. Do not publish, purchase, use paid credits/API keys, send messages, or launch detached jobs. Do not change shared source without its build slot. Preserve original bot identity and approvals. Missing source geometry is a blocker, never invent it. Stop when the deliverable is done; do not manufacture extra work. As the LAST action call record_spare_checkpoint with outcome progress|completed|blocked, a nonsecret cursor and an evidence-grounded summary; then finish. Without that checkpoint, automatic continuation is blocked.`,task.user_id,{kind:'wakeup',from:'Spare allowance',to:task.title,spareRunId:id});
          } catch {
            const run = active(); if (run?.id===id) stopSpare(db,run,'Dispatch outcome unknown; do not retry');
          }
          return;
        }
      }
    } catch {
      lastRefresh = now();
      const run = active(); if (run) stop(run,'Usage refresh unavailable');
    } finally { refreshing = false; }
  }
  return {
    tick, monitor,
    start() {
      // A crash may have launched tools. Never feed these pending turns into normal recovery.
      const run = active(); if (run) stopSpare(db,run,'Runner restarted; prior batch outcome unknown');
      manager.bus.on('event',terminal);
      timer = setInterval(()=>{ void tick(); },2_000); timer.unref();
    },
    stop() { if (timer) clearInterval(timer); manager.bus.off('event',terminal); },
  };
}
