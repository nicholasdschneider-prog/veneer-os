import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { FixturePreparationStore, ManifestSchema } from './store.js';
import { fixtureReadiness } from './readiness.js';
import { CodexFixtureSetup } from './codexSetup.js';

/** Mounted AFTER native identity/user/employee boundaries. Preparation is human
 * owner only; agent bearer tokens cannot enroll profiles or submit inputs here.
 * Only the fixed pre-auth executable can be bootstrapped: no command/profile
 * upload endpoint, native thread/login/inference path or ctx.manager dependency.
 */
export function createFixtureTestsRouter(ctx: Pick<AppContext, 'config'>, suppliedStore?: FixturePreparationStore,
  suppliedSetup?: CodexFixtureSetup) {
  const router = express.Router();
  let store = suppliedStore;
  let setup = suppliedSetup;
  router.use((req, res, next) => {
    if (!req.user || req.user.role !== 'owner' || req.agentConversationId || req.user.botSession) {
      res.status(403).json({ error: 'FIXTURE_HUMAN_OWNER_REQUIRED', execute: false }); return;
    }
    res.set('Cache-Control', 'no-store');
    next();
  });
  function ledger() {
    if (!store) {
      const directory = path.join(ctx.config.dataDir, 'fixture-tests');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(directory).isDirectory()) throw new Error('FIXTURE_STORAGE_UNAVAILABLE');
      fs.chmodSync(directory, 0o700);
      const file = path.join(directory, 'preparation.sqlite');
      const existing = fs.lstatSync(file, { throwIfNoEntry: false });
      if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error('FIXTURE_STORAGE_UNAVAILABLE');
      store = new FixturePreparationStore(file);
      fs.chmodSync(file, 0o600);
    }
    return store;
  }
  const wrap = (action: (req: express.Request, res: express.Response) => void): express.RequestHandler => (req, res) => {
    try { action(req, res); }
    catch (error) {
      // Never echo submitted payloads, Zod issues or internal paths.
      const code = error instanceof z.ZodError ? 'FIXTURE_INVALID_INPUT' : error instanceof Error ? error.message : '';
      const known = /^FIXTURE_[A-Z_]+$/.test(code) || code === 'ISOLATED_NATIVE_PROCESS_HOST_UNAVAILABLE';
      const status = code === 'FIXTURE_RUN_NOT_FOUND' ? 404 : code === 'FIXTURE_INVALID_INPUT' ? 400
        : code === 'ISOLATED_NATIVE_PROCESS_HOST_UNAVAILABLE' ? 503 : known ? 409 : 500;
      res.status(status).json({ error: known ? code : 'FIXTURE_STORAGE_UNAVAILABLE', ...fixtureReadiness() });
    }
  };
  router.get('/readiness', (_req, res) => { res.json(fixtureReadiness()); });
  function supervisor() {
    if (!setup) setup = new CodexFixtureSetup(path.join(ctx.config.dataDir, 'fixture-codex-host'), ctx.config.sourceDir);
    return setup;
  }
  const asyncWrap = (action: (req: express.Request) => Promise<unknown> | unknown): express.RequestHandler => (req, res) => {
    Promise.resolve().then(() => action(req)).then(result => res.json(result)).catch(error => {
      const code = error instanceof z.ZodError ? 'FIXTURE_INVALID_INPUT' : error instanceof Error ? error.message : '';
      res.status(code === 'FIXTURE_INVALID_INPUT' ? 400 : 409).json({
        error: /^FIXTURE_[A-Z_]+$/.test(code) ? code : 'FIXTURE_HOST_UNAVAILABLE', execute: false,
      });
    });
  };
  router.post('/codex-host/setup', asyncWrap(req => {
    const { requestKey } = z.object({ requestKey: z.string() }).strict().parse(req.body);
    return supervisor().setup(req.user!.id, requestKey);
  }));
  router.post('/codex-host/training', asyncWrap(req => {
    const input = z.object({ requestKey: z.string(), snapshot: z.unknown() }).strict().parse(req.body);
    return supervisor().publishTraining(req.user!.id, input.requestKey, input.snapshot);
  }));
  router.post('/codex-host/runs', asyncWrap(req => {
    const input = z.object({ requestKey: z.string(), coupling: z.unknown() }).strict().parse(req.body);
    return supervisor().materialize(req.user!.id, input.requestKey, input.coupling);
  }));
  router.get('/codex-host/runs/:id', asyncWrap(req => supervisor().read(req.user!.id, req.params.id!)));
  router.post('/codex-host/runs/:id/fixture-tools', asyncWrap(req => supervisor().call(req.user!.id, req.params.id!, req.body)));
  router.post('/codex-host/:id/device-sign-in/setup', asyncWrap(req => {
    z.object({}).strict().parse(req.body);
    return supervisor().deviceSetup(req.user!.id, req.params.id!);
  }));
  router.post('/runs', wrap((req, res) => {
    const input = z.object({ requestKey: z.string(), manifest: ManifestSchema }).strict().parse(req.body);
    res.status(201).json(ledger().create(req.user!.id, input.requestKey, input.manifest));
  }));
  router.get('/runs/:id', wrap((req, res) => { res.json(ledger().read(req.user!.id, req.params.id!)); }));
  router.post('/runs/:id/inputs', wrap((req, res) => { res.status(202).json(ledger().submit(req.user!.id, req.params.id!, req.body)); }));
  router.post('/runs/:id/start', wrap((req, _res) => { ledger().admit(req.user!.id, req.params.id!); }));
  router.post('/runs/:id/stop', wrap((req, res) => { res.json(ledger().stop(req.user!.id, req.params.id!)); }));
  router.get('/runs/:id/trace', wrap((req, res) => {
    const after = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(req.query.after ?? 0);
    res.json(ledger().trace(req.user!.id, req.params.id!, after));
  }));
  router.get('/runs/:id/monitor', wrap((req, res) => { res.json(ledger().monitor(req.user!.id, req.params.id!)); }));
  return router;
}
