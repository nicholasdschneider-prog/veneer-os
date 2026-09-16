/** Cloudflare Workers deployment adapter for Mini Apps v1. */

export interface MiniAppCloudflareConfig {
  accountId: string;
  apiToken: string;
  zoneId: string;
  publicOrigin: string;
  tenant: string;
}

export interface MiniAppDeployment {
  id: string;
  slug: string;
  scriptName: string;
  source: string;
  routeId: string | null;
}

export interface MiniAppDeployResult {
  routeId: string;
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: { message?: string }[];
}

interface CloudflareWorkerBinding {
  name?: string;
  type?: string;
  class_name?: string;
}

interface CloudflareWorkerSettings {
  bindings?: CloudflareWorkerBinding[];
  // Script settings report the applied migration as `migrations.new_tag`;
  // `migration_tag` is only the legacy shape.
  migrations?: { new_tag?: string };
  migration_tag?: string;
}

const APP_STORAGE_BINDING = 'VENEER_APP_STORAGE';
const APP_STORAGE_CLASS = 'VeneerMiniAppStorage';
const APP_STORAGE_MIGRATION_TAG = 'veneer-mini-app-storage-v1';

function cloudflareMessage(body: CloudflareEnvelope<unknown>, fallback: string): string {
  return body.errors?.map((error) => error.message).filter(Boolean).join('; ') || fallback;
}

export function miniAppUrl(publicOrigin: string, slug: string): string {
  return `${publicOrigin.replace(/\/+$/, '')}/tools/${slug}/`;
}

export function miniAppRoutePattern(publicOrigin: string, slug: string): string {
  // The trailing wildcard covers both `/tools/slug` and `/tools/slug/...`.
  // The wrapper still rejects paths that are not the exact slug boundary.
  return `${new URL(publicOrigin).hostname}/tools/${slug}*`;
}

export function miniAppScriptName(tenant: string, id: string): string {
  const safeTenant = tenant.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'veneer';
  return `vp-${safeTenant}-${id.replace(/-/g, '').slice(0, 24)}`;
}

export function miniAppUploadMetadata(settings?: CloudflareWorkerSettings): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    main_module: 'worker.js',
    compatibility_date: new Date().toISOString().slice(0, 10),
    bindings: [
      {
        type: 'durable_object_namespace',
        name: APP_STORAGE_BINDING,
        class_name: APP_STORAGE_CLASS,
      },
    ],
  };
  const hasStorageBinding = settings?.bindings?.some(
    (binding) =>
      binding.type === 'durable_object_namespace' &&
      binding.name === APP_STORAGE_BINDING &&
      binding.class_name === APP_STORAGE_CLASS,
  );
  if (!hasStorageBinding) {
    const oldTag = settings?.migrations?.new_tag ?? settings?.migration_tag;
    metadata.migrations = {
      ...(oldTag ? { old_tag: oldTag } : {}),
      new_tag: APP_STORAGE_MIGRATION_TAG,
      new_sqlite_classes: [APP_STORAGE_CLASS],
    };
  }
  return metadata;
}

/**
 * The uploaded app module exports `handle(request, context)`. It receives only
 * Web-standard primitives, so the same source can run under Node, Workers, or a
 * future container adapter. This wrapper owns the public path and platform
 * context; apps never import Cloudflare bindings directly.
 */
