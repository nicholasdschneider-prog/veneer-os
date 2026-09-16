import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createLocalAppServer } from '../src/appRunner/child.js';
import { localAppEnvironment } from '../src/appRunner/manager.js';
import { miniAppControlsMarkup, miniAppNavigation } from '../src/miniApps/controls.js';
import { MINI_APP_WRAPPER_VERSION, refreshMiniAppWrappers } from '../src/miniApps/wrapperUpgrade.js';
import {
  CloudflareMiniAppDeployer,
  miniAppRoutePattern,
  miniAppScriptName,
  miniAppUploadMetadata,
  miniAppUrl,
  miniAppWorkerWrapper,
  type MiniAppCloudflareConfig,
} from '../src/miniApps/cloudflare.js';
import { normalizeMiniAppSlug, validateMiniAppSource } from '../src/routes/miniApps.js';

const config: MiniAppCloudflareConfig = {
  accountId: 'account-1',
  apiToken: 'secret-token',
  zoneId: 'zone-1',
  publicOrigin: 'https://lps.veneer.app',
  tenant: 'lps',
};

const app = {
  id: '12345678-1234-1234-1234-1234567890ab',
  slug: 'pipeline',
  scriptName: 'vp-lps-123456781234123412341234',
  source: 'export async function handle() { return new Response("ok"); }',
  routeId: null,
};

