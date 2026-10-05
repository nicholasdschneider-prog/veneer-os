import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { FixturePreparationStore, type FixtureManifest } from '../src/fixtureTests/store.js';
import { createFixtureTestsRouter } from '../src/fixtureTests/routes.js';
import { fixtureReadiness } from '../src/fixtureTests/readiness.js';
import { BOT_FEATURES, botFeatureInstructions } from '../src/featureGuide/catalog.js';
import { coreVeneerRules } from '../src/instructions/context.js';
import { employeeRouteAllowed } from '../src/bots/employeeAccess.js';

const stores: FixturePreparationStore[] = [];
const directories: string[] = [];
const servers: Server[] = [];
let now = 10_000;
function open(file = ':memory:') {
  const store = new FixturePreparationStore(file, () => now); stores.push(store); return store;
}
function manifest(customers = 1, admissions: 1 | 3 | 5 = 1): FixtureManifest {
  return { schema: 'veneer-fixture-manifest/v1', syntheticOnly: true, provider: 'codex', model: 'fixture-model',
    fixtureHash: 'a'.repeat(64), trainingHash: 'b'.repeat(64), profileHash: 'c'.repeat(64),
    admissions, maxTurns: 3, wallTimeMs: 60_000,
    sessions: Array.from({ length: customers }, (_, i) => ({ sessionId: `fixture-session-${i}`, customerId: `fixture-customer-${i}`, orderIds: [`fixture-order-${i}`] })),
  };
}
function input(i = 0, turn = 0) {
  return { sessionId: `fixture-session-${i}`, customerId: `fixture-customer-${i}`, orderId: `fixture-order-${i}`,
    messageId: `fixture-message-${i}-${turn}`, syntheticOnly: true, text: 'Synthetic customer: please check my fixture order.' };
}
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(r => server.close(() => r()));
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  now = 10_000;
});

