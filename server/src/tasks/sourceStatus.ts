import type Database from 'better-sqlite3';
import { classifyCaseKey } from '../csTickets/poll.js';
import type { TaskService } from './service.js';

/**
 * Live OrderOps status for tasks that carry a ticket code. A background sweep reads one ticket at a
 * time through the read-only mirror (never on board load), keeps one plain line per task, closes a
 * task whose ticket OrderOps shows complete, and asks the bot once to re-check an inherited task it
 * never started. OrderOps itself is only ever read.
 */
export const SWEEP_EVERY_MS = 20_000;
export const STALE_MS = 30 * 60_000;
export const RECHECKS_PER_HOUR = 6;
const BUSY_BACKOFF_MS = 60_000;

export interface OrderOpsTicket { subject?: string | null; status?: string | null; closedAt?: string | null; resolvedAt?: string | null; lastMessageAt?: string | null; lastMessage?: { direction?: string | null; createdAt?: string | null } | string | null }
export interface SourceStatus { status: string | null; closed_at: string | null; last_message_at: string | null; last_direction: string | null }

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
function ago(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
/** One plain line for the board and the task pane. */
export function sourceStatusLine(s: SourceStatus, now = Date.now()): string {
  const at = s.last_message_at;
  switch (s.status) {
    case 'complete': return `OrderOps: closed${s.closed_at ? ` ${day(s.closed_at)}` : ''}`;
    case 'waiting_on_customer': return at ? `OrderOps: waiting on the customer since ${day(at)}` : 'OrderOps: waiting on the customer';
    case 'waiting_on_us': return at && s.last_direction === 'inbound' ? `OrderOps: customer wrote ${ago(at, now)}, waiting on us` : at ? `OrderOps: waiting on us since ${day(at)}` : 'OrderOps: waiting on us';
    case 'new': return 'OrderOps: new ticket, not answered yet';
    default: return s.status ? `OrderOps: ${s.status.replace(/_/g, ' ')}` : 'OrderOps status unknown';
  }
}
export function readSourceStatus(t: OrderOpsTicket): SourceStatus {
  const last = typeof t.lastMessage === 'object' && t.lastMessage ? t.lastMessage : null;
  return { status: t.status ?? null, closed_at: t.closedAt ?? t.resolvedAt ?? null, last_message_at: t.lastMessageAt ?? last?.createdAt ?? null, last_direction: last?.direction ?? null };
}

type Row = { id: string; case_key: string; status: string; source: string; task_conversation_id: string | null; checked_at: string | null; recheck_at: string | null };
export function createTaskSourceSweep(db: Database.Database, deps: { tasks: TaskService; findConversation: (code: string) => Promise<OrderOpsTicket | null>; now?: () => number; log?: { warn: (m: string) => void } }) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? { warn: (m: string) => console.warn(m) };
  let lastRun = 0, pausedUntil = 0;
  const upsert = db.prepare(`INSERT INTO bot_task_source_status(task_id,ticket_code,status,closed_at,last_message_at,last_direction,line,checked_at,error,subject) VALUES(@task_id,@code,@status,@closed_at,@last_message_at,@last_direction,@line,@checked_at,@error,@subject)
    ON CONFLICT(task_id) DO UPDATE SET ticket_code=excluded.ticket_code,subject=COALESCE(excluded.subject,subject),status=excluded.status,closed_at=excluded.closed_at,last_message_at=excluded.last_message_at,last_direction=excluded.last_direction,line=excluded.line,checked_at=excluded.checked_at,error=excluded.error`);
  /** The next open task with a ticket code whose status is missing or older than STALE_MS. */
  function next(): Row | undefined {
    const stale = new Date(now() - STALE_MS).toISOString();
    const rows = db.prepare(`SELECT t.id,t.case_key,t.status,t.source,t.task_conversation_id,s.checked_at,s.recheck_at FROM bot_tasks t LEFT JOIN bot_task_source_status s ON s.task_id=t.id
      WHERE t.status<>'done' AND t.case_key IS NOT NULL AND (s.checked_at IS NULL OR s.checked_at < ?) ORDER BY s.checked_at IS NOT NULL, s.checked_at, t.updated_at LIMIT 50`).all(stale) as Row[];
    return rows.find((r) => classifyCaseKey(r.case_key) === 'ticket_code');
  }
  function recheckBudget(): boolean {
    const since = new Date(now() - 3_600_000).toISOString();
    return (db.prepare('SELECT COUNT(*) AS n FROM bot_task_source_status WHERE recheck_at > ?').get(since) as { n: number }).n < RECHECKS_PER_HOUR;
  }
  return {
    /** Called from the background loop every few seconds; reads at most one ticket per SWEEP_EVERY_MS. */
    async tick(force = false): Promise<{ checked: string | null; closed: boolean; recheck: boolean }> {
      const result = { checked: null as string | null, closed: false, recheck: false };
      if (!force && (now() - lastRun < SWEEP_EVERY_MS || now() < pausedUntil)) return result;
      lastRun = now();
      const t = next();
      if (!t) return result;
      const code = t.case_key.toUpperCase();
      const checkedAt = new Date(now()).toISOString();
      let ticket: OrderOpsTicket | null;
      try { ticket = await deps.findConversation(code); }
      catch (e) {
        const message = (e as Error).message;
        if (/\b429\b|refused the mirror/.test(message)) { pausedUntil = now() + BUSY_BACKOFF_MS; return result; }
        upsert.run({ task_id: t.id, code, status: null, closed_at: null, last_message_at: null, last_direction: null, line: '', checked_at: checkedAt, error: message.slice(0, 300), subject: null });
        log.warn(`[task-source] ${code}: ${message}`);
        return result;
      }
      result.checked = t.id;
      if (!ticket) {
        upsert.run({ task_id: t.id, code, status: null, closed_at: null, last_message_at: null, last_direction: null, line: `OrderOps has no ticket ${code}`, checked_at: checkedAt, error: null, subject: null });
        return result;
      }
      const s = readSourceStatus(ticket);
      const line = sourceStatusLine(s, now());
      upsert.run({ task_id: t.id, code, ...s, line, checked_at: checkedAt, error: null, subject: typeof ticket.subject === 'string' ? ticket.subject.slice(0, 300) : null });
      if (s.status === 'complete') {
        // A task the bot is actively working, or one with an open question, stays for the human or the bot to close.
        result.closed = t.status !== 'working' && deps.tasks.closeFromSource(t.id, `Closed in OrderOps${s.closed_at ? ` ${day(s.closed_at)}` : ''}`);
        return result;
      }
      if (t.source === 'import' && !t.recheck_at && t.status !== 'working' && recheckBudget() && deps.tasks.neverStarted(t.id)) {
        result.recheck = deps.tasks.recheck(t.id, code, line);
        if (result.recheck) db.prepare('UPDATE bot_task_source_status SET recheck_at=? WHERE task_id=?').run(checkedAt, t.id);
      }
      return result;
    },
    lineFor(taskId: string): string | null {
      return (db.prepare("SELECT line FROM bot_task_source_status WHERE task_id=? AND line<>''").get(taskId) as { line: string } | undefined)?.line ?? null;
    },
  };
}
/** OrderOps ticket subjects kept by the sweep, for the order numbers they name. */
export function sourceSubjects(db: Database.Database, taskIds: string[]): Map<string, string> {
  if (!taskIds.length) return new Map();
  const rows = db.prepare(`SELECT task_id,subject FROM bot_task_source_status WHERE subject IS NOT NULL AND task_id IN (${taskIds.map(() => '?').join(',')})`).all(...taskIds) as { task_id: string; subject: string }[];
  return new Map(rows.map((r) => [r.task_id, r.subject]));
}
export function sourceLines(db: Database.Database, taskIds: string[]): Map<string, string> {
  if (!taskIds.length) return new Map();
  const rows = db.prepare(`SELECT task_id,line FROM bot_task_source_status WHERE line<>'' AND task_id IN (${taskIds.map(() => '?').join(',')})`).all(...taskIds) as { task_id: string; line: string }[];
  return new Map(rows.map((r) => [r.task_id, r.line]));
}
