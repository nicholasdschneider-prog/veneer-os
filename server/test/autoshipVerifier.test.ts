import Database from 'better-sqlite3';
import express from 'express';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JWTPayload } from 'jose';
import { migrate } from '../src/db/migrate.js';
import type { UserRow } from '../src/db/db.js';
import { canonicalJson, canonicalSha256 } from '../src/bots/canonical.js';
import { autoshipBinding, autoshipProposalSchema, createBotService, proposalInputSchema, type Actor } from '../src/bots/service.js';
import { createAutoshipVerifierRouter } from '../src/bots/verifierRoutes.js';
import { createAutoshipVerifierResolver } from '../src/identity/autoshipVerifier.js';

const WORKER = 'autoship-worker-chat';
const CS_BOT = 'cs-bot-chat';
const AUD = 'aud-autoship-verifier';
const CLIENT_ID = 'orderops-autoship-verifier.access';

// Fake JWTs: the token string is a JSON payload; the verifier checks audience
// exactly like jose would (aud claim must equal the configured audience).
const token = (payload: JWTPayload & { aud?: string }) => JSON.stringify(payload);
const verifyJwt = async (raw: string, audience: string): Promise<JWTPayload> => {
  const payload = JSON.parse(raw) as JWTPayload;
  if (payload.aud !== audience) throw new Error('unexpected "aud" claim value');
  return payload;
};
const SERVICE = token({ aud: AUD, common_name: CLIENT_ID });

function bindingFor(over: Partial<Record<string, unknown>> = {}) {
  const base = {
    kind: 'autoship_package' as const,
    scope: 'order' as const,
    allow_solo_templates: false,
    order_id: 'ord_1',
    merchant_order_number: '100121927',
    orderops_id: '62d4d51f',
    shopify_order_id: '6132968521880',
    lines: [{ line_id: '14708041023640', sku: 'LIP-123', quantity: 2 }],
    material_version: 'm1',
    composition_key: 'comp-1',
    composition_version: 'c1',
    composition_source_hash: 'a'.repeat(64),
    package_version: 0,
    package_teaching_key: 'teach-1',
    ...over,
  };
  return base;
}
function autoshipProposal(over: Partial<Record<string, unknown>> = {}) {
  const b = bindingFor(over);
  return {
    question: 'Package for order 100121927?',
    recommendation: '12 x 10 x 8 in, 4 lb, one box.',
    consequence: 'Fixture only.',
    assignee_id: 1,
    blocked_action: 'Set package version (fixture)',
    ...b,
    binding_hash: canonicalSha256(autoshipBinding(b as never)),
  };
}

describe('canonical hashing', () => {
  it('sorts object keys recursively and preserves array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalSha256({ a: 1, b: 2 })).toBe(canonicalSha256({ b: 2, a: 1 }));
    expect(canonicalSha256([1, 2])).not.toBe(canonicalSha256([2, 1]));
  });
});

describe('AutoShip proposal schema', () => {
  it('accepts a bound order proposal and refuses solo template permission or a tampered hash', () => {
    expect(autoshipProposalSchema.safeParse(autoshipProposal()).success).toBe(true);
    expect(autoshipProposalSchema.safeParse(autoshipProposal({ allow_solo_templates: true })).success).toBe(false);
    expect(autoshipProposalSchema.safeParse(autoshipProposal({ scope: 'shared_template', allow_solo_templates: true })).success).toBe(true);
    const tampered = { ...autoshipProposal(), package_version: 7 };
    expect(autoshipProposalSchema.safeParse(tampered).success).toBe(false);
    expect(autoshipProposalSchema.safeParse({ ...autoshipProposal(), package_version: -1 }).success).toBe(false);
    // Generic proposals still parse through the union; unknown kinds do not.
    expect(proposalInputSchema.safeParse({ question: 'q', recommendation: 'r', consequence: 'c', assignee_id: 1, blocked_action: 'b' }).success).toBe(true);
    expect(proposalInputSchema.safeParse({ ...autoshipProposal(), kind: 'other' }).success).toBe(false);
  });
});