describe('fail-closed fixture preparation (no native/model execution)', () => {
  it('records stable manifests and rejects altered payloads under the original key', () => {
    const s = open(), m = manifest(), run = s.create(1, 'stable', m);
    expect(s.create(1, 'stable', { ...m, sessions: [...m.sessions] })).toEqual(run);
    expect(() => s.create(1, 'stable', { ...m, model: 'other' })).toThrow('FIXTURE_MANIFEST_DRIFT');
    expect(run.state).toBe('PREPARED_BLOCKED');
    expect(run.ready).toBe(false); expect(run.execute).toBe(false);
    expect(() => s.admit(1, run.runId)).toThrow('ISOLATED_NATIVE_PROCESS_HOST_UNAVAILABLE');
  });
  it('rejects false materialization flags, oversized admission, shared sessions and nonsynthetic identifiers', () => {
    const s = open(), m = manifest();
    for (const bad of [{ ...m, materialized: true }, { ...m, admissions: 10 }, { ...m, sessions: [...m.sessions, ...m.sessions] },
      { ...m, sessions: [{ ...m.sessions[0], sessionId: 'real-chat' }] }, { ...m, syntheticOnly: false },
      { ...m, credentials: 'not-accepted' }, { ...m, maxTurns: 1000 }, { ...m, wallTimeMs: 900_000 }]) {
      expect(() => s.create(1, 'bad', bad)).toThrow();
    }
    expect(s.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 });
  });
  it('durably deduplicates across two connections and a reopened ledger, with no second trace/effect', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-fixture-test-')); directories.push(dir);
    const file = path.join(dir, 'ledger.sqlite'), a = open(file), b = open(file);
    const run = a.create(1, 'durable', manifest());
    const receipt = a.submit(1, run.runId, input());
    expect(b.create(1, 'durable', manifest()).runId).toBe(run.runId);
    expect(b.submit(1, run.runId, input())).toEqual({ ...receipt, duplicate: true });
    const reopened = open(file);
    expect(reopened.submit(1, run.runId, input()).duplicate).toBe(true);
    expect(reopened.trace(1, run.runId).events).toHaveLength(3);
    expect(() => reopened.submit(1, run.runId, { ...input(), text: 'changed' })).toThrow('FIXTURE_INPUT_DRIFT');
    expect(reopened.monitor(1, run.runId).totalInputs).toBe(1);
  });
  it('fences session/customer/order identity and owner scope before any write', () => {
    const s = open(), run = s.create(1, 'scope', manifest(5));
    for (const field of ['sessionId', 'customerId', 'orderId'] as const)
      expect(() => s.submit(1, run.runId, { ...input(), [field]: `${input()[field]}-other` })).toThrow('FIXTURE_SCOPE_MISMATCH');
    expect(() => s.read(2, run.runId)).toThrow('FIXTURE_RUN_NOT_FOUND');
    expect(() => s.stop(2, run.runId)).toThrow('FIXTURE_RUN_NOT_FOUND');
    expect(() => s.submit(2, run.runId, input())).toThrow('FIXTURE_RUN_NOT_FOUND');
    expect(() => s.admit(2, run.runId)).toThrow('FIXTURE_RUN_NOT_FOUND');
    expect(s.monitor(1, run.runId).totalInputs).toBe(0);
  });
  it('caps preparation, turns and time without freeing slots via retries or admitting models', () => {
    const s = open();
    const runs = Array.from({ length: 10 }, (_, i) => s.create(1, `run-${i}`, manifest()));
    expect(() => s.create(1, 'overflow', manifest())).toThrow('FIXTURE_PREPARATION_CAPACITY');
    const run = runs[0]!;
    for (let i = 0; i < 3; i++) s.submit(1, run.runId, input(0, i));
    expect(s.submit(1, run.runId, input()).duplicate).toBe(true);
    expect(() => s.submit(1, run.runId, input(0, 3))).toThrow('FIXTURE_TURN_CAP');
    now += 60_000;
    expect(() => s.submit(1, runs[1]!.runId, input())).toThrow('FIXTURE_BUDGET_EXPIRED');
    s.stop(1, run.runId);
    expect(s.create(1, 'new-preparation', manifest()).execute).toBe(false);
  });
  it('stops idempotently and reconciles old receipts without requeue or rewriting history', () => {
    const s = open(), run = s.create(1, 'stop', manifest());
    s.submit(1, run.runId, input());
    const stopped = s.stop(1, run.runId);
    expect(s.stop(1, run.runId)).toEqual(stopped);
    expect(s.submit(1, run.runId, input()).duplicate).toBe(true);
    expect(() => s.submit(1, run.runId, input(0, 1))).toThrow('FIXTURE_RUN_STOPPED');
    expect(() => s.admit(1, run.runId)).toThrow('ISOLATED_NATIVE_PROCESS_HOST_UNAVAILABLE');
    expect(s.trace(1, run.runId).events).toHaveLength(4);
    for (const table of ['runs', 'receipts', 'stops', 'events']) {
      expect(() => s.db.exec(`DELETE FROM ${table}`)).toThrow('immutable_fixture_record');
    }
    expect(() => s.db.exec("UPDATE receipts SET captured_ms=0")).toThrow('immutable_fixture_record');
  });
  it('retains correlated clock/hash evidence and paginates without fabricating provider events', () => {
    const s = open(), run = s.create(1, 'trace', manifest());
    s.submit(1, run.runId, input());
    const events = s.trace(1, run.runId).events;
    for (const e of events) {
      const { sequence, previousHash, eventHash, ...payload } = e;
      const stored = s.db.prepare('SELECT payload FROM events WHERE seq=?').get(sequence) as { payload: string };
      expect(crypto.createHash('sha256').update(`${previousHash}\n${stored.payload}`).digest('hex')).toBe(eventHash);
      expect(payload.runId).toBe(run.runId); expect(payload.trainingHash).toBe('b'.repeat(64));
      expect(payload.processClockId).toBeTruthy(); expect(BigInt(payload.monotonicNs)).toBeGreaterThan(0n);
    }
    expect(events.map(e => e.kind)).toEqual(['preparation_registered', 'inbound_captured', 'admission_blocked']);
    expect(s.trace(1, run.runId, events[0]!.sequence).events).toHaveLength(2);
  });
  it.each([1, 5, 10].flatMap(customers => [1, 3, 5].map(admissions => [customers, admissions])))
    ('captures %i multi-turn synthetic customers at requested cap %i, all BLOCKED (not a native benchmark)', async (customers, admissions) => {
      const s = open(), run = s.create(1, 'matrix', manifest(customers!, admissions as 1 | 3 | 5));
      for (let turn = 0; turn < 3; turn++) await Promise.all(Array.from({ length: customers! }, async (_, i) => s.submit(1, run.runId, input(i, turn))));
      expect(s.monitor(1, run.runId).totalInputs).toBe(customers! * 3);
      expect(s.monitor(1, run.runId).substantiveReplyMs).toEqual({ observed: 0, p50: null, p95: null, max: null });
      expect(() => s.admit(1, run.runId)).toThrow('ISOLATED_NATIVE_PROCESS_HOST_UNAVAILABLE');
    });
  it('keeps effect, escalation, sink/carrier and latency observations null, with blocked/unanswered totals', () => {
    const s = open(), run = s.create(1, 'monitor', manifest()); s.submit(1, run.runId, input()); now += 321;
    const report = s.monitor(1, run.runId);
    expect(report.unanswered).toBe(1); expect(report.blockedInputs).toBe(1);
    expect(report.timeline[0]!.unansweredAgeMs).toBe(321);
    for (const k of ['duplicateEffects', 'wrongOrderEffects', 'unresolvedHandoffs', 'providerAcceptance', 'carrierDelivery'] as const) expect(report[k]).toBeNull();
    expect(report.timeline[0]!.sinkAcceptance).toBeNull();
    expect(report.nativeMeasurements).toBe(false);
  });
});