function cfResponse(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, result, errors: [] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

class AtomicObjectStorage {
  private values = new Map<string, unknown>();
  private pending: Promise<void> = Promise.resolve();

  get(key: string): unknown {
    return this.values.get(key);
  }

  put(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  delete(key: string): boolean {
    return this.values.delete(key);
  }

  transaction<T>(callback: (storage: AtomicObjectStorage) => Promise<T>): Promise<T> {
    const run = this.pending.then(async () => {
      const transaction = new AtomicObjectStorage();
      transaction.values = new Map(this.values);
      const result = await callback(transaction);
      this.values = transaction.values;
      return result;
    });
    this.pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

async function loadGeneratedWrapper(handleSource: string): Promise<{
  default: { fetch(request: Request, env: unknown): Promise<Response> };
  VeneerMiniAppStorage: new (state: { storage: AtomicObjectStorage }) => { fetch(request: Request): Promise<Response> };
}> {
  const source = miniAppWorkerWrapper(app, config).replace("import { handle } from './app.js';", handleSource);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${crypto.randomUUID()}`);
}

describe('mini app contract', () => {
  it('normalizes stable URL slugs and rejects unsupported modules', () => {
    expect(normalizeMiniAppSlug(' LPs Pipeline Dashboard! ')).toBe('lps-pipeline-dashboard');
    expect(validateMiniAppSource(app.source)).toBeNull();
    expect(validateMiniAppSource('export default {}')).toContain('export a function named handle');
    expect(
      validateMiniAppSource('import x from "package"; export async function handle() { return new Response(x); }'),
    ).toContain('cannot import');
  });

  it('builds tenant-scoped names, routes, URLs, and a path-stripping wrapper', () => {
    expect(miniAppUrl(config.publicOrigin, app.slug)).toBe('https://lps.veneer.app/tools/pipeline/');
    expect(miniAppRoutePattern(config.publicOrigin, app.slug)).toBe('lps.veneer.app/tools/pipeline*');
    expect(miniAppScriptName('LPs Client', app.id)).toBe('vp-lps-client-123456781234123412341234');
    const wrapper = miniAppWorkerWrapper(app, config);
    expect(wrapper).toContain("import { handle } from './app.js'");
    expect(wrapper).toContain('export class VeneerMiniAppStorage');
    expect(wrapper).toContain('return runApp(request, this.storage)');
    expect(wrapper).toContain('storage.transaction');
    expect(wrapper).toContain('const namespace = env && env.VENEER_APP_STORAGE');
    expect(wrapper).toContain('namespace.get(namespace.idFromName(APP_ID))');
    expect(wrapper).toContain('incoming.pathname.slice(PUBLIC_PATH.length)');
    expect(wrapper).toContain('https://lps.veneer.app/tools/pipeline/');
    expect(wrapper).toContain("headers.delete('x-veneer-tenant')");
    expect(wrapper).toContain("headers.delete('cf-access-jwt-assertion')");
    expect(wrapper).toContain("!== 'cf_authorization'");
    expect(wrapper).toContain('https://lps.veneer.app/#/apps');
    expect(wrapper).toContain('data-veneer-app-exit');
    expect(wrapper).toContain('data-veneer-app-controls');
    expect(wrapper).toContain('data-veneer-app-new-window');
    expect(wrapper).toContain("const RETURN_PARAM = '__veneer_return'");
    expect(wrapper).toContain('incoming.searchParams.delete(RETURN_PARAM)');
    expect(wrapper).toContain('candidate.origin === incoming.origin');
    expect(wrapper).toContain('min-height:48px');
    expect(wrapper).toContain("request.headers.get('sec-fetch-dest') === 'iframe'");
    expect(wrapper).toContain("contentType.toLowerCase().includes('text/html')");
  });

  it('adds isolated SQLite Durable Object storage metadata only for the first storage deployment', () => {
    expect(miniAppUploadMetadata()).toMatchObject({
      main_module: 'worker.js',
      bindings: [
        {
          type: 'durable_object_namespace',
          name: 'VENEER_APP_STORAGE',
          class_name: 'VeneerMiniAppStorage',
        },
      ],
      migrations: {
        new_tag: 'veneer-mini-app-storage-v1',
        new_sqlite_classes: ['VeneerMiniAppStorage'],
      },
    });
    expect(
      miniAppUploadMetadata({
        migration_tag: 'veneer-mini-app-storage-v1',
        bindings: [
          {
            type: 'durable_object_namespace',
            name: 'VENEER_APP_STORAGE',
            class_name: 'VeneerMiniAppStorage',
          },
        ],
      }),
    ).not.toHaveProperty('migrations');
    // Script settings report the applied migration under `migrations.new_tag`;
    // missing it would make Cloudflare reject the migration as out of order.
    expect(
      miniAppUploadMetadata({
        migrations: { new_tag: 'existing-tag' },
        bindings: [{ type: 'kv_namespace', name: 'OTHER' }],
      }),
    ).toMatchObject({
      migrations: {
        old_tag: 'existing-tag',
        new_tag: 'veneer-mini-app-storage-v1',
        new_sqlite_classes: ['VeneerMiniAppStorage'],
      },
    });
    expect(miniAppUploadMetadata({ migration_tag: 'legacy-tag' })).toMatchObject({
      migrations: { old_tag: 'legacy-tag' },
    });
  });

  it('keeps serving when a deploy has no storage namespace and reports storage clearly', async () => {
    const loaded = await loadGeneratedWrapper(`
      async function handle(request, context) {
        const url = new URL(request.url);
        if (url.pathname === '/storage') {
          try {
            context.storage.get('state');
            return new Response('reached storage');
          } catch (error) {
            return new Response(error.message, { status: 503 });
          }
        }
        return new Response('<!doctype html><body>' + context.appId + '</body>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
    `);
    const request = (path: string) =>
      loaded.default.fetch(new Request(`https://lps.veneer.app/tools/pipeline${path}`), {});

    const page = await request('/');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(app.id);
    expect(html).toContain('data-veneer-app-controls');

    const storage = await request('/storage');
    expect(storage.status).toBe(503);
    await expect(storage.text()).resolves.toBe('storage is not available on this deployment');
  });

  it('provides persistent atomic storage to the app and prevents reservation and seed races', async () => {
    const loaded = await loadGeneratedWrapper(`
      async function handle(request, context) {
        const url = new URL(request.url);
        if (url.pathname === '/context') {
          return Response.json({ appId: context.appId, tenant: context.tenant, hasStorage: Boolean(context.storage) });
        }
        const mutate = (callback) => context.storage.transaction(async (storage) => {
          let state = await storage.get('state');
          if (!state) {
            await Promise.resolve();
            state = { seeded: true, owner: null };
          }
          const result = await callback(state);
          await storage.put('state', state);
          return result;
        });
        if (request.method === 'POST' && url.pathname === '/reserve') {
          const owner = await request.text();
          const status = await mutate((state) => {
            if (state.owner) return 409;
            state.owner = owner;
            return 200;
          });
          return Response.json({ owner }, { status });
        }
        const state = await mutate((current) => current);
        return Response.json(state);
      }
    `);
    const appEnvironment = () => {
      const object = new loaded.VeneerMiniAppStorage({ storage: new AtomicObjectStorage() });
      const env = {
        VENEER_APP_STORAGE: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: (request: Request) => object.fetch(request) }),
        },
      };
      return (path: string, init?: RequestInit) =>
        loaded.default.fetch(new Request(`https://lps.veneer.app/tools/pipeline${path}`, init), env);
    };
    const request = appEnvironment();

    const [initialRead, seededReservation] = await Promise.all([
      request('/api/state'),
      request('/reserve', { method: 'POST', body: 'client-a' }),
    ]);
    expect(initialRead.status).toBe(200);
    expect(seededReservation.status).toBe(200);

    const concurrentRequest = appEnvironment();
    const concurrent = await Promise.all([
      concurrentRequest('/reserve', { method: 'POST', body: 'client-b' }),
      concurrentRequest('/reserve', { method: 'POST', body: 'client-c' }),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(['client-b', 'client-c']).toContain((await (await concurrentRequest('/api/state')).json() as { owner: string }).owner);
    await expect((await request('/api/state')).json()).resolves.toEqual({ seeded: true, owner: 'client-a' });
    await expect((await request('/context')).json()).resolves.toEqual({
      appId: app.id,
      tenant: config.tenant,
      hasStorage: true,
    });
  });

  it('runs the same single-file handle contract in a local process', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-local-app-contract-'));
    const modulePath = path.join(directory, 'app.mjs');
    fs.writeFileSync(
      modulePath,
      `export async function handle(request, context) {
        const body = await request.text();
        return new Response(
          '<!doctype html><body>' +
            [request.method, new URL(request.url).pathname, new URL(request.url).search, body, context.appId, context.publicPath].join('|') +
          '</body>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }`,
    );

    const server = await createLocalAppServer(modulePath, {
      appId: app.id,
      tenant: 'lps',
      publicPath: '/tools/pipeline',
      publicUrl: 'https://lps.veneer.app/tools/pipeline/',
      appsUrl: 'https://lps.veneer.app/#/apps',
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/records`, { method: 'POST', body: 'hello' });
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain(`POST|/records||hello|${app.id}|/tools/pipeline`);
      expect(html).toContain('data-veneer-app-exit');
      expect(html).toContain('data-veneer-app-controls');
      expect(html).toContain('data-veneer-app-new-window');
      expect(html).toContain('min-height:48px');
      expect(html).toContain('https://lps.veneer.app/#/apps');

      const returnUrl = 'https://lps.veneer.app/#/chat/chat-1?project=project-1';
      const launchedResponse = await fetch(
        `http://127.0.0.1:${port}/records?view=list&__veneer_return=${encodeURIComponent(returnUrl)}`,
      );
      const launchedHtml = await launchedResponse.text();
      expect(launchedHtml).toContain('GET|/records|?view=list||');
      expect(launchedHtml).not.toContain('__veneer_return');
      expect(launchedHtml).toContain('Close app and return to chat');
      expect(launchedHtml).toContain('https://lps.veneer.app/#/chat/chat-1?project=project-1');
      expect(launchedHtml).toContain('href="https://lps.veneer.app/tools/pipeline/records?view=list"');

      const embeddedResponse = await fetch(`http://127.0.0.1:${port}/records`, {
        headers: { 'sec-fetch-dest': 'iframe' },
      });
      const embeddedHtml = await embeddedResponse.text();
      expect(embeddedResponse.status).toBe(200);
      expect(embeddedHtml).not.toContain('data-veneer-app-exit');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects cross-origin app return targets and escapes control URLs', () => {
    const hostile = miniAppNavigation(
      'https://lps.veneer.app/tools/pipeline/?view=list&__veneer_return=https%3A%2F%2Fevil.example%2Fsteal',
      'https://lps.veneer.app',
      'https://lps.veneer.app/#/apps',
    );
    expect(hostile).toEqual({
      appUrl: 'https://lps.veneer.app/tools/pipeline/?view=list',
      returnUrl: 'https://lps.veneer.app/#/apps',
      returnsToOrigin: false,
    });

    const markup = miniAppControlsMarkup({
      appUrl: 'https://lps.veneer.app/tools/pipeline/?view=a&sort=b',
      returnUrl: 'https://lps.veneer.app/#/chat/chat-1?project=a&panel=b',
      returnsToOrigin: true,
    });
    expect(markup).toContain('view=a&amp;sort=b');
    expect(markup).toContain('project=a&amp;panel=b');
    expect(markup).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it('gives local app processes an explicit environment allowlist', () => {
    const env = localAppEnvironment({
      PATH: '/custom/bin',
      LANG: 'en_US.UTF-8',
      TZ: 'America/Indiana/Indianapolis',
      HOME: '/home/veneer',
      CLOUDFLARE_API_TOKEN: 'cloudflare-secret',
      DOPPLER_TOKEN: 'doppler-secret',
      VP_AGENT_TOKEN: 'agent-secret',
    });

    expect(env).toEqual({
      NODE_ENV: 'production',
      PATH: '/custom/bin',
      LANG: 'en_US.UTF-8',
      TZ: 'America/Indiana/Indianapolis',
    });
    expect(env).not.toHaveProperty('HOME');
    expect(env).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
    expect(env).not.toHaveProperty('DOPPLER_TOKEN');
    expect(env).not.toHaveProperty('VP_AGENT_TOKEN');
  });
});

describe('CloudflareMiniAppDeployer', () => {
  it('uploads a module Worker and creates its route', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(cfResponse(undefined, 404))
      .mockResolvedValueOnce(cfResponse({ id: app.scriptName }))
      .mockResolvedValueOnce(cfResponse({ id: 'route-1' }));
    const deployer = new CloudflareMiniAppDeployer(config, request);

    await expect(deployer.deploy(app)).resolves.toEqual({ routeId: 'route-1' });
    expect(request).toHaveBeenCalledTimes(3);
    const [settingsUrl, settingsInit] = request.mock.calls[0]!;
    expect(String(settingsUrl)).toContain(`/accounts/${config.accountId}/workers/scripts/${app.scriptName}/settings`);
    expect(settingsInit?.method).toBe('GET');
    const [uploadUrl, uploadInit] = request.mock.calls[1]!;
    expect(String(uploadUrl)).toContain(`/accounts/${config.accountId}/workers/scripts/${app.scriptName}`);
    expect(uploadInit?.method).toBe('PUT');
    expect((uploadInit?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    const form = uploadInit?.body as FormData;
    expect(form.get('worker.js')).toBeInstanceOf(Blob);
    expect(await (form.get('app.js') as Blob).text()).toBe(app.source);
    expect(JSON.parse(await (form.get('metadata') as Blob).text())).toMatchObject({
      bindings: [
        {
          type: 'durable_object_namespace',
          name: 'VENEER_APP_STORAGE',
          class_name: 'VeneerMiniAppStorage',
        },
      ],
      migrations: {
        new_tag: 'veneer-mini-app-storage-v1',
        new_sqlite_classes: ['VeneerMiniAppStorage'],
      },
    });

    const [routeUrl, routeInit] = request.mock.calls[2]!;
    expect(String(routeUrl)).toContain(`/zones/${config.zoneId}/workers/routes`);
    expect(JSON.parse(String(routeInit?.body))).toEqual({
      pattern: 'lps.veneer.app/tools/pipeline*',
      script: app.scriptName,
    });
  });

  it('updates an existing route without recreating it', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        cfResponse({
          migration_tag: 'veneer-mini-app-storage-v1',
          bindings: [
            {
              type: 'durable_object_namespace',
              name: 'VENEER_APP_STORAGE',
              class_name: 'VeneerMiniAppStorage',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(cfResponse({ id: app.scriptName }));
    const deployer = new CloudflareMiniAppDeployer(config, request);
    await expect(deployer.deploy({ ...app, routeId: 'route-existing' })).resolves.toEqual({ routeId: 'route-existing' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('removes the route before deleting the Worker', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => cfResponse(null));
    const deployer = new CloudflareMiniAppDeployer(config, request);
    await deployer.remove({ scriptName: app.scriptName, routeId: 'route-1' });
    expect(request.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ['https://api.cloudflare.com/client/v4/zones/zone-1/workers/routes/route-1', 'DELETE'],
      [`https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts/${app.scriptName}`, 'DELETE'],
    ]);
  });
});

describe('Mini App platform wrapper upgrades', () => {
  it('refreshes an existing Cloudflare app once and remembers its wrapper version', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE mini_apps (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        script_name TEXT NOT NULL,
        route_id TEXT,
        source_text TEXT NOT NULL,
        runtime TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO mini_apps (id, slug, script_name, route_id, source_text, runtime, status)
       VALUES (?, ?, ?, ?, ?, 'cloudflare', 'deployed')`,
    ).run(app.id, app.slug, app.scriptName, 'route-existing', app.source);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(cfResponse(undefined, 404))
      .mockResolvedValueOnce(cfResponse({ id: app.scriptName }));

    await expect(refreshMiniAppWrappers(db, config, request)).resolves.toEqual({ updated: 1, failed: 0 });
    expect(request).toHaveBeenCalledTimes(2);
    const stored = db.prepare("SELECT value_json FROM settings WHERE key = 'mini_app_wrapper_versions'").get() as {
      value_json: string;
    };
    expect(JSON.parse(stored.value_json)).toEqual({ [app.id]: MINI_APP_WRAPPER_VERSION });

    await expect(refreshMiniAppWrappers(db, config, request)).resolves.toEqual({ updated: 0, failed: 0 });
    expect(request).toHaveBeenCalledTimes(2);
    db.close();
  });
});
