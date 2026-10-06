import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { BotError } from './service.js';
import { readSecretValue } from '../secrets/readSecret.js';
import { boundedResolverGet } from './approvedCaseResolver.js';
import { createAutoshipVerifierResolver } from '../identity/autoshipVerifier.js';
import { canonicalSha256 } from './canonical.js';
import { exactRefund, type RefundIO } from './exactRefund.js';
import { registrySchema, uuid, associationResponse,lookupResponse,reconcileResponse,receiptResponse,revokeInput,revokeResponse,exportResponse, type Registration } from './exactRefundContract.js';
export function loadRefundRegistry(file: string | null | undefined) { let fd: number | undefined; try {
    if (!file || !path.isAbsolute(file))
        throw Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.size > 128 * 1024)
        throw Error();
    const b = Buffer.alloc(128 * 1024 + 1), n = fs.readSync(fd, b, 0, b.length, 0);
    if (n >= b.length)
        throw Error();
    return registrySchema.parse(JSON.parse(b.subarray(0, n).toString()));
}
catch {
    throw new BotError(503, 'EXACT_REFUND_UNAVAILABLE: dedicated protected registry absent or invalid');
}
finally {
    if (fd !== undefined)
        fs.closeSync(fd);
} }
export function refundIO(ctx: AppContext): RefundIO {
    const registration = (id: string) => { const rows = loadRefundRegistry(ctx.config.exactRefundRegistryFile).registrations.filter(x => x.id === id); if (rows.length !== 1)
        throw new BotError(503, 'Exact refund registration required'); return rows[0]!; };
    const get = async (r: Registration, suffix: string) => { if (canonicalSha256(registration(r.id)) !== canonicalSha256(r) || !r.readerCredential.name.startsWith('EXACT_REFUND_'))
        throw new BotError(503, 'Dedicated refund reader required'); const credential = (await readSecretValue({ db: ctx.db, projectDopplerCli: ctx.projectDopplerCli ?? null }, r.readerCredential)).value; if (canonicalSha256(registration(r.id)) !== canonicalSha256(r))
        throw new BotError(403, 'Refund custody changed'); let value: unknown; try {
        value = await boundedResolverGet(r.sourceOrigin + '/api/cs/exact-refund/' + suffix, credential, AbortSignal.timeout(10000));
    }
    catch {
        throw new BotError(503, 'Authenticated refund evidence unavailable');
    } if (canonicalSha256(registration(r.id)) !== canonicalSha256(r))
        throw new BotError(403, 'Refund custody changed'); return value; };
    return { registration, now: Date.now, evidence: r => get(r, 'evidence/' + uuid.parse(r.id)), intent: (r, id) => get(r, 'intents/' + uuid.parse(id)) };
}
const errors: express.ErrorRequestHandler = (e: unknown, _q, r, _n) => r.status(e instanceof BotError ? e.status : e instanceof z.ZodError ? 400 : 500).json({ error: e instanceof BotError ? e.message : e instanceof z.ZodError ? 'Invalid exact refund contract' : 'Exact refund verifier unavailable' });
export function exactRefundRoutes(ctx: AppContext, io: RefundIO = refundIO(ctx)) {
    const router = express.Router(), s = exactRefund(ctx.db, io);
    router.use(express.json({ limit: '256kb' }));
    router.use((_q, r, n) => { r.set('Cache-Control', 'no-store'); n(); });
    const actor = (q: express.Request) => ({ user: q.user!, conversationId: q.agentConversationId });
    const run = (fn: (q: express.Request) => unknown): express.RequestHandler => (q, r, n) => { void Promise.resolve().then(() => { z.object({}).strict().parse(q.query); return fn(q); }).then(v => r.json(v)).catch(n); };
    router.post('/exact-refund/inspect', run(q => s.inspect(actor(q), q.body)));
    router.post('/exact-refund/issue', run(q => s.issue(actor(q), q.body)));
    router.get('/exact-refund/authorities/:id', run(q => s.read(actor(q), uuid.parse(q.params.id))));
    router.post('/exact-refund/authorities/:id/revoke', run(q => { const p = revokeInput.parse(q.body); return revokeResponse.parse(s.revoke(actor(q), uuid.parse(q.params.id), p.reason)); }));
    router.use(errors);
    return router;
}
export function exactRefundVerifierRoutes(ctx: AppContext, override?: {
    io: RefundIO;
    cf: (q: express.Request, r: Registration) => Promise<boolean>;
}) {
    const router = express.Router(), io = override?.io ?? refundIO(ctx), s = exactRefund(ctx.db, io);
    router.use(express.json({ limit: '16kb' }));
    router.use((q, res, next) => {
        res.set('Cache-Control', 'no-store');
        void (async () => {
            const id = uuid.parse(q.headers['x-exact-refund-registration-id']), r = s.registration(id), c = ctx.config;
            const audiences = [c.cfAud, c.autoshipVerifierCfAud, c.returnVerifierCfAud, c.routineVerifierCfAud, c.purchaseTimingCfAud, c.autoshipCandidateCfAud], clients = [c.autoshipVerifierClientId, c.returnVerifierClientId, c.routineVerifierClientId, c.purchaseTimingClientId, c.autoshipCandidateClientId];
            for (const file of [c.composeServiceRegistryFile, c.caseCustodyRegistryFile, c.contactVerificationRegistryFile])
                if (file) {
                    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
                    for (const old of v.registrations ?? []) {
                        audiences.push(old.nativeAudience ?? old.audience);
                        clients.push(old.cfClientId);
                        if ((old.serviceCredentialHash ?? old.bearerHash) === r.bearerHash)
                            throw new BotError(403, 'Separate refund service credential required');
                    }
                }
            if (audiences.includes(r.audience) || clients.includes(r.cfClientId))
                throw new BotError(403, 'Separate refund service audience/client required');
            const bearer = q.headers.authorization;
            if (!bearer || !/^Bearer [^\s]{32,512}$/.test(bearer) || !crypto.timingSafeEqual(crypto.createHash('sha256').update(bearer.slice(7)).digest(), Buffer.from(r.bearerHash, 'hex')))
                throw new BotError(401, 'Dedicated refund service required');
            const cf = override?.cf ?? (async (q: express.Request, r: Registration) => !!await createAutoshipVerifierResolver({ ...c, autoshipVerifierCfAud: r.audience, autoshipVerifierClientId: r.cfClientId }, { log: { warn: () => { } } })(q));
            if (!await cf(q, r))
                throw new BotError(401, 'Dedicated refund CF service required');
            res.locals.registration = id;
            next();
        })().catch(next);
    });
    const run = (fn: (q: express.Request, id: string) => unknown): express.RequestHandler => (q, r, n) => { void Promise.resolve().then(() => { z.object({}).strict().parse(q.query); return fn(q, r.locals.registration); }).then(v => r.json(v)).catch(n); };
    router.get('/authorities/:id', run(async (q, id) => exportResponse.parse(s.verify(id, uuid.parse(q.params.id)))));
    router.post('/associations/lookup', run((q,id)=>lookupResponse.parse(s.lookup(id,q.body))));
    router.post('/associations', run(async (q, id) => associationResponse.parse(await s.associate(id, q.body))));
    router.get('/associations/:id', run((q, id) => reconcileResponse.parse(s.reconcile(id, uuid.parse(q.params.id)))));
    router.post('/receipts/:id', run(async (q, id) => { z.object({}).strict().parse(q.body); return receiptResponse.parse(await s.receipt(id, uuid.parse(q.params.id))); }));
    router.use((_q, r) => r.status(405).json({ error: 'Unsupported refund verifier operation' }));
    router.use(errors);
    return router;
}
