import { isEmployee } from '../bots/employeeAccess.js';
import type { Request, Response, Router } from 'express';
import express from 'express';
import type { AppContext } from '../context.js';
import { findUserByEmail } from '../context.js';
import { proxyHeaders, proxyHttpRequest } from '../miniApps/proxy.js';
import type { MiniAppRow } from '../miniApps/types.js';

function appHeaders(req: Request, app: MiniAppRow, tenant: string) {
  const headers = proxyHeaders(req.headers);
  for (const name of [
    'cf-access-jwt-assertion',
    'cf-access-authenticated-user-email',
    'cf-access-client-id',
    'cf-access-client-secret',
    'x-vp-agent-token',
    'x-veneer-app-id',
    'x-veneer-tenant',
  ]) {
    delete headers[name];
  }
  const safeCookies = String(headers.cookie ?? '')
    .split(';')
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie && cookie.split('=', 1)[0]?.toLowerCase() !== 'cf_authorization');
  if (safeCookies.length) headers.cookie = safeCookies.join('; ');
  else delete headers.cookie;
  headers['x-veneer-app-id'] = app.id;
  headers['x-veneer-tenant'] = tenant;
  return headers;
}

/** Authenticated same-origin ingress for Mini Apps whose runtime is local. */
export function createLocalMiniAppsRouter(ctx: AppContext): Router {
  const router = express.Router();
  const tenant = ctx.config.appPublicOrigin
    ? new URL(ctx.config.appPublicOrigin).hostname.split('.')[0] || 'veneer'
    : 'veneer';

  router.use('/:slug', (req, res) => {
    void (async () => {
      if (!ctx.appRunner || !ctx.config.appPublicOrigin) {
        res.status(503).type('text').send('Local app hosting is not configured.');
        return;
      }
      const identity = await ctx.resolveIdentity(req);
      const user = identity ? findUserByEmail(ctx.db, identity.email) : undefined;
      if (!identity || !user || user.status !== 'active' || isEmployee(ctx.db, user.id)) {
        res.status(403).type('text').send('Forbidden');
        return;
      }
      const app = ctx.db
        .prepare("SELECT * FROM mini_apps WHERE slug = ? AND runtime = 'local' AND status = 'deployed'")
        .get(req.params.slug) as MiniAppRow | undefined;
      if (!app) {
        res.status(404).type('text').send('App not found');
        return;
      }
      const incoming = new URL(req.originalUrl, ctx.config.appPublicOrigin);
      const basePath = `/tools/${app.slug}`;
      const suffix = incoming.pathname.slice(basePath.length) || '/';
      proxyHttpRequest({
        req,
        res,
        port: ctx.config.appRunnerPort,
        path: `/apps/${encodeURIComponent(app.id)}${suffix}${incoming.search}`,
        headers: appHeaders(req, app, tenant),
        timeoutMs: 22_000,
      });
    })().catch((error: Error) => {
      if (!res.headersSent) res.status(502).type('text').send(`This app is temporarily unavailable: ${error.message}`);
      else res.destroy(error);
    });
  });

  return router;
}
