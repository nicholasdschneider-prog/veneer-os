import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { denyFixtureAdmission, fixtureReadiness } from './readiness.js';

const id = z.string().regex(/^fixture-[a-z0-9-]{1,90}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
export const ManifestSchema = z.object({
  schema: z.literal('veneer-fixture-manifest/v1'),
  syntheticOnly: z.literal(true),
  provider: z.enum(['codex', 'claude']),
  model: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  fixtureHash: hash, trainingHash: hash, profileHash: hash,
  admissions: z.union([z.literal(1), z.literal(3), z.literal(5)]),
  maxTurns: z.number().int().min(1).max(30),
  wallTimeMs: z.number().int().min(1000).max(600_000),
  sessions: z.array(z.object({ sessionId: id, customerId: id, orderIds: z.array(id).min(1).max(5) }).strict()).min(1).max(10),
}).strict().superRefine((m, ctx) => {
  for (const field of ['sessionId', 'customerId'] as const) {
    if (new Set(m.sessions.map(s => s[field])).size !== m.sessions.length)
      ctx.addIssue({ code: 'custom', message: `Duplicate ${field}` });
  }
  const orders = m.sessions.flatMap(s => s.orderIds);
  if (new Set(orders).size !== orders.length) ctx.addIssue({ code: 'custom', message: 'Duplicate order binding' });
});
export const TurnSchema = z.object({
  sessionId: id, customerId: id, orderId: id, messageId: id,
  // Preparation input only. Never passed to a provider, shell, connector or memory.
  syntheticOnly: z.literal(true), text: z.string().min(1).max(4000),
}).strict();
export type FixtureManifest = z.infer<typeof ManifestSchema>;
type Run = { id: string; owner: number; request_key: string; manifest: string; manifest_hash: string; created_ms: number };
type Receipt = { run_id: string; message_id: string; payload: string; captured_ms: number };
type Trace = { seq: number; run_id: string; kind: string; payload: string; previous_hash: string; event_hash: string };
const processClockId = crypto.randomUUID();
function digest(value: string) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Separate synthetic preparation ledger. No dependency on the business DB,
 * conversation manager, materializer, provider, secret store, or network.
 * This does NOT claim to implement the missing OS/process isolation boundary.
 */
export class FixturePreparationStore {
  readonly db: Database.Database;
  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, owner INTEGER NOT NULL,
        request_key TEXT NOT NULL, manifest TEXT NOT NULL, manifest_hash TEXT NOT NULL,
        created_ms INTEGER NOT NULL, UNIQUE(owner,request_key));
      CREATE TABLE IF NOT EXISTS receipts(run_id TEXT NOT NULL REFERENCES runs(id), message_id TEXT NOT NULL,
        payload TEXT NOT NULL, captured_ms INTEGER NOT NULL, PRIMARY KEY(run_id,message_id));
      CREATE TABLE IF NOT EXISTS stops(run_id TEXT PRIMARY KEY REFERENCES runs(id), stopped_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL, payload TEXT NOT NULL, previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL);
      ${['runs', 'receipts', 'stops', 'events'].map(table => `
        CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_fixture_record'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_fixture_record'); END;
      `).join('')}
    `);
  }
  close() { this.db.close(); }
  private run(owner: number, runId: string): Run {
    const run = this.db.prepare('SELECT * FROM runs WHERE id=? AND owner=?').get(runId, owner) as Run | undefined;
    if (!run) throw new Error('FIXTURE_RUN_NOT_FOUND');
    return run;
  }
  private event(run: Run, kind: string, detail: Record<string, unknown>) {
    const manifest = JSON.parse(run.manifest) as FixtureManifest;
    const previous = this.db.prepare('SELECT event_hash FROM events WHERE run_id=? ORDER BY seq DESC LIMIT 1').get(run.id) as { event_hash: string } | undefined;
    const previousHash = previous?.event_hash ?? '';
    const payload = canonical({ ...detail, runId: run.id, kind, manifestHash: run.manifest_hash,
      profileHash: manifest.profileHash, trainingHash: manifest.trainingHash,
      processClockId, monotonicNs: process.hrtime.bigint().toString(), utc: new Date(this.now()).toISOString() });
    this.db.prepare('INSERT INTO events(run_id,kind,payload,previous_hash,event_hash) VALUES(?,?,?,?,?)')
      .run(run.id, kind, payload, previousHash, digest(`${previousHash}\n${payload}`));
  }
  create(owner: number, requestKey: unknown, raw: unknown) {
    z.number().int().positive().parse(owner);
    const request = key.parse(requestKey), manifest = canonical(ManifestSchema.parse(raw));
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT * FROM runs WHERE owner=? AND request_key=?').get(owner, request) as Run | undefined;
      if (old) {
        if (old.manifest !== manifest) throw new Error('FIXTURE_MANIFEST_DRIFT');
        return this.read(owner, old.id);
      }
      // Bound pending preparation as well as eventual admission; no slot eviction.
      const pending = this.db.prepare('SELECT count(*) AS n FROM runs WHERE owner=? AND id NOT IN (SELECT run_id FROM stops)').get(owner) as { n: number };
      if (pending.n >= 10) throw new Error('FIXTURE_PREPARATION_CAPACITY');
      const run: Run = { id: `fixture-run-${crypto.randomUUID()}`, owner, request_key: request,
        manifest, manifest_hash: digest(manifest), created_ms: this.now() };
      this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)').run(run.id, owner, request, manifest, run.manifest_hash, run.created_ms);
      this.event(run, 'preparation_registered', { ownerId: owner, execute: false });
      return this.read(owner, run.id);
    }).immediate();
  }
  read(owner: number, runId: string) {
    const run = this.run(owner, runId);
    return { runId: run.id, ownerId: run.owner, manifest: JSON.parse(run.manifest) as FixtureManifest,
      manifestHash: run.manifest_hash, createdMs: run.created_ms,
      state: this.db.prepare('SELECT 1 FROM stops WHERE run_id=?').get(run.id) ? 'STOPPED' : 'PREPARED_BLOCKED',
      ...fixtureReadiness() };
  }
  submit(owner: number, runId: string, raw: unknown) {
    const turn = TurnSchema.parse(raw), payload = canonical(turn);
    return this.db.transaction(() => {
      const run = this.run(owner, runId), manifest = JSON.parse(run.manifest) as FixtureManifest;
      const session = manifest.sessions.find(s => s.sessionId === turn.sessionId);
      if (!session || session.customerId !== turn.customerId || !session.orderIds.includes(turn.orderId)) throw new Error('FIXTURE_SCOPE_MISMATCH');
      const old = this.db.prepare('SELECT * FROM receipts WHERE run_id=? AND message_id=?').get(runId, turn.messageId) as Receipt | undefined;
      if (old) {
        if (old.payload !== payload) throw new Error('FIXTURE_INPUT_DRIFT');
        return this.receipt(old, true);
      }
      if (this.db.prepare('SELECT 1 FROM stops WHERE run_id=?').get(runId)) throw new Error('FIXTURE_RUN_STOPPED');
      if (this.now() >= run.created_ms + manifest.wallTimeMs) throw new Error('FIXTURE_BUDGET_EXPIRED');
      const count = this.db.prepare('SELECT count(*) AS n FROM receipts WHERE run_id=? AND json_extract(payload,\'$.sessionId\')=?').get(runId, turn.sessionId) as { n: number };
      if (count.n >= manifest.maxTurns) throw new Error('FIXTURE_TURN_CAP');
      const receipt: Receipt = { run_id: runId, message_id: turn.messageId, payload, captured_ms: this.now() };
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(runId, turn.messageId, payload, receipt.captured_ms);
      const detail = { sessionId: turn.sessionId, customerId: turn.customerId, orderId: turn.orderId, messageId: turn.messageId, turnId: turn.messageId };
      this.event(run, 'inbound_captured', detail);
      this.event(run, 'admission_blocked', { ...detail, blockers: fixtureReadiness().blockers });
      return this.receipt(receipt, false);
    }).immediate();
  }
  private receipt(row: Receipt, duplicate: boolean) {
    return { runId: row.run_id, messageId: row.message_id, capturedMs: row.captured_ms,
      payloadHash: digest(row.payload), duplicate, state: 'BLOCKED', execute: false,
      queueStatus: 'NOT_QUEUED', nativeSessionId: null };
  }
  admit(owner: number, runId: string): never {
    this.run(owner, runId);
    // No fallback into a normal chat, shared provider, or direct model client.
    return denyFixtureAdmission();
  }
  stop(owner: number, runId: string) {
    return this.db.transaction(() => {
      const run = this.run(owner, runId);
      if (!this.db.prepare('SELECT 1 FROM stops WHERE run_id=?').get(runId)) {
        this.db.prepare('INSERT INTO stops VALUES(?,?)').run(runId, this.now());
        this.event(run, 'preparation_stopped', { execute: false });
      }
      // Receipts remain BLOCKED; stopping cannot rewrite or replay prior outcomes.
      return this.read(owner, runId);
    }).immediate();
  }
  trace(owner: number, runId: string, after = 0) {
    this.run(owner, runId);
    const rows = this.db.prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 501').all(runId, after) as Trace[];
    return { events: rows.slice(0, 500).map(r => ({ sequence: r.seq, ...JSON.parse(r.payload), previousHash: r.previous_hash, eventHash: r.event_hash })),
      hasMore: rows.length > 500, next: rows[Math.min(rows.length, 500) - 1]?.seq ?? after };
  }
  monitor(owner: number, runId: string) {
    const run = this.read(owner, runId);
    const receipts = this.db.prepare('SELECT * FROM receipts WHERE run_id=? ORDER BY captured_ms,message_id').all(runId) as Receipt[];
    return { run, nativeMeasurements: false, totalInputs: receipts.length, blockedInputs: receipts.length,
      completed: 0, failed: 0, timedOut: 0, unknown: 0, unanswered: receipts.length,
      substantiveReplyMs: { observed: 0, p50: null, p95: null, max: null },
      duplicateEffects: null, wrongOrderEffects: null, unresolvedHandoffs: null,
      providerAcceptance: null, carrierDelivery: null,
      timeline: receipts.map(r => ({ ...JSON.parse(r.payload), ...this.receipt(r, false),
        unansweredAgeMs: Math.max(0, this.now() - r.captured_ms),
        reply: null, verifiedMutation: null, sinkAcceptance: null,
      })),
    };
  }
}
