import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { miniAppControlsMarkup, miniAppNavigation } from '../miniApps/controls.js';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
// The manager grants filesystem writes to this subdirectory only, so the app
// module itself stays read-only to the code it runs.
const STORAGE_DIRECTORY = 'storage';
const STORAGE_FILE = 'data.json';

export interface LocalAppStorageMethods {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface LocalAppStorage extends LocalAppStorageMethods {
  transaction<T>(callback: (storage: LocalAppStorageMethods) => T | Promise<T>): Promise<T>;
}

export interface LocalAppIdentity {
  appId: string;
  tenant: string;
  publicPath: string;
  publicUrl: string;
}

export interface LocalAppContext extends LocalAppIdentity {
  storage: LocalAppStorage;
}

export interface LocalAppChildMeta extends LocalAppIdentity {
  appsUrl: string;
}

type AppHandle = (request: Request, context: Readonly<LocalAppContext>) => Response | Promise<Response>;

class PayloadTooLargeError extends Error {}

type StorageValues = Record<string, unknown>;

/** Values cross the app boundary by copy, matching Durable Object semantics. */
function storageValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('storage values must be JSON-serializable');
  return JSON.parse(encoded) as unknown;
}

/**
 * Local Mini Apps get the same storage surface as the Cloudflare Durable
 * Object: JSON-serializable values, `undefined` for missing keys, and
 * transactions that are mutually exclusive within the process and roll back to
 * the pre-transaction snapshot when the callback throws.
 */
export function createLocalAppStorage(directory: string): LocalAppStorage {
  const file = path.join(directory, STORAGE_FILE);
  let values: StorageValues | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const load = (): StorageValues => {
    if (values) return values;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      parsed = null;
    }
    values = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as StorageValues) : {};
    return values;
  };

  const persist = (): void => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(load()), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  };

  const methods = (save: () => void): LocalAppStorageMethods => {
    const put = async (key: string, value: unknown): Promise<void> => {
      load()[String(key)] = storageValue(value);
      save();
    };
    return Object.freeze({
      get: async (key: string) => storageValue(load()[String(key)]),
      put,
      set: put,
      delete: async (key: string) => {
        const existed = Object.prototype.hasOwnProperty.call(load(), String(key));
        if (existed) {
          delete load()[String(key)];
          save();
        }
        return existed;
      },
    });
  };

  const direct = methods(persist);
  // Inside a transaction, writes stay in memory until the callback resolves so
  // a throw can restore the snapshot without a partially written file.
  const buffered = methods(() => undefined);

  return Object.freeze({
    ...direct,
    transaction<T>(callback: (storage: LocalAppStorageMethods) => T | Promise<T>): Promise<T> {
      if (typeof callback !== 'function') throw new TypeError('transaction callback must be a function');
      const run = queue.then(async () => {
        const snapshot = JSON.stringify(load());
        try {
          const result = await callback(buffered);
          persist();
          return result;
        } catch (error) {
          values = JSON.parse(snapshot) as StorageValues;
          throw error;
        }
      });
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  });
}

function incomingHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function requestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      req.resume();
      throw new PayloadTooLargeError('request body exceeds 2MB');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function responseBody(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buffer = Buffer.from(value);
      total += buffer.length;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PayloadTooLargeError('response body exceeds 10MB');
      }
      chunks.push(buffer);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function writeHeaders(res: ServerResponse, response: Response, bodyLength: number): void {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== 'content-length' && name.toLowerCase() !== 'set-cookie') headers[name] = value;
  });
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = getSetCookie?.call(response.headers) ?? [];
  if (cookies.length) headers['set-cookie'] = cookies;
  headers['content-length'] = String(bodyLength);
  res.writeHead(response.status, response.statusText, headers);
}

export async function createLocalAppServer(modulePath: string, meta: LocalAppChildMeta): Promise<http.Server> {
  const loaded = (await import(`${pathToFileURL(modulePath).href}?v=${Date.now()}`)) as {
    handle?: unknown;
  };
  if (typeof loaded.handle !== 'function') throw new TypeError('App module must export handle(request, context)');
  const handle = loaded.handle as AppHandle;
  const context: Readonly<LocalAppContext> = Object.freeze({
    appId: meta.appId,
    tenant: meta.tenant,
    publicPath: meta.publicPath,
    publicUrl: meta.publicUrl,
    storage: createLocalAppStorage(path.join(path.dirname(modulePath), STORAGE_DIRECTORY)),
  });

  const server = http.createServer((req, res) => {
    void (async () => {
      if ((req.url ?? '').split('?', 1)[0] === '/__veneer_health') {
        res.writeHead(204).end();
        return;
      }
      const body = await requestBody(req);
      const incoming = new URL(req.url ?? '/', meta.publicUrl);
      incoming.pathname = `${meta.publicPath}${incoming.pathname}`;
      const navigation = miniAppNavigation(incoming, meta.publicUrl, meta.appsUrl);
      const appRequestUrl = new URL(navigation.appUrl);
      appRequestUrl.pathname = appRequestUrl.pathname.slice(meta.publicPath.length) || '/';
      const request = new Request(appRequestUrl, {
        method: req.method,
        headers: incomingHeaders(req),
        body: body ? new Uint8Array(body) : undefined,
        redirect: 'manual',
      });
      const response = await handle(request, context);
      if (!(response instanceof Response)) throw new TypeError('handle() must return a Response');

      let output = req.method === 'HEAD' ? Buffer.alloc(0) : await responseBody(response);
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      const embedded = request.headers.get('sec-fetch-dest') === 'iframe';
      if (req.method !== 'HEAD' && !embedded && contentType.includes('text/html')) {
        const html = output.toString('utf8');
        const controls = miniAppControlsMarkup(navigation);
        output = Buffer.from(
          /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${controls}</body>`) : `${html}${controls}`,
          'utf8',
        );
      }
      writeHeaders(res, response, output.length);
      res.end(output);
    })().catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (error instanceof PayloadTooLargeError) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(error.message);
        return;
      }
      console.error('Local Mini App request failed', error);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('This tool hit an unexpected error.');
    });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  return server;
}

async function main(): Promise<void> {
  const modulePath = process.argv[2];
  const rawMeta = process.argv[3];
  if (!modulePath || !rawMeta) throw new Error('local app child requires module path and metadata');
  const meta = JSON.parse(rawMeta) as LocalAppChildMeta;
  const server = await createLocalAppServer(modulePath, meta);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local app child did not bind a TCP port');
    process.send?.({ type: 'ready', port: address.port });
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isEntryPoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  void main().catch((error: Error) => {
    process.send?.({ type: 'error', error: error.message });
    process.exitCode = 1;
  });
}
