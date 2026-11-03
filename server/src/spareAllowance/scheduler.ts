import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConversationManager } from '../runtime/conversationManager.js';
import { businessHours, eligibility, type SpareAccount } from './policy.js';
import { spareBinding, stopSpare, taskAllowed, type SpareRun, type SpareTask } from './store.js';

export function normalWorkWaiting(db: Database.Database): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM pending_turns p WHERE p.status='pending' AND NOT EXISTS
    (SELECT 1 FROM spare_allowance_runs r WHERE r.conversation_id=p.conversation_id AND r.status IN ('queued','running'))
    UNION SELECT 1 FROM queued_messages q WHERE COALESCE(json_extract(q.origin_json,'$.spareRunId'),'')='' AND NOT EXISTS
    (SELECT 1 FROM pending_turns p WHERE p.conversation_id=q.conversation_id AND p.status='failed') LIMIT 1`).get());
}
export function createSpareScheduler(opts: {
  db: Database.Database; manager: ConversationManager;
  loadAccounts: () => Promise<SpareAccount[]>; now?: () => number;
}) {
  const {db,manager} = opts;
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setInterval>|undefined;
  let refreshing = false;
  let lastRefresh: number | null = null;
  let lastStatus = '';
  let lastEvaluationReason = 'Awaiting account evaluation';
  let lastHeartbeat = 0;
  function status(reason: string, accountsChecked = false) {
    const time = new Date(now()).toISOString();
    if (accountsChecked || reason !== lastStatus || now()-lastHeartbeat >= 30_000) {
      db.prepare(`INSERT INTO spare_allowance_scheduler(id,checked_at,reason,accounts_checked_at) VALUES(1,?,?,?)
        ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,reason=excluded.reason,
        accounts_checked_at=COALESCE(excluded.accounts_checked_at,spare_allowance_scheduler.accounts_checked_at)`)
        .run(time,reason,accountsChecked ? time : null);
      lastStatus=reason;lastHeartbeat=now();
    }
  }
  function taskReason(task: SpareTask, reason: string) {
    db.prepare('UPDATE spare_allowance_tasks SET checked_at=?,skip_reason=? WHERE id=?')
      .run(new Date(now()).toISOString(),reason,task.id);
  }
  function gate(): string | null {
    const enabled = db.prepare('SELECT enabled FROM spare_allowance_settings WHERE id=1').get() as {enabled:number};
    if (!enabled.enabled) return 'Queue paused';
    if (businessHours(now())) return 'Business hours';
    if (normalWorkWaiting(db)) return 'Normal work takes priority';
    return null;
  }
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
    lastRefresh = null;
  }
  async function tick() {
    monitor();
    const tasks = db.prepare("SELECT * FROM spare_allowance_tasks WHERE status='ready' AND completed_batches<max_batches ORDER BY priority DESC,created_at,id").all() as SpareTask[];
    const blocked = gate();
    const reason = blocked ?? (active() ? 'Optional batch running' : tasks.length ? lastEvaluationReason : 'No ready tasks');
    status(reason);
    if (!tasks.length || reason === 'Queue paused' || refreshing) return;
    // Passive provider reads still expose why nothing can run during busy/protected
    // periods. They do not generate work or grant eligibility. Keep them infrequent.
    const interval = blocked ? 300_000 : 10_000;
    if (lastRefresh !== null && now()-lastRefresh < interval) return;
    refreshing = true;
    status('Checking account eligibility');
    try {
      const accounts = await opts.loadAccounts();
      lastRefresh = now();
      db.transaction(() => {
        db.prepare('DELETE FROM spare_allowance_accounts').run();
        for (const account of accounts) db.prepare('INSERT INTO spare_allowance_accounts VALUES(?,?,?,?,?)').run(account.provider,account.accountId,JSON.stringify(account),eligibility(account,now()).reason,new Date(now()).toISOString());
      }).immediate();
      monitor();
      const currentGate = gate();
      status(currentGate ?? (active() ? 'Optional batch running' : 'Checking account eligibility'),true);
      if (currentGate) {
        for (const task of tasks) taskReason(task,currentGate);
        return;
      }
      if (active()) return;
      for (const task of tasks) {
        const conv = taskAllowed(db,task);
        if (!conv) { taskReason(task,'Chat, owner, project or model access changed');continue; }
        if (manager.statusOf(conv.id) !== 'idle' || manager.queueSnapshot(conv.id).messages.length) {
          taskReason(task,'Original chat is busy, failed or awaiting input');continue;
        }
        const compatible = accounts.filter(a=>a.provider===task.provider && (JSON.parse(task.account_ids_json) as string[]).includes(a.accountId));
        taskReason(task,compatible.length ? compatible.map(a=>`${a.label}: ${eligibility(a,now()).reason}`).join('; ') : 'Selected account disconnected or unavailable');
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
          lastEvaluationReason = 'Optional batch dispatched';
          taskReason(task,'Optional batch dispatched');
          status('Optional batch running');
          try {
            manager.postMessage(conv,`[Optional spare-allowance batch ${batch}/${task.max_batches}]\nTask: ${task.title}\nRequired output: ${task.output}\n${task.prompt}\nSaved checkpoint: ${task.cursor ?? 'none'}\n\nWork in one small resumable batch. Deadline ${e.deadline}. Save useful artifacts before that deadline. Do not publish, purchase, use paid credits/API keys, send messages, or launch detached jobs. Do not change shared source without its build slot. Preserve original bot identity and approvals. Missing source geometry is a blocker, never invent it. Stop when the deliverable is done; do not manufacture extra work. As the LAST action call record_spare_checkpoint with outcome progress|completed|blocked, a nonsecret cursor and an evidence-grounded summary; then finish. Without that checkpoint, automatic continuation is blocked.`,task.user_id,{kind:'wakeup',from:'Spare allowance',to:task.title,spareRunId:id});
          } catch {
            const run = active(); if (run?.id===id) stopSpare(db,run,'Dispatch outcome unknown; do not retry');
          }
          return;
        }
      }
      lastEvaluationReason = 'No eligible task/account; see task skip reasons';
      status(lastEvaluationReason);
    } catch {
      lastRefresh = now();
      const run = active(); if (run) stop(run,'Usage refresh unavailable');
      lastEvaluationReason = 'Account evaluation failed; dispatch skipped';
      status(lastEvaluationReason);
      for (const task of tasks) taskReason(task,'Account evaluation failed; dispatch skipped');
    } finally { refreshing = false; }
  }
  return {
    tick, monitor,
    start() {
      // A crash may have launched tools. Never feed these pending turns into normal recovery.
      const run = active(); if (run) stopSpare(db,run,'Runner restarted; prior batch outcome unknown');
      status('Scheduler started; awaiting evaluation');
      manager.bus.on('event',terminal);
      timer = setInterval(()=>{ void tick(); },2_000); timer.unref();
    },
    stop() { if (timer) clearInterval(timer); manager.bus.off('event',terminal); },
  };
}
