import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { readSecretValue } from '../secrets/readSecret.js';
import { createAutoshipVerifierResolver } from '../identity/autoshipVerifier.js';
import { boundedResolverGet } from './approvedCaseResolver.js';
import { canonicalSha256 } from './canonical.js';
import { BotError } from './service.js';
import { mergeAuthorization, type MergeIO } from './mergeAuthorization.js';
import { registrySchema, uuid, text, type Registration } from './mergeAuthorizationContract.js';

export function loadMergeRegistry(file: string | null | undefined) {
  let fd: number | undefined;
  try {
    if (!file || !path.isAbsolute(file)) throw Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > 128 * 1024) throw Error();
    const b = Buffer.alloc(128 * 1024 + 1), n = fs.readSync(fd, b, 0, b.length, 0);
    if (n > b.length - 1) throw Error();
    return registrySchema.parse(JSON.parse(b.subarray(0, n).toString()));
  } catch { throw new BotError(503, 'MERGE_AUTHORIZATION_UNAVAILABLE: dedicated protected registry absent or invalid'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function mergeIO(ctx: AppContext): MergeIO {
  const registration = (id: string) => { const rs = loadMergeRegistry(ctx.config.mergeAuthorizationRegistryFile).registrations.filter((r) => r.id === id); if (rs.length !== 1) throw new BotError(503, 'Exact merge registration required'); return rs[0]!; };
  return {
    registration, now: Date.now,
    registrations: () => { try { return loadMergeRegistry(ctx.config.mergeAuthorizationRegistryFile).registrations; } catch { return []; } },
    async attemptReadback(r: Registration, attemptId: string) {
      const before = canonicalSha256(registration(r.id));
      if (before !== canonicalSha256(r)) throw new BotError(503, 'Dedicated merge readback credential required');
      const value = (await readSecretValue({ db: ctx.db, projectDopplerCli: ctx.projectDopplerCli ?? null }, r.readbackCredential)).value;
      if (canonicalSha256(registration(r.id)) !== before) throw new BotError(403, 'Custody changed');
      try { return await boundedResolverGet(`${r.sourceOrigin}/api/cs/merge-attempts/${uuid.parse(attemptId)}`, value, AbortSignal.timeout(10000)); }
      catch { throw new BotError(503, 'Authenticated merge attempt readback unavailable'); }
    },
  };
}
const errors: express.ErrorRequestHandler = (e: unknown, _req, res, _next) => { res.status(e instanceof BotError ? e.status : e instanceof z.ZodError ? 400 : 500).json({ error: e instanceof BotError ? e.message : e instanceof z.ZodError ? 'Invalid merge authorization contract' : 'Merge authorization unavailable' }); };

/** Owner/reviewer/executor surface, mounted under /api/bots. Bots never call the service routes. */
export function mergeAuthorizationRoutes(ctx: AppContext, io: MergeIO = mergeIO(ctx)) {
  const router = express.Router(), s = mergeAuthorization(ctx.db, io);
  router.use(express.json({ limit: '64kb' }));
  router.use((_q, r, n) => { r.set('Cache-Control', 'no-store'); n(); });
  const run = (f: (q: express.Request) => unknown): express.RequestHandler => (q, r, n) => { void Promise.resolve().then(() => { z.object({}).strict().parse(q.query); return f(q); }).then((v) => r.json(v)).catch(n); };
  const actor = (q: express.Request) => ({ user: q.user!, conversationId: q.agentConversationId });
  router.get('/merge-authorization/status', run((q) => s.status(actor(q))));
  router.post('/merge-authorization/enroll', run((q) => { const p = z.object({ registrationId: uuid }).strict().parse(q.body); return s.enroll(actor(q), p.registrationId); }));
  router.get('/merge-authorization/:registrationId/intents/:pairReceiptId', run((q) => s.readIntentAs(actor(q), uuid.parse(q.params.registrationId), uuid.parse(q.params.pairReceiptId))));
  router.post('/merge-authorization/reservations/:id/revoke', run((q) => { const p = z.object({ reason: text }).strict().parse(q.body); return s.revoke(actor(q), uuid.parse(q.params.id), p.reason); }));
  router.use(errors);
  return router;
}

/** Service-only routes (proposal §2–§7), mounted at /api/cs/merge-authorization. Dedicated custody: separate bearer, CF audience and client. */
export function mergeAuthorizationServiceRoutes(ctx: AppContext, override?: { io: MergeIO; cf: (q: express.Request, r: Registration) => Promise<boolean> }) {
  const router = express.Router(), io = override?.io ?? mergeIO(ctx), s = mergeAuthorization(ctx.db, io);
  router.use(express.json({ limit: '32kb' }));
  router.use((q, r, n) => {
    r.set('Cache-Control', 'no-store');
    void (async () => {
      const id = uuid.parse(q.headers['x-merge-authorization-registration-id']), reg = s.registration(id), c = ctx.config;
      const audiences = [c.cfAud, c.autoshipVerifierCfAud, c.returnVerifierCfAud, c.routineVerifierCfAud, c.purchaseTimingCfAud, c.autoshipCandidateCfAud];
      const clients = [c.autoshipVerifierClientId, c.returnVerifierClientId, c.routineVerifierClientId, c.purchaseTimingClientId, c.autoshipCandidateClientId];
      if (audiences.includes(reg.audience) || clients.includes(reg.cfClientId)) throw new BotError(403, 'Separate merge authorization service required');
      const bearer = q.headers.authorization;
      if (!bearer || !/^Bearer [^\s]{32,512}$/.test(bearer) || !crypto.timingSafeEqual(crypto.createHash('sha256').update(bearer.slice(7)).digest(), Buffer.from(reg.bearerHash, 'hex'))) throw new BotError(401, 'Dedicated merge authorization service required');
      const cf = override?.cf ?? (async (q: express.Request, r: Registration) => !!await createAutoshipVerifierResolver({ ...c, autoshipVerifierCfAud: r.audience, autoshipVerifierClientId: r.cfClientId }, { log: { warn: () => {} } })(q));
      if (!await cf(q, reg)) throw new BotError(401, 'Dedicated merge authorization CF service required');
      r.locals.registration = id;
      n();
    })().catch(n);
  });
  const run = (f: (q: express.Request, id: string) => unknown): express.RequestHandler => (q, r, n) => { void Promise.resolve().then(() => { z.object({}).strict().parse(q.query); return f(q, r.locals.registration); }).then((v) => r.json(v)).catch(n); };
  router.post('/cases', run((q, id) => s.registerCases(id, q.body)));
  router.post('/intents', run((q, id) => s.registerIntent(id, q.body)));
  router.get('/intents/:pairReceiptId', run((q, id) => s.readIntentFor(id, uuid.parse(q.params.pairReceiptId))));
  router.post('/reservations', run((q, id) => s.reserve(id, q.body)));
  router.post('/reservations/:id/redeem', run((q, id) => s.redeem(id, uuid.parse(q.params.id), q.body)));
  router.get('/reservations/:id', run((q, id) => s.readReservation(id, uuid.parse(q.params.id))));
  router.get('/reservation-requests/:requestKey', run((q, id) => s.readByRequestKey(id, uuid.parse(q.params.requestKey))));
  router.post('/reservations/:id/nonexecution', run((q, id) => s.nonexecution(id, uuid.parse(q.params.id), q.body)));
  router.get('/receipts/:eventId', run((q, id) => s.receipt(id, z.string().regex(/^[a-zA-Z0-9_.:-]{1,150}$/).parse(q.params.eventId))));
  router.get('/merge-approvals/:decisionId/:version', run((q, id) => s.exportApproval(id, z.string().min(1).max(200).parse(q.params.decisionId), z.coerce.number().int().positive().parse(q.params.version))));
  router.use((_q, r) => r.status(405).json({ error: 'Unsupported merge authorization operation' }));
  router.use(errors);
  return router;
}
