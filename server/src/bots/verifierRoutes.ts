import express, { type Router } from 'express';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { createAutoshipVerifierResolver, type AutoshipVerifierResolver } from '../identity/autoshipVerifier.js';
import { canonicalSha256 } from './canonical.js';
import { autoshipBinding, autoshipProposalSchema, type Decision } from './service.js';

/**
 * AutoShip decision verifier (option A, docs/autoship-answer-bridge.md).
 * Read-only, GET one decision by exact id, for the dedicated OrderOps service
 * identity only. Everything that is not the one enrolled worker's AutoShip
 * decision is a 404 with an identical body; every write is 405; identity
 * failures are 401; a version mismatch is 409 with the current version only.
 * Nothing here can answer, send, list or reveal chat history.
 */
export interface VerifierDeps {
  db: Database.Database;
  config: Pick<Config, 'identity' | 'cfTeamDomain' | 'autoshipVerifierCfAud' | 'autoshipVerifierClientId' | 'autoshipWorkerChatId'>;
  resolveVerifier?: AutoshipVerifierResolver;
  log?: Pick<Console, 'warn'>;
  now?: () => Date;
}

const NOT_FOUND = { ok: false, code: 'not_found' } as const;
const UNAUTHORIZED = { ok: false, code: 'unauthorized' } as const;
const ID_RE = /^[A-Za-z0-9-]{1,80}$/;
const REQUEST_KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;

export function createAutoshipVerifierRouter(deps: VerifierDeps): Router {
  const router = express.Router();
  const resolve = deps.resolveVerifier ?? createAutoshipVerifierResolver(deps.config, { log: deps.log });
  const now = deps.now ?? (() => new Date());
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  // Identity first: without the enrolled service JWT nothing else is observable.
  router.use((req, res, next) => {
    void resolve(req).then(
      (identity) => (identity ? next() : res.status(401).json(UNAUTHORIZED)),
      () => res.status(401).json(UNAUTHORIZED),
    );
  });
  router.all('/decisions/:id', (req, res, next) => {
    if (req.method !== 'GET') return void res.status(405).json({ ok: false, code: 'method_not_allowed' });
    next();
  });
  router.get('/decisions/:id', (req, res) => {
    const workerId = deps.config.autoshipWorkerChatId;
    const id = String(req.params.id ?? '');
    const requestKey = String(req.query.request_key ?? '');
    const expectedRaw = String(req.query.expected_version ?? '');
    if (!workerId || !ID_RE.test(id) || !REQUEST_KEY_RE.test(requestKey) || !/^\d{1,9}$/.test(expectedRaw)) {
      return void res.status(404).json(NOT_FOUND);
    }
    const expectedVersion = Number(expectedRaw);
    // Binding is to the verified registration row, never a name.
    const worker = deps.db
      .prepare('SELECT conversation_id, name, active FROM bot_registrations WHERE conversation_id=?')
      .get(workerId) as { conversation_id: string; name: string; active: number } | undefined;
    if (!worker) return void res.status(404).json(NOT_FOUND);
    const d = deps.db
      .prepare('SELECT * FROM bot_decisions WHERE id=? AND conversation_id=?')
      .get(id, worker.conversation_id) as Decision | undefined;
    if (!d || !d.source_key.startsWith('autoship:')) return void res.status(404).json(NOT_FOUND);
    const parsed = autoshipProposalSchema.safeParse(JSON.parse(d.proposal_json));
    if (!parsed.success) return void res.status(404).json(NOT_FOUND);
    const proposal = parsed.data;
    if (d.version !== expectedVersion) {
      return void res.status(409).json({ ok: false, code: 'version_mismatch', current_version: d.version, request_key: requestKey, expected_version: expectedVersion });
    }
    const delivered = deps.db
      .prepare(
        `SELECT max(e.version) AS version FROM bot_decision_events e
         JOIN conversation_wakeups w ON w.id=e.id
         WHERE e.decision_id=? AND e.kind='answered' AND w.status='delivered'`,
      )
      .get(d.id) as { version: number | null };
    const answered = deps.db
      .prepare(
        `SELECT e.actor_id, e.actor_conversation_id, e.created_at, e.request_key, e.payload_json, u.status AS actor_status
         FROM bot_decision_events e LEFT JOIN users u ON u.id=e.actor_id
         WHERE e.decision_id=? AND e.version=? AND e.kind='answered' ORDER BY e.rowid DESC LIMIT 1`,
      )
      .get(d.id, d.version) as
      | { actor_id: number; actor_conversation_id: string | null; created_at: string; request_key: string; payload_json: string; actor_status: string | null }
      | undefined;
    const result = d.result_json ? (JSON.parse(d.result_json) as { state?: string; version?: number }) : null;
    const resultState = result?.state ?? null;
    const resultSummary =
      d.state === 'running'
        ? { kind: 'running' as const, version: d.version }
        : resultState && ['verified_completed', 'blocked', 'failed'].includes(resultState)
          ? { kind: 'terminal' as const, state: resultState, version: result?.version ?? d.version }
          : { kind: 'no_result' as const };
    const binding = autoshipBinding(proposal);
    const answerPayload = answered ? (JSON.parse(answered.payload_json) as { action?: string; text?: string; scope?: string }) : null;
    res.json({
      ok: true,
      contract: 'autoship-answer-bridge/v1',
      served_at: now().toISOString(),
      request_key: requestKey,
      expected_version: expectedVersion,
      decision: {
        id: d.id,
        assigned_worker_id: worker.conversation_id,
        worker_registration_active: Boolean(worker.active),
        source_key: d.source_key,
        proposal_key: d.proposal_key,
        current_version: d.version,
        state: d.state,
        kind: proposal.kind,
        binding,
        binding_hash: proposal.binding_hash,
        proposal_hash: canonicalSha256({ kind: proposal.kind, source_key: d.source_key, proposal_key: d.proposal_key, binding }),
        answer_bridge: {
          delivered_version: delivered.version ?? null,
          answer: answered
            ? {
                raw: { action: answerPayload?.action ?? null, text: answerPayload?.text ?? null, scope: answerPayload?.scope ?? null },
                actor_id: answered.actor_id,
                actor_conversation_id: answered.actor_conversation_id,
                actor_is_human: answered.actor_conversation_id === null,
                actor_active: answered.actor_status === 'active',
                answered_at: answered.created_at,
                request_key: answered.request_key,
                source: 'veneer.bot_decision_events',
              }
            : null,
        },
        result: resultSummary,
      },
    });
  });
  router.use((_req, res) => void res.status(404).json(NOT_FOUND));
  return router;
}