describe('AutoShip verifier identity', () => {
  const config = { identity: 'cloudflare' as const, cfTeamDomain: 'team', autoshipVerifierCfAud: AUD, autoshipVerifierClientId: CLIENT_ID };
  const resolve = createAutoshipVerifierResolver(config, { verifyJwt, log: { warn() {} } });
  const req = (jwt?: string) => ({ headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} }) as never;
  it('accepts only the enrolled service token audience and common_name', async () => {
    expect(await resolve(req(SERVICE))).toEqual({ kind: 'autoship_verifier', clientId: CLIENT_ID });
    expect(await resolve(req())).toBeNull();
    expect(await resolve(req(token({ aud: 'owner-app-aud', common_name: CLIENT_ID })))).toBeNull();
    expect(await resolve(req(token({ aud: AUD, common_name: 'someone-else.access' })))).toBeNull();
    expect(await resolve(req(token({ aud: AUD, email: 'owner@example.test' })))).toBeNull();
    expect(await resolve(req(token({ aud: AUD, common_name: CLIENT_ID, email: 'spoof@example.test' })))).toBeNull();
    expect(await resolve(req('not-json'))).toBeNull();
  });
  it('is disabled without configuration', async () => {
    const off = createAutoshipVerifierResolver({ ...config, autoshipVerifierClientId: null }, { verifyJwt });
    expect(await off(req(SERVICE))).toBeNull();
  });
});

