/**
 * Minimal Cloudflare R2 client for the Pages feature, talking to the Cloudflare
 * REST API with global fetch (no SDK). Objects are HTML documents stored under
 * keys like `p/<slug>`; an R2 custom domain serves each exact key.
 *
 * The API token is a secret — it goes in the Authorization header only, and is
 * NEVER included in thrown errors or logged. Callers surface the returned
 * Cloudflare error message, which contains no credentials.
 */

export interface R2Config {
  accountId: string;
  apiToken: string;
  bucket: string;
}

interface CloudflareResponse {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: {
    rules?: R2LifecycleRule[];
  };
}

interface R2LifecycleRule {
  id: string;
  enabled: boolean;
  conditions: { prefix?: string };
  deleteObjectsTransition?: {
    condition: { type: 'Age'; maxAge: number };
  };
  [key: string]: unknown;
}

const PAGE_EXPIRY_RULE_ID = 'veneer-pages-expire-7-days';

// Encode each path segment but keep the `/` separators intact, so a key like
// `p/<slug>` maps to the same nested object path Cloudflare expects.
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function objectUrl(cfg: R2Config, key: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/r2/buckets/${encodeURIComponent(
    cfg.bucket,
  )}/objects/${encodeKey(key)}`;
}

function firstErrorMessage(body: CloudflareResponse, fallback: string): string {
  const msg = body.errors?.find((e) => e.message)?.message;
  return msg && msg.trim() ? msg : fallback;
}

/** Upload (create or overwrite) an HTML object at `key`. Throws on failure. */
export async function putHtml(cfg: R2Config, key: string, html: string): Promise<void> {
  const res = await fetch(objectUrl(cfg, key), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'text/html; charset=utf-8',
      // Public pages must stop serving as soon as their R2 object is removed.
      // Avoid an edge/browser copy surviving past the seven-day expiry.
      'Cache-Control': 'no-store, max-age=0',
    },
    body: html,
  });
  const body = (await res.json().catch(() => ({}))) as CloudflareResponse;
  if (!res.ok || body.success === false) {
    throw new Error(firstErrorMessage(body, `Cloudflare R2 upload failed (${res.status})`));
  }
}

/**
 * Upload raw bytes at `key` with a caller-supplied content type. Used for font
 * files under `f/`, which are immutable (a new upload gets a new key) and so
 * may be cached hard, unlike the no-store HTML above.
 */
export async function putObject(
  cfg: R2Config,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const res = await fetch(objectUrl(cfg, key), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    // A plain ArrayBuffer slice: fetch's BodyInit does not accept a Uint8Array
    // view here, and font files are small enough that the copy is free.
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
  const body = (await res.json().catch(() => ({}))) as CloudflareResponse;
  if (!res.ok || body.success === false) {
    throw new Error(firstErrorMessage(body, `Cloudflare R2 upload failed (${res.status})`));
  }
}

/** Delete an object at `key`. Missing-object responses are treated as success. */
export async function deleteObject(cfg: R2Config, key: string): Promise<void> {
  const res = await fetch(objectUrl(cfg, key), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${cfg.apiToken}` },
  });
  if (res.ok || res.status === 404) return;
  const body = (await res.json().catch(() => ({}))) as CloudflareResponse;
  // A missing object may also surface as a non-404 with a not-found error code
  // (10007) — treat those as already-gone so deletes are idempotent.
  if (body.errors?.some((e) => e.code === 10007 || /not found/i.test(e.message ?? ''))) return;
  if (body.success === false || !res.ok) {
    throw new Error(firstErrorMessage(body, `Cloudflare R2 delete failed (${res.status})`));
  }
}

function lifecycleUrl(cfg: R2Config): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/r2/buckets/${encodeURIComponent(
    cfg.bucket,
  )}/lifecycle`;
}

/**
 * Ensure R2 also removes every p/ object after seven days. The local cleanup
 * service is the prompt path; this rule is the outage-safe backstop.
 */
export async function ensurePageExpiryLifecycle(cfg: R2Config, maxAgeSeconds: number): Promise<void> {
  const headers = { Authorization: `Bearer ${cfg.apiToken}` };
  const get = await fetch(lifecycleUrl(cfg), { headers, signal: AbortSignal.timeout(10_000) });
  const getBody = (await get.json().catch(() => ({}))) as CloudflareResponse;
  if (!get.ok || getBody.success === false) {
    throw new Error(firstErrorMessage(getBody, `Cloudflare R2 lifecycle read failed (${get.status})`));
  }

  const desired: R2LifecycleRule = {
    id: PAGE_EXPIRY_RULE_ID,
    enabled: true,
    conditions: { prefix: 'p/' },
    deleteObjectsTransition: {
      condition: { type: 'Age', maxAge: maxAgeSeconds },
    },
  };
  const current = getBody.result?.rules ?? [];
  const existing = current.find((rule) => rule.id === PAGE_EXPIRY_RULE_ID);
  if (
    existing?.enabled === true &&
    existing.conditions?.prefix === 'p/' &&
    existing.deleteObjectsTransition?.condition.type === 'Age' &&
    existing.deleteObjectsTransition.condition.maxAge === maxAgeSeconds
  ) {
    return;
  }

  const rules = [...current.filter((rule) => rule.id !== PAGE_EXPIRY_RULE_ID), desired];
  const put = await fetch(lifecycleUrl(cfg), {
    method: 'PUT',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'cf-r2-data-catalog-check': 'true',
    },
    body: JSON.stringify({ rules }),
    signal: AbortSignal.timeout(10_000),
  });
  const putBody = (await put.json().catch(() => ({}))) as CloudflareResponse;
  if (!put.ok || putBody.success === false) {
    throw new Error(firstErrorMessage(putBody, `Cloudflare R2 lifecycle update failed (${put.status})`));
  }
}
