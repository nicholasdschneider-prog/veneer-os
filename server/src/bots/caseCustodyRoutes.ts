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
import { caseCustody, type CustodyIO } from './caseCustody.js';
import { registrySchema, uuid, hash, text, claimResponseSchema, claimReconciliationSchema, inspectionResponseSchema, exportResponseSchema, issueResponseSchema, readResponseSchema, receiptResponseSchema, revokeResponseSchema, type Registration } from './caseCustodyContract.js';
export function loadCustodyRegistry(file: string | null | undefined) { let fd: number | undefined; try {
    if (!file || !path.isAbsolute(file))
        throw Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > 128 * 1024)
        throw Error();
    const b = Buffer.alloc(128 * 1024 + 1), n = fs.readSync(fd, b, 0, b.length, 0);
    if (n > b.length - 1)
        throw Error();
    return registrySchema.parse(JSON.parse(b.subarray(0, n).toString()));
}
catch {
    throw new BotError(503, 'CUSTODY_BOUNDARY_UNAVAILABLE: dedicated protected registry absent or invalid');
}
finally {
    if (fd !== undefined)
        fs.closeSync(fd);
} }
export function custodyIO(ctx: AppContext): CustodyIO {
    const registration = (id: string) => { const rs = loadCustodyRegistry(ctx.config.caseCustodyRegistryFile).registrations.filter(r => r.id === id); if (rs.length !== 1)
        throw new BotError(503, 'Exact custody registration required'); return rs[0]!; };
    const get = async (r: Registration, suffix: string) => {
        const before = canonicalSha256(registration(r.id));
        if (before !== canonicalSha256(r) || !r.readerCredential.name.startsWith('CASE_CUSTODY_'))
            throw new BotError(503, 'Dedicated custody reader required');
        const value = (await readSecretValue({ db: ctx.db, projectDopplerCli: ctx.projectDopplerCli ?? null }, r.readerCredential)).value;
        if (canonicalSha256(registration(r.id)) !== before)
            throw new BotError(403, 'Custody changed');
        let result: unknown;
        try {
            result = await boundedResolverGet(r.sourceOrigin + '/api/cs/custody/' + suffix, value, AbortSignal.timeout(10000));
        }
        catch {
            throw new BotError(503, 'Authenticated custody source unavailable');
        }
        if (canonicalSha256(registration(r.id)) !== before)
            throw new BotError(403, 'Custody changed');
        return result;
    };
    return { registration, now: Date.now, evidence: (r, id) => get(r, 'evidence/' + uuid.parse(id)), intent: (r, id) => get(r, 'intents/' + uuid.parse(id)) };
}
const errors: express.ErrorRequestHandler = (e: unknown, _req, res, _next) => { res.status(e instanceof BotError ? e.status : e instanceof z.ZodError ? 400 : 500).json({ error: e instanceof BotError ? e.message : e instanceof z.ZodError ? 'Invalid custody contract' : 'Custody operation unavailable' }); };
export function caseCustodyRoutes(ctx: AppContext, io: CustodyIO = custodyIO(ctx)) {
    const router = express.Router(), s = caseCustody(ctx.db, io);
    router.use(express.json({ limit: '256kb' }));
    router.use((_q, r, n) => { r.set('Cache-Control', 'no-store'); n(); });
    const run = (f: (q: express.Request) => unknown): express.RequestHandler => (q, r, n) => { void Promise.resolve().then(() => { z.object({}).strict().parse(q.query); return f(q); }).then(v => r.json(v)).catch(n); };
    const actor = (q: express.Request) => ({ user: q.user!, conversationId: q.agentConversationId });
    router.post('/case-custody/inspect', run(async (q) => inspectionResponseSchema.parse(await s.inspect(actor(q), q.body))));
    router.post('/case-custody/issue', run(async (q) => issueResponseSchema.parse(await s.issue(actor(q), q.body))));
    router.get('/case-custody/authorities/:id', run(q => readResponseSchema.parse(s.read(actor(q), uuid.parse(q.params.id)))));
    router.post('/case-custody/authorities/:id/revoke', run(q => { const p = z.object({ reason: text }).strict().parse(q.body); return revokeResponseSchema.parse(s.revoke(actor(q), uuid.parse(q.params.id), p.reason)); }));
    router.post('/case-custody/enrollment/prepare', run(q => { const p = z.object({ registrationId: uuid, caseId: uuid }).strict().parse(q.body); return s.prepareEnrollment(actor(q), p.registrationId, p.caseId); }));
    router.post('/case-custody/enrollment/confirm', run(q => { const p = z.object({ registrationId: uuid, caseId: uuid, enrollmentHash: hash }).strict().parse(q.body); return s.enroll(actor(q), p.registrationId, p.caseId, p.enrollmentHash); }));
    router.use(errors);
    return router;
}
export function caseCustodyVerifierRoutes(ctx: AppContext, override?: {
    io: CustodyIO;
    cf: (q: express.Request, r: Registration) => Promise<boolean>;
}) {
    const router = express.Router(), io = override?.io ?? custodyIO(ctx), s = caseCustody(ctx.db, io);
    router.use(express.json({ limit: '16kb' }));
    router.use((q, r, n) => {
        r.set('Cache-Control', 'no-store');
        void (async () => {
            const id = uuid.parse(q.headers['x-case-custody-registration-id']), reg = s.registration(id), c = ctx.config;
            const audiences = [c.cfAud, c.autoshipVerifierCfAud, c.returnVerifierCfAud, c.routineVerifierCfAud, c.purchaseTimingCfAud, c.autoshipCandidateCfAud];
            const clients = [c.autoshipVerifierClientId, c.returnVerifierClientId, c.routineVerifierClientId, c.purchaseTimingClientId, c.autoshipCandidateClientId];
            // No composed-SMS trust reuse, including protected registry clients.
            if (c.composeServiceRegistryFile) {
                const value = JSON.parse(fs.readFileSync(c.composeServiceRegistryFile, 'utf8'));
                for (const row of value.registrations ?? []) {
                    audiences.push(row.nativeAudience);
                    clients.push(row.cfClientId);
                    if (row.serviceCredentialHash === reg.bearerHash)
                        throw new BotError(403, 'Separate custody credential required');
                }
            }
            if (audiences.includes(reg.audience) || clients.includes(reg.cfClientId))
                throw new BotError(403, 'Separate custody service required');
            const bearer = q.headers.authorization;
            if (!bearer || !/^Bearer [^\s]{32,512}$/.test(bearer) || !crypto.timingSafeEqual(crypto.createHash('sha256').update(bearer.slice(7)).digest(), Buffer.from(reg.bearerHash, 'hex')))
                throw new BotError(401, 'Dedicated custody service required');
            const cf = override?.cf ?? (async (q: express.Request, r: Registration) => !!await createAutoshipVerifierResolver({ ...c, autoshipVerifierCfAud: r.audience, autoshipVerifierClientId: r.cfClientId }, { log: { warn: () => { } } })(q));
            if (!await cf(q, reg))
                throw new BotError(401, 'Dedicated custody CF service required');
            r.locals.registration = id;
            n();
        })().catch(n);
    });
    const run = (f: (q: express.Request, id: string) => unknown): express.RequestHandler => (q, r, n) => { void Promise.resolve().then(() => { z.object({}).strict().parse(q.query); return f(q, r.locals.registration); }).then(v => r.json(v)).catch(n); };
    router.get('/authorities/:id', run(async (q, id) => exportResponseSchema.parse(await s.verify(id, uuid.parse(q.params.id)))));
    router.post('/claims', run(async (q, id) => claimResponseSchema.parse(await s.claim(id, q.body))));
    router.get('/claims/:id', run((q, id) => claimReconciliationSchema.parse(s.claimRead(id, uuid.parse(q.params.id)))));
    router.post('/receipts/:id', run(async (q, id) => { z.object({}).strict().parse(q.body); return receiptResponseSchema.parse(await s.receipt(id, uuid.parse(q.params.id))); }));
    router.use((_q, r) => r.status(405).json({ error: 'Unsupported custody verifier operation' }));
    router.use(errors);
    return router;
}
