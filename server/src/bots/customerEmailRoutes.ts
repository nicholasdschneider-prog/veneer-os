import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { BotError, type Actor } from './service.js';
import { customerEmailService } from './customerEmail.js';
import { emailSourceIO, type EmailIO } from './customerEmailIO.js';
import { emailEnrollment, emailRegistrationCurrent, emailBearer } from './customerEmailTrust.js';
import { emailId, type EmailRegistration } from './customerEmailContract.js';
import { createAutoshipVerifierResolver } from '../identity/autoshipVerifier.js';
export function customerEmailRoutes(ctx: AppContext, io: EmailIO = emailSourceIO(ctx)) {
    const router = express.Router(), service = customerEmailService(ctx.db, io), enrollment = emailEnrollment(ctx.db, io.registration, io.now);
    const actor = (req: express.Request): Actor => ({
        user: req.user!, conversationId: req.agentConversationId
    });
    const run = (fn: (a: Actor, p: unknown) => unknown) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
        res.set('Cache-Control', 'no-store');
        void Promise.resolve().then(() => fn(actor(req), req.body)).then(x => res.json(x)).catch(next);
    };
    router.post('/context', run(service.context));
    router.post('/inspect', run(service.inspect));
    router.post('/bind', run(service.bind));
    router.post('/read', run(service.read));
    router.post('/lookup', run(service.lookup));
    router.post('/accept', run(service.accept));
    router.post('/claim', run(service.claim));
    router.post('/receipt', run(service.receipt));
    router.post('/revoke', run(service.revoke));
    router.post('/enrollment/prepare', run(enrollment.prepare));
    router.post('/enrollment/confirm', run(enrollment.confirm));
    router.post('/enrollment/revoke', run(enrollment.revoke));
    router.use(emailErrors);
    return router;
}
export function customerEmailVerifierRoutes(ctx: AppContext, override?: {
    io: EmailIO;
    cf: (req: express.Request, r: EmailRegistration) => Promise<boolean>;
}) {
    const router = express.Router(), io = override?.io ?? emailSourceIO(ctx), service = customerEmailService(ctx.db, io);
    router.use(express.json({
        limit: '16kb'
    }));
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        void (async () => {
            const id = emailId.parse(req.headers['x-customer-email-registration-id']), r = io.registration(id);
            emailRegistrationCurrent(ctx.db, r, io.now());
            const c = ctx.config;
            if ([c.cfAud, c.autoshipVerifierCfAud, c.returnVerifierCfAud, c.routineVerifierCfAud, c.purchaseTimingCfAud, c.autoshipCandidateCfAud].includes(r.nativeAudience) || [c.autoshipVerifierClientId, c.returnVerifierClientId, c.routineVerifierClientId, c.purchaseTimingClientId, c.autoshipCandidateClientId].includes(r.cfClientId))
                throw new BotError(403, 'Separate customer email CF service audience required');
            const cf = override?.cf ?? (async (req: express.Request, r: EmailRegistration) => !!await createAutoshipVerifierResolver({
                ...c, autoshipVerifierCfAud: r.nativeAudience, autoshipVerifierClientId: r.cfClientId
            }, {
                log: {
                    warn: () => {
                    }
                }
            })(req));
            if (!emailBearer(req.headers.authorization, r) || !await cf(req, r))
                throw new BotError(401, 'Dedicated customer email service identity required');
            res.locals.registrationId = id;
            next();
        })().catch(next);
    });
    const run = (f: (req: express.Request, id: string) => unknown) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
        void Promise.resolve().then(() => f(req, res.locals.registrationId)).then(x => res.json(x)).catch(next);
    };
    router.get('/authorities/:id', run((req, id) => {
        z.object({}).strict().parse(req.query);
        return service.serviceAuthority(id, emailId.parse(req.params.id));
    }));
    router.get('/authorities/:id/context', run((req, id) => {
        z.object({}).strict().parse(req.query);
        return service.serviceContext(id, emailId.parse(req.params.id));
    }));
    router.post('/associations', run((req, id) => {
        z.object({}).strict().parse(req.query);
        return service.associate(id, req.body);
    }));
    router.post('/associations/lookup', run((req, id) => {
        z.object({}).strict().parse(req.query);
        return service.serviceAssociation(id, req.body);
    }));
    router.post('/authorities/:id/readback', run((req, id) => {
        z.object({}).strict().parse(req.body);
        z.object({}).strict().parse(req.query);
        return service.serviceReadback(id, emailId.parse(req.params.id));
    }));
    router.use((_req, res) => res.status(405).json({
        error: 'Unsupported customer email service operation'
    }));
    router.use(emailErrors);
    return router;
}
const emailErrors: express.ErrorRequestHandler = (e, _req, res, _next) => {
    res.status(e instanceof BotError ? e.status : e instanceof z.ZodError ? 400 : 500).json({
        error: e instanceof BotError ? e.message : e instanceof z.ZodError ? 'Invalid customer email contract' : 'Customer email operation failed'
    });
};