export function miniAppWorkerWrapper(app: Pick<MiniAppDeployment, 'id' | 'slug'>, cfg: MiniAppCloudflareConfig): string {
  const publicPath = `/tools/${app.slug}`;
  const publicUrl = miniAppUrl(cfg.publicOrigin, app.slug);
  const appsUrl = `${cfg.publicOrigin.replace(/\/+$/, '')}/#/apps`;
  return `import { handle } from './app.js';

const PUBLIC_PATH = ${JSON.stringify(publicPath)};
const APPS_URL = ${JSON.stringify(appsUrl)};
const RETURN_PARAM = '__veneer_return';
const APP_ID = ${JSON.stringify(app.id)};

function storageMethods(storage) {
  return Object.freeze({
    get(key) { return storage.get(String(key)); },
    put(key, value) { return storage.put(String(key), value); },
    set(key, value) { return storage.put(String(key), value); },
    delete(key) { return storage.delete(String(key)); },
  });
}

function appStorage(storage) {
  return Object.freeze({
    ...storageMethods(storage),
    transaction(callback) {
      if (typeof callback !== 'function') throw new TypeError('transaction callback must be a function');
      return storage.transaction((transaction) => callback(storageMethods(transaction)));
    },
  });
}

function appContext(storage) {
  const context = {
    appId: APP_ID,
    tenant: ${JSON.stringify(cfg.tenant)},
    publicPath: PUBLIC_PATH,
    publicUrl: ${JSON.stringify(publicUrl)},
  };
  if (storage) {
    context.storage = storage;
  } else {
    // Older deploys (or a half-applied migration) have no storage namespace.
    // Apps that never touch storage must keep serving; only a read fails.
    Object.defineProperty(context, 'storage', {
      enumerable: true,
      get() { throw new Error('storage is not available on this deployment'); },
    });
  }
  return Object.freeze(context);
}

async function runApp(request, storage) {
  const response = await handle(request, appContext(storage));
  if (!(response instanceof Response)) throw new TypeError('handle() must return a Response');
  return response;
}

export class ${APP_STORAGE_CLASS} {
  constructor(state) {
    this.storage = appStorage(state.storage);
  }

  async fetch(request) {
    return runApp(request, this.storage);
  }
}

function escapeAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function appNavigation(incoming) {
  const rawReturnUrl = incoming.searchParams.get(RETURN_PARAM);
  incoming.searchParams.delete(RETURN_PARAM);
  let returnUrl = APPS_URL;
  let returnsToOrigin = false;
  if (rawReturnUrl) {
    try {
      const candidate = new URL(rawReturnUrl);
      if (candidate.origin === incoming.origin && (candidate.protocol === 'https:' || candidate.protocol === 'http:')) {
        returnUrl = candidate.toString();
        returnsToOrigin = true;
      }
    } catch {}
  }
  return { appUrl: incoming.toString(), returnUrl, returnsToOrigin };
}

async function addVeneerControls(response, request, navigation) {
  const contentType = response.headers.get('content-type') || '';
  const embedded = request.headers.get('sec-fetch-dest') === 'iframe';
  if (request.method === 'HEAD' || embedded || !contentType.toLowerCase().includes('text/html')) return response;

  const closeLabel = navigation.returnsToOrigin ? 'Close app and return to chat' : 'Close app';
  const controls = '<nav data-veneer-app-controls aria-label="App controls" style="position:fixed;top:max(8px,calc(env(safe-area-inset-top) + 8px));left:12px;right:12px;z-index:2147483647;display:flex;align-items:center;justify-content:space-between;gap:8px;pointer-events:none;font:600 14px/1 Inter,system-ui,sans-serif;color:#26221c">' +
    '<a data-veneer-app-close data-veneer-app-exit href="' + escapeAttribute(navigation.returnUrl) + '" aria-label="' + closeLabel + '" style="box-sizing:border-box;display:inline-flex;min-height:48px;align-items:center;gap:8px;padding:0 16px;pointer-events:auto;border:1px solid rgba(38,34,28,.18);border-radius:999px;background:rgba(250,247,242,.96);box-shadow:0 4px 18px rgba(38,34,28,.16);color:#26221c;text-decoration:none;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)"><span aria-hidden="true" style="font-size:20px;font-weight:400">&#10005;</span><span>Close</span></a>' +
    '<a data-veneer-app-new-window href="' + escapeAttribute(navigation.appUrl) + '" target="_blank" rel="noopener noreferrer" aria-label="Open app in new window" style="box-sizing:border-box;display:inline-flex;min-height:48px;align-items:center;gap:8px;padding:0 16px;pointer-events:auto;border:1px solid rgba(38,34,28,.18);border-radius:999px;background:rgba(250,247,242,.96);box-shadow:0 4px 18px rgba(38,34,28,.16);color:#26221c;text-decoration:none;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)"><span>New window</span><span aria-hidden="true" style="font-size:20px;font-weight:400">&#8599;</span></a></nav>';
  const html = await response.text();
  const bodyClose = /<\\/body\\s*>/i;
  const output = bodyClose.test(html) ? html.replace(bodyClose, controls + '</body>') : html + controls;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(output, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (incoming.pathname !== PUBLIC_PATH && !incoming.pathname.startsWith(PUBLIC_PATH + '/')) {
      return new Response('Not found', { status: 404 });
    }

    const navigation = appNavigation(incoming);
    incoming.pathname = incoming.pathname.slice(PUBLIC_PATH.length) || '/';
    const headers = new Headers(request.headers);
    // Access authenticates the outer request, but generated app code never
    // needs the reusable assertion or authorization cookie. Keep that trust
    // boundary in the platform wrapper so an app cannot leak either credential.
    headers.delete('cf-access-jwt-assertion');
    headers.delete('cf-access-authenticated-user-email');
    headers.delete('cf-access-client-id');
    headers.delete('cf-access-client-secret');
    const safeCookies = (headers.get('cookie') || '')
      .split(';')
      .map((cookie) => cookie.trim())
      .filter((cookie) => cookie && cookie.split('=', 1)[0].toLowerCase() !== 'cf_authorization');
    if (safeCookies.length) headers.set('cookie', safeCookies.join('; '));
    else headers.delete('cookie');
    headers.delete('x-veneer-app-id');
    headers.delete('x-veneer-tenant');
    headers.set('x-veneer-app-id', ${JSON.stringify(app.id)});
    headers.set('x-veneer-tenant', ${JSON.stringify(cfg.tenant)});
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
    const appRequest = new Request(incoming, { method: request.method, headers, body, redirect: request.redirect });

    try {
      const namespace = env && env.${APP_STORAGE_BINDING};
      const response = namespace
        ? await namespace.get(namespace.idFromName(APP_ID)).fetch(appRequest)
        : await runApp(appRequest, null);
      return await addVeneerControls(response, request, navigation);
    } catch (error) {
      console.error('Mini app request failed', error);
      return new Response('This tool hit an unexpected error.', { status: 500 });
    }
  },
};
`;
}