describe('AutoShip verifier endpoint (fixtures only)', () => {
  let db: Database.Database;
  let s: ReturnType<typeof createBotService>;
  let human: Actor;
  let worker: Actor;
  let csBot: Actor;
  let server: Server;
  let base: string;
  let workerChatId: string | null = WORKER;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    db.prepare('INSERT INTO users(id,email,display_name,role) VALUES(1,?,?,?)').run('owner@example.test', 'Owner', 'owner');
    for (const id of [WORKER, CS_BOT])
      db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'claude',?,'team')").run(id, id, `native-${id}`);
    s = createBotService(db);
    human = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow };
    worker = { ...human, conversationId: WORKER };
    csBot = { ...human, conversationId: CS_BOT };
    s.register(human, WORKER, 'AutoShip Worker', true);
    s.register(human, CS_BOT, 'Nora', true);
    workerChatId = WORKER;
    const app = express();
    app.use(express.json());
    app.use(
      '/api/autoship/verifier',
      createAutoshipVerifierRouter({
        db,
        get config() {
          return { identity: 'cloudflare' as const, cfTeamDomain: 'team', autoshipVerifierCfAud: AUD, autoshipVerifierClientId: CLIENT_ID, autoshipWorkerChatId: workerChatId };
        },
        resolveVerifier: createAutoshipVerifierResolver(
          { identity: 'cloudflare', cfTeamDomain: 'team', autoshipVerifierCfAud: AUD, autoshipVerifierClientId: CLIENT_ID },
          { verifyJwt, log: { warn() {} } },
        ),
        now: () => new Date('2026-09-21T15:00:00Z'),
      }),
    );
    await new Promise<void>((r) => {
      server = app.listen(0, '127.0.0.1', r);
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/autoship/verifier`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });

  const get = (path: string, jwt: string | null = SERVICE, method = 'GET') =>
    fetch(`${base}${path}`, { method, headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} });
  const raiseAutoship = (actor: Actor = worker, over: Partial<Record<string, unknown>> = {}, sourceKey = 'autoship:order:100121927') =>
    s.raise(actor, { source_key: sourceKey, proposal_key: 'package', proposal: proposalInputSchema.parse(autoshipProposal(over)) });
  const answer = (id: string, version: number, key: string, text = '12 x 10 x 8 inches, 4 lb, one parcel') =>
    s.answer(human, id, version, key, { action: 'approve', text, scope: 'this_case' });
  const markDelivered = (id: string, version: number) =>
    db.prepare(
      `UPDATE conversation_wakeups SET status='delivered', delivered_at=datetime('now') WHERE id IN (SELECT id FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='answered')`,
    ).run(id, version);

  it('returns the exact assigned AutoShip decision with binding, hashes, human actor and delivery state', async () => {
    const d = raiseAutoship();
    let res = await get(`/decisions/${d.id}?expected_version=1&request_key=rk-1`);
    expect(res.status).toBe(200);
    let body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({ ok: true, contract: 'autoship-answer-bridge/v1', request_key: 'rk-1', expected_version: 1, served_at: '2026-09-21T15:00:00.000Z' });
    expect(body.decision).toMatchObject({
      id: d.id,
      assigned_worker_id: WORKER,
      worker_registration_active: true,
      source_key: 'autoship:order:100121927',
      proposal_key: 'package',
      current_version: 1,
      state: 'needs_input',
      kind: 'autoship_package',
      binding: { scope: 'order', allow_solo_templates: false, order_id: 'ord_1', package_version: 0, lines: [{ line_id: '14708041023640', sku: 'LIP-123', quantity: 2 }] },
      answer_bridge: { delivered_version: null, answer: null },
      result: { kind: 'no_result' },
    });
    expect(body.decision.binding_hash).toBe(canonicalSha256(body.decision.binding));
    expect(body.decision.proposal_hash).toBe(canonicalSha256({ kind: 'autoship_package', source_key: d.source_key, proposal_key: 'package', binding: body.decision.binding }));
    // No chat, history or customer bodies leak.
    expect(JSON.stringify(body)).not.toMatch(/question|recommendation|consequence|messages|events|title/);

    answer(d.id, 1, 'answer-1');
    res = await get(`/decisions/${d.id}?expected_version=1&request_key=rk-2`);
    body = (await res.json()) as Record<string, any>;
    expect(body.decision.state).toBe('decided');
    expect(body.decision.answer_bridge.delivered_version).toBeNull(); // stale delivery: answered but not yet delivered
    expect(body.decision.answer_bridge.answer).toMatchObject({
      raw: { action: 'approve', text: '12 x 10 x 8 inches, 4 lb, one parcel', scope: 'this_case' },
      actor_id: 1,
      actor_conversation_id: null,
      actor_is_human: true,
      actor_active: true,
      request_key: 'answer-1',
      source: 'veneer.bot_decision_events',
    });
    markDelivered(d.id, 1);
    res = await get(`/decisions/${d.id}?expected_version=1&request_key=rk-2`);
    const replay = (await res.json()) as Record<string, any>;
    expect(replay.decision.answer_bridge.delivered_version).toBe(1);
    // Same request key twice → identical body (pure read, fixed clock).
    const again = (await (await get(`/decisions/${d.id}?expected_version=1&request_key=rk-2`)).json()) as Record<string, any>;
    expect(again).toEqual(replay);
  });

  it('reflects running and terminal result states and a concurrent version change', async () => {
    const d = raiseAutoship();
    answer(d.id, 1, 'a1');
    markDelivered(d.id, 1);
    db.prepare("UPDATE bot_decisions SET state='action_pending' WHERE id=?").run(d.id);
    s.result(worker, d.id, 1, 'start', { state: 'running', evidence: 'Fixture unchanged', material_evidence_unchanged: true });
    let body = (await (await get(`/decisions/${d.id}?expected_version=1&request_key=rk`)).json()) as Record<string, any>;
    expect(body.decision.state).toBe('running');
    expect(body.decision.result).toEqual({ kind: 'running', version: 1 });
    s.result(worker, d.id, 1, 'done', { state: 'verified_completed', evidence: 'Fixture inspected' });
    body = (await (await get(`/decisions/${d.id}?expected_version=1&request_key=rk`)).json()) as Record<string, any>;
    expect(body.decision.result).toMatchObject({ kind: 'terminal', state: 'verified_completed', version: 1 });

    // A revision between two reads: the second read with the old expected version is a 409 carrying only the current version.
    const d2 = raiseAutoship(worker, {}, 'autoship:order:100121928');
    expect((await get(`/decisions/${d2.id}?expected_version=1&request_key=rk`)).status).toBe(200);
    s.revise(worker, d2.id, 1, 'rev', proposalInputSchema.parse(autoshipProposal({ package_version: 1 })));
    const conflict = await get(`/decisions/${d2.id}?expected_version=1&request_key=rk`);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ ok: false, code: 'version_mismatch', current_version: 2, request_key: 'rk', expected_version: 1 });
    const fresh = (await (await get(`/decisions/${d2.id}?expected_version=2&request_key=rk`)).json()) as Record<string, any>;
    expect(fresh.decision.binding.package_version).toBe(1);
    expect(fresh.decision.answer_bridge).toEqual({ delivered_version: null, answer: null });
  });

  it('exposes template scope only as the scope field and never widens authority', async () => {
    const d = raiseAutoship(worker, { scope: 'shared_template', allow_solo_templates: false }, 'autoship:template:LIP-123');
    const body = (await (await get(`/decisions/${d.id}?expected_version=1&request_key=rk`)).json()) as Record<string, any>;
    expect(body.decision.binding).toMatchObject({ scope: 'shared_template', allow_solo_templates: false });
    expect(Object.keys(body.decision)).not.toContain('authorized');
  });

  it('denies wrong identity, other bots, other decisions, enumeration and every write with redacted bodies', async () => {
    const mine = raiseAutoship();
    const cs = s.raise(csBot, { source_key: 'autoship:order:1', proposal_key: 'p', proposal: proposalInputSchema.parse(autoshipProposal()) });
    const generic = s.raise(worker, { source_key: 'autoship:order:2', proposal_key: 'g', proposal: proposalInputSchema.parse({ question: 'q', recommendation: 'r', consequence: 'c', assignee_id: 1, blocked_action: 'b' }) });
    const offNamespace = raiseAutoship(worker, {}, 'order:3');
    const notFound = { ok: false, code: 'not_found' };
    const unauthorized = { ok: false, code: 'unauthorized' };
    for (const jwt of [null, token({ aud: 'owner-app-aud', email: 'owner@example.test' }), token({ aud: AUD, email: 'owner@example.test' }), token({ aud: AUD, common_name: 'other.access' }), 'x-vp-agent-token-value']) {
      const res = await get(`/decisions/${mine.id}?expected_version=1&request_key=rk`, jwt);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(unauthorized);
    }
    for (const id of [cs.id, generic.id, offNamespace.id, 'unknown-id', '../etc']) {
      const res = await get(`/decisions/${encodeURIComponent(id)}?expected_version=1&request_key=rk`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(notFound);
    }
    expect((await get(`/decisions/${mine.id}?request_key=rk`)).status).toBe(404); // missing expected_version
    expect((await get(`/decisions/${mine.id}?expected_version=1`)).status).toBe(404); // missing request_key
    expect((await get(`/decisions?expected_version=1&request_key=rk`)).status).toBe(404); // no listing
    expect((await get(`/`)).status).toBe(404);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await get(`/decisions/${mine.id}?expected_version=1&request_key=rk`, SERVICE, method);
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ ok: false, code: 'method_not_allowed' });
    }
    expect((await get(`/decisions/${mine.id}/answer`, SERVICE, 'POST')).status).toBe(404);
    // Unknown or unconfigured worker binding fails closed for everything.
    workerChatId = 'not-a-registration';
    expect((await get(`/decisions/${mine.id}?expected_version=1&request_key=rk`)).status).toBe(404);
    workerChatId = null;
    expect((await get(`/decisions/${mine.id}?expected_version=1&request_key=rk`)).status).toBe(404);
  });

  it('reports a non-human or inactive answering actor as no authority', async () => {
    const d = raiseAutoship();
    answer(d.id, 1, 'a1');
    db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
    const body = (await (await get(`/decisions/${d.id}?expected_version=1&request_key=rk`)).json()) as Record<string, any>;
    expect(body.decision.answer_bridge.answer).toMatchObject({ actor_is_human: true, actor_active: false });
    // Events are immutable, so a bot-authored "answer" can only appear via a forged row; a forged actor_conversation_id is surfaced, not trusted.
    db.pragma('foreign_keys=OFF');
    db.prepare('INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,actor_conversation_id,payload_json,request_key) VALUES(?,?,?,?,?,?,?,?)').run('forged', d.id, 1, 'answered', 1, CS_BOT, JSON.stringify({ action: 'approve', text: 'bot says yes', scope: 'this_case' }), 'forged');
    const forged = (await (await get(`/decisions/${d.id}?expected_version=1&request_key=rk`)).json()) as Record<string, any>;
    expect(forged.decision.answer_bridge.answer).toMatchObject({ actor_is_human: false, actor_conversation_id: CS_BOT });
  });
});