describe('authenticated preparation API', () => {
  async function api(role = 'owner', agent = false, dataDir?: string) {
    const app = express(), store = open(); app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 1, email: 'fixture@example.com', role, display_name: 'Fixture', created_at: '' } as express.Request['user'];
      if (agent) req.agentConversationId = 'agent-token-chat'; next();
    });
    app.use('/fixture-tests', createFixtureTestsRouter({ config: { dataDir: dataDir ?? '/unused' } } as any, dataDir ? undefined : store));
    const server = await new Promise<Server>(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
    servers.push(server); return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture-tests`, store };
  }
  it('denies employee and agent tokens including owner-backed tokens', async () => {
    for (const [role, agent] of [['member', false], ['owner', true]] as const) {
      const { base } = await api(role, agent);
      expect((await fetch(`${base}/readiness`)).status).toBe(403);
      expect((await fetch(`${base}/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestKey: 'r', manifest: manifest() }) })).status).toBe(403);
    }
  });
  it('does not open storage for readiness and refuses directory, dangling-file and hard-link aliases', async () => {
    for (const kind of ['directory', 'dangling-file', 'hard-link']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-fixture-storage-')); directories.push(dir);
      const ledgerDir = path.join(dir, 'fixture-tests'), external = path.join(dir, 'protected');
      fs.writeFileSync(external, 'protected bytes');
      if (kind === 'directory') fs.symlinkSync(dir, ledgerDir);
      else {
        fs.mkdirSync(ledgerDir);
        const file = path.join(ledgerDir, 'preparation.sqlite');
        if (kind === 'dangling-file') fs.symlinkSync(path.join(dir, 'absent'), file);
        else fs.linkSync(external, file);
      }
      const { base } = await api('owner', false, dir);
      expect((await fetch(`${base}/readiness`)).status).toBe(200);
      const denied = await fetch(`${base}/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestKey: 'r', manifest: manifest() }) });
      expect(denied.status).toBe(409);
      expect(fs.readFileSync(external, 'utf8')).toBe('protected bytes');
      expect(fs.existsSync(path.join(dir, 'absent'))).toBe(false);
    }
  });
  it('captures real preparation receipts, refuses /start, and serves only read-only monitoring', async () => {
    const { base, store } = await api();
    const request = (route: string, body: unknown) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const readiness = await fetch(`${base}/readiness`); expect(readiness.headers.get('cache-control')).toBe('no-store');
    expect(await readiness.json()).toEqual(fixtureReadiness());
    const created = await request('/runs', { requestKey: 'r', manifest: manifest() }); expect(created.status).toBe(201);
    const run = await created.json() as { runId: string };
    expect((await request(`/runs/${run.runId}/inputs`, input())).status).toBe(202);
    expect((await request(`/runs/${run.runId}/start`, { ready: true, dangerous: true })).status).toBe(503);
    const before = store.trace(1, run.runId).events.length;
    expect((await fetch(`${base}/runs/${run.runId}/monitor`)).status).toBe(200);
    expect(store.trace(1, run.runId).events).toHaveLength(before);
    expect((await request(`/runs/${run.runId}/monitor`, {})).status).toBe(404);
    const invalid = await request('/runs', { requestKey: 'bad', manifest: { ...manifest(), password: 'must-not-echo' } });
    expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain('must-not-echo');
  });
  it('delivers staged limits to fresh/resumed agents and guides without widening employee routes', () => {
    const feature = BOT_FEATURES.find(f => f.id === 'sms-fixture-preparation')!;
    expect(feature.announcement).toBeNull(); expect(feature.limits).toContain('Not deployed');
    expect(botFeatureInstructions()).toContain(feature.agent);
    expect(coreVeneerRules({ workspaceDir: '/repo', assistantSlug: 'platform-dev', elevated: false })).toContain(feature.agent);
    expect(employeeRouteAllowed('GET', '/fixture-tests/readiness')).toBe(false);
    expect(employeeRouteAllowed('POST', '/fixture-tests/runs')).toBe(false);
  });
});