export class CloudflareMiniAppDeployer {
  constructor(
    private readonly cfg: MiniAppCloudflareConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async api<T>(path: string, init: RequestInit, allowNotFound = false): Promise<T> {
    const res = await this.request(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${this.cfg.apiToken}`, ...(init.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as CloudflareEnvelope<T>;
    if (allowNotFound && res.status === 404) return undefined as T;
    if (!res.ok || body.success === false || body.result === undefined) {
      throw new Error(cloudflareMessage(body, `Cloudflare request failed (${res.status})`));
    }
    return body.result;
  }

  async deploy(app: MiniAppDeployment): Promise<MiniAppDeployResult> {
    const settings = await this.api<CloudflareWorkerSettings>(
      `/accounts/${encodeURIComponent(this.cfg.accountId)}/workers/scripts/${encodeURIComponent(app.scriptName)}/settings`,
      { method: 'GET' },
      true,
    );
    const form = new FormData();
    form.append(
      'metadata',
      new Blob([JSON.stringify(miniAppUploadMetadata(settings))], { type: 'application/json' }),
    );
    form.append('worker.js', new Blob([miniAppWorkerWrapper(app, this.cfg)], { type: 'application/javascript+module' }), 'worker.js');
    form.append('app.js', new Blob([app.source], { type: 'application/javascript+module' }), 'app.js');

    await this.api(`/accounts/${encodeURIComponent(this.cfg.accountId)}/workers/scripts/${encodeURIComponent(app.scriptName)}`, {
      method: 'PUT',
      body: form,
    });

    if (app.routeId) return { routeId: app.routeId };
    try {
      const route = await this.api<{ id: string }>(`/zones/${encodeURIComponent(this.cfg.zoneId)}/workers/routes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pattern: miniAppRoutePattern(this.cfg.publicOrigin, app.slug), script: app.scriptName }),
      });
      return { routeId: route.id };
    } catch (error) {
      // A route-less script is unreachable but still consumes account quota.
      await this.deleteScript(app.scriptName).catch(() => undefined);
      throw error;
    }
  }

  async remove(app: Pick<MiniAppDeployment, 'scriptName' | 'routeId'>): Promise<void> {
    if (app.routeId) {
      await this.api(`/zones/${encodeURIComponent(this.cfg.zoneId)}/workers/routes/${encodeURIComponent(app.routeId)}`, {
        method: 'DELETE',
      }, true);
    }
    await this.deleteScript(app.scriptName);
  }

  private async deleteScript(scriptName: string): Promise<void> {
    await this.api(`/accounts/${encodeURIComponent(this.cfg.accountId)}/workers/scripts/${encodeURIComponent(scriptName)}`, {
      method: 'DELETE',
    }, true);
  }
}
