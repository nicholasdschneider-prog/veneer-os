import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Config } from '../config.js';
import { createAutoshipVerifierResolver } from '../identity/autoshipVerifier.js';
import { routineExecutionService, type RoutineIdentity } from './routineExecution.js';
import { BotError } from './service.js';
export function configuredRoutineIdentity(c: Config | undefined): RoutineIdentity | null {
  if (!c) return null;
  const aud = c.routineVerifierCfAud, client = c.routineVerifierClientId;
  if (!aud || !client || [c.cfAud, c.autoshipVerifierCfAud, c.returnVerifierCfAud].includes(aud) || [c.autoshipVerifierClientId, c.returnVerifierClientId].includes(client)) return null;
  return { clientId: client, audience: aud };
}
export function routineVerifierRoutes(ctx: AppContext, override?: (req: express.Request) => Promise<RoutineIdentity | null>) {
  const r = express.Router(), configured = configuredRoutineIdentity(ctx.config), s = routineExecutionService(ctx.db);
  const resolver = createAutoshipVerifierResolver({ ...ctx.config, autoshipVerifierCfAud: configured?.audience ?? null, autoshipVerifierClientId: configured?.clientId ?? null }, { log: { warn: () => {} } });
  r.use(express.json({ limit: '256kb' }));
  r.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    void (override ? override(req) : resolver(req).then(id => id && configured ? configured : null)).then(id => {
      if (!id) { res.status(401).json({ error: 'Dedicated routine verifier identity required' }); return; }
      res.locals.routineIdentity = id; next();
    }).catch(() => res.status(401).json({ error: 'Routine identity rejected' }));
  });
  const run = (fn: (req: express.Request, id: RoutineIdentity) => unknown) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try { res.json(fn(req, res.locals.routineIdentity)); }
    catch (e) { if (e instanceof BotError) res.status(e.status).json({ error: e.message }); else if (e instanceof z.ZodError) res.status(400).json({ error: 'Invalid routine source contract' }); else next(e); }
  };
  r.post('/scope-evidence', run((req,id)=>s.scopeEvidence(id,req.body)));
  r.post('/native-context', run((req,id)=>s.nativeContext(id,req.body)));
  r.post('/dispatch-claims', run((req,id)=>s.dispatchClaim(id,req.body)));
  r.post('/captures', run((req, id) => s.capture(id, req.body)));
  r.post('/readbacks', run((req, id) => s.readback(id, req.body)));
  r.get('/drafts/:id', run((req, id) => s.reconcile(id, req.params.id!)));
  r.use((_req, res) => res.status(405).json({ error: 'Unsupported routine verifier operation' }));
  return r;
}
