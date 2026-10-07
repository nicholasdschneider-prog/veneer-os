import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

export interface WebSample { at: number; pid: number | null; latency: number; cpu: number | null; eventLoop: number | null; ok: boolean; code: 'ok' | 'timeout' | 'unreachable' | 'http_error' }
/** Only the independent collector's verified listener may own this telemetry. */
export function freshWebLoopDelay(telemetry: unknown, pid: number, at: number): number | null {
  if (!telemetry || typeof telemetry !== 'object') return null;
  const value = telemetry as { pid?: unknown; at?: unknown; delayMs?: unknown };
  if (value.pid !== pid || typeof value.at !== 'number' || !Number.isFinite(value.at)
    || at < value.at || at - value.at >= 90000
    || typeof value.delayMs !== 'number' || !Number.isFinite(value.delayMs) || value.delayMs < 0) return null;
  return Math.min(60000, value.delayMs);
}

/** Never expose exception text, SQL, paths or arbitrary provider error codes. */
export function watchdogPersistenceFailure(error: unknown): 'busy' | 'locked' | 'other' {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (typeof code !== 'string') return 'other';
  if (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_')) return 'busy';
  if (code === 'SQLITE_LOCKED' || code.startsWith('SQLITE_LOCKED_')) return 'locked';
  return 'other';
}
export async function observeWeb(port: number, fetchImpl: typeof fetch = fetch): Promise<WebSample> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid loopback web port');
  const start = performance.now();
  const sample: WebSample = { at: Date.now(), pid: null, latency: 0, cpu: null, eventLoop: null, ok: false, code: 'unreachable' };
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    const body = await response.json() as { ok?: boolean; web_pid?: number; event_loop_delay_ms?: number };
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid health response');
    sample.ok = response.ok && body.ok === true; sample.code = sample.ok ? 'ok' : 'http_error';
    if (Number.isSafeInteger(body.web_pid) && body.web_pid! > 0) sample.pid = body.web_pid!;
    if (typeof body.event_loop_delay_ms === 'number' && Number.isFinite(body.event_loop_delay_ms)) sample.eventLoop = Math.max(0, Math.min(60000, body.event_loop_delay_ms));
  } catch (e) { sample.ok = false; sample.code = (e as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable'; }
  sample.latency = performance.now() - start;
  return sample;
}
type State = { conversation_id: string | null; owner_id: number | null; incident: string | null; bad_samples: number; good_samples: number; last_notice_ms: number; last_sample_ms: number };
export function watchdogOwner(db: Database.Database, id: string, owner: number) {
  return Boolean(db.prepare(`SELECT 1 FROM conversations c JOIN assistants a ON a.id=c.assistant_id
    JOIN users u ON u.id=c.user_id WHERE c.id=? AND c.user_id=? AND c.archived=0
    AND a.slug='platform-dev' AND u.role='owner' AND u.status='active'`).get(id, owner));
}
export function bindWebWatchdog(db: Database.Database, id: string, owner: number) {
  db.transaction(() => {
    if (!watchdogOwner(db, id, owner)) throw new Error('An active owner’s unarchived Platform Dev chat is required');
    const old = db.prepare('SELECT * FROM web_watchdog_state WHERE singleton=1').get() as State;
    if (old.incident && (old.conversation_id !== id || old.owner_id !== owner)) throw new Error('Resolve the current incident before changing repair ownership');
    db.prepare('UPDATE web_watchdog_state SET conversation_id=?,owner_id=? WHERE singleton=1').run(id, owner);
  }).immediate();
}

/** Samples and wake records commit together. One alert per incident survives
 * process restarts; recovery needs three fully measured good samples. Never restart anything. */
export function recordWebSample(db: Database.Database, sample: WebSample) {
  return db.transaction(() => {
    const s = db.prepare('SELECT * FROM web_watchdog_state WHERE singleton=1').get() as State;
    const ownerReady = Boolean(s.conversation_id && s.owner_id && watchdogOwner(db, s.conversation_id, s.owner_id));
    if (sample.at <= s.last_sample_ms || sample.at - s.last_sample_ms < 20000) return { notification: null, ownerReady };
    const bad = !sample.ok || sample.latency >= 1500 || (sample.cpu ?? 0) >= 85 || (sample.eventLoop ?? 0) >= 250;
    const known = Number.isSafeInteger(sample.pid) && sample.pid! > 0
      && Number.isFinite(sample.latency) && sample.latency >= 0
      && sample.cpu !== null && Number.isFinite(sample.cpu) && sample.cpu >= 0
      && sample.eventLoop !== null && Number.isFinite(sample.eventLoop) && sample.eventLoop >= 0;
    const contiguous = sample.at - s.last_sample_ms <= 90000;
    const badCount = bad ? (contiguous ? s.bad_samples : 0) + 1 : 0;
    const goodCount = !bad && known ? (contiguous ? s.good_samples : 0) + 1 : 0;
    let incident = s.incident, notice = s.last_notice_ms;
    let notification: 'stalled' | 'recovered' | null = null;
    if (ownerReady && !incident && badCount >= 3 && sample.at - notice >= 600000) {
      incident = crypto.randomUUID(); notification = 'stalled'; notice = sample.at;
    } else if (ownerReady && incident && goodCount >= 3) notification = 'recovered';
    db.prepare('INSERT INTO web_watchdog_samples(at_ms,web_pid,latency_ms,cpu_percent,event_loop_ms,health_ok,code) VALUES(?,?,?,?,?,?,?)')
      .run(sample.at, sample.pid, sample.latency, sample.cpu, sample.eventLoop, Number(sample.ok), sample.code);
    db.prepare('DELETE FROM web_watchdog_samples WHERE id NOT IN (SELECT id FROM web_watchdog_samples ORDER BY id DESC LIMIT 120)').run();
    if (notification) {
      const reason = `Veneer web watchdog: ${notification}. Incident ${incident}. Observation at ${new Date(sample.at).toISOString()}: health=${sample.code}, latency=${sample.latency.toFixed(0)}ms, web CPU=${sample.cpu?.toFixed(1) ?? 'unknown'}%, event-loop delay=${sample.eventLoop?.toFixed(0) ?? 'unknown'}ms. This is technical monitoring evidence, not business authority. Read the last 120 sanitized samples in web_watchdog_samples and investigate safely. Queue any source repair. Never cancel active business turns, replay uncertain effects or broadly restart services. A recovery notice reports measured health, not proof that every user action succeeded.`;
      // Native runner consumption works even when the web interface is stalled.
      db.prepare(`INSERT INTO conversation_wakeups(id,conversation_id,actor_user_id,wake_key,reason,scheduled_for)
        VALUES(?,?,?,?,?,?)`).run(crypto.randomUUID(), s.conversation_id, s.owner_id,
        `web-watchdog:${incident}:${notification}`, reason, new Date(sample.at).toISOString());
      if (notification === 'recovered') incident = null;
    }
    db.prepare('UPDATE web_watchdog_state SET incident=?,bad_samples=?,good_samples=?,last_notice_ms=?,last_sample_ms=? WHERE singleton=1')
      .run(incident, badCount, goodCount, notice, sample.at);
    return { notification, ownerReady };
  // Reserve the write lock before reading state. In WAL mode a deferred
  // read-to-write upgrade can fail immediately despite busy_timeout.
  // The independent collector sets a bounded one-second busy_timeout;
  // failure leaves samples, incident state and native wakes unchanged.
  }).immediate();
}
