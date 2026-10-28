import type Database from 'better-sqlite3';
import { createCsTicketService, type SyncMessage } from './service.js';

/**
 * Read-only OrderOps mirror for tickets owned inside Veneer (Miles pilot).
 * Every two minutes the web service reads the messages of each open owned
 * ticket with a dedicated principal and records what is new; a new customer
 * message wakes the ticket chat. The client can only GET allowlisted paths
 * (messages, ticket search, attachment files), so OrderOps leases,
 * assignment, statuses and sends are untouched.
 */
export const ORDEROPS_ORIGIN = 'https://orderops-dev-web-production.up.railway.app';
export const MIRROR_SECRET = { project: 'ervp', config: 'prd', credential: 'ORDEROPS_TICKET_MIRROR_BOT_CREDENTIAL' } as const;
export const POLL_INTERVAL_MS = 2 * 60_000;
export const POLL_BATCH = 25;
export const POLL_TIMEOUT_MS = 10_000;
export const AUTH_BLOCK_MS = 15 * 60_000;
export const CREDENTIAL_CACHE_MS = 10 * 60_000;
const BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 30 * 60_000];
/** Attachment files a message points at: Gmail-proxied photos, stored blobs, and uploads. */
const ATTACHMENT_PATHS = [/^\/api\/cs\/gmail-attachments\/[A-Za-z0-9_-]{1,200}\/[A-Za-z0-9_-]{1,1500}$/, /^\/api\/cs\/attachment-blobs\/[A-Za-z0-9_-]{1,200}$/, /^\/objects\/uploads\/[A-Za-z0-9_-]{1,200}(\.[A-Za-z0-9]{1,8})?$/];
const ALLOWED_PATHS = [/^\/api\/cs\/conversations\/[A-Za-z0-9_.:-]{1,100}\/messages$/, /^\/api\/cs\/leases\/capability$/, /^\/api\/cs\/conversations\?search=[A-Za-z0-9_.:%-]{1,100}&limit=\d{1,2}$/, ...ATTACHMENT_PATHS];
/** The OrderOps path of an attachment reference the mirror may fetch, or null (outside links, unknown shapes). */
export function attachmentPath(reference: string | undefined | null): string | null {
  let ref = (reference ?? '').trim();
  if (ref.startsWith(ORDEROPS_ORIGIN)) ref = ref.slice(ORDEROPS_ORIGIN.length);
  return ATTACHMENT_PATHS.some((re) => re.test(ref)) ? ref : null;
}
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const FILE_BUSY_RETRIES = 4;
/** What the task pane may show inline; anything else stays a name. */
export const SHOWABLE_TYPE = /^(image\/(jpeg|png|gif|webp|heic|heif)|application\/pdf)$/;
/** SQLite said another writer holds the database; the read itself succeeded. */
export function isDatabaseBusy(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === 'SQLITE_BUSY' || /database is locked/i.test(err?.message ?? '');
}
/** An OrderOps ticket code (VKNA4G), never an order number (100122214) and never a conversation uuid. */
export const TICKET_CODE = /^[A-Z0-9]{5,8}$/;
export const CONVERSATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function classifyCaseKey(key: string | null | undefined): 'uuid' | 'ticket_code' | 'order_number' | 'other' {
  const k = (key ?? '').trim();
  if (!k) return 'other';
  if (CONVERSATION_UUID.test(k)) return 'uuid';
  if (/^\d{6,}$/.test(k)) return 'order_number';
  if (TICKET_CODE.test(k.toUpperCase()) && /[A-Z]/i.test(k)) return 'ticket_code';
  return 'other';
}
const MAX_BODY = 4 * 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The only requests the mirror may make: GET on an allowlisted path. Throws before any network call. */
export function mirrorRequestUrl(path: string, method = 'GET'): string {
  if (method !== 'GET') throw new Error(`Ticket mirror is read-only: ${method} refused`);
  if (!ALLOWED_PATHS.some((re) => re.test(path))) throw new Error(`Ticket mirror path not allowed: ${path}`);
  return `${ORDEROPS_ORIGIN}${path}`;
}

/** cs_messages row as GET /api/cs/conversations/:id/messages returns it (Order Ops shared/schema.ts), plus the SMS delivery readback. */
export interface OrderOpsMessage {
  id: string;
  direction: string;
  channel: string;
  fromName?: string | null;
  fromEmail?: string | null;
  fromPhone?: string | null;
  body: string;
  attachments?: string | { filename?: string; name?: string; url?: string }[] | null;
  actorType?: string | null;
  actorContext?: Record<string, unknown> | null;
  aiGenerated?: boolean | null;
  messageType?: string | null;
  createdAt: string;
  deliveryStatus?: string | null;
}
const CHANNELS = new Set(['email', 'sms', 'phone', 'chat']);
/** Map one OrderOps message onto the ticket record; internal notes and empty bodies are not customer-thread messages. */
export function mapOrderOpsMessage(m: OrderOpsMessage): SyncMessage | null {
  if (!m?.id || typeof m.body !== 'string') return null;
  if (m.messageType && m.messageType !== 'message' && m.messageType !== 'forward') return null;
  const inbound = m.direction === 'inbound';
  const at = new Date(m.createdAt);
  if (!Number.isFinite(at.getTime())) return null;
  const context = (m.actorContext ?? {}) as { profile?: unknown; displayName?: unknown; name?: unknown };
  const actorLabel = [context.displayName, context.profile, context.name].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const label = inbound ? (m.fromName || m.fromEmail || m.fromPhone || 'Customer') : (actorLabel || m.fromName || m.actorType || 'OrderOps');
  const actor = String(m.actorType ?? '').toLowerCase();
  const author: SyncMessage['author'] = inbound ? 'customer' : (m.aiGenerated || /bot|veneer|grok|hermes|api|service|principal/.test(actor)) ? 'bot' : 'human';
  let attachments: { name: string; reference?: string }[] = [];
  try {
    const raw = typeof m.attachments === 'string' ? JSON.parse(m.attachments) : m.attachments;
    if (Array.isArray(raw)) attachments = raw.flatMap((a) => { const name = String(a?.filename ?? a?.name ?? '').trim(); return name ? [{ name: name.slice(0, 300), ...(typeof a?.url === 'string' ? { reference: a.url.slice(0, 2000) } : {}) }] : []; }).slice(0, 20);
  } catch { attachments = []; }
  const delivery = !inbound && m.channel === 'sms' && m.deliveryStatus ? `\n\n[SMS delivery: ${String(m.deliveryStatus).slice(0, 40)}]` : '';
  const body = `${m.body.trim() || (attachments.length ? '(attachment only)' : '')}${delivery}`.slice(0, 20000);
  if (!body) return null;
  return {
    external_id: String(m.id).slice(0, 200), direction: inbound ? 'in' : 'out', channel: CHANNELS.has(m.channel) ? (m.channel as SyncMessage['channel']) : 'other',
    author, author_label: String(label).slice(0, 200), body, attachments, at: at.toISOString(),
  };
}

export interface PollerDeps {
  fetch?: typeof fetch;
  readCredential: () => Promise<string>;
  now?: () => number;
  log?: { info: (m: string) => void; warn: (m: string) => void };
}
export interface PollSummary { skipped: 'interval' | 'auth_block' | 'credential' | null; polled: number; added: number; woke: number; errors: number }

export function createTicketPoller(db: Database.Database, deps: PollerDeps) {
  const tickets = createCsTicketService(db);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? { info: () => {}, warn: (m: string) => console.warn(m) };
  const doFetch = deps.fetch ?? fetch;
  const backoff = new Map<string, { failures: number; nextAt: number }>();
  let lastRun = 0, authBlockedUntil = 0, authLogged = false;
  let cached: { value: string; at: number } | null = null;
  async function credential(): Promise<string> {
    if (cached && now() - cached.at < CREDENTIAL_CACHE_MS) return cached.value;
    const value = await deps.readCredential();
    cached = { value, at: now() };
    return value;
  }
  async function readMessages(orderopsTicketId: string, bearer: string): Promise<OrderOpsMessage[]> {
    const url = mirrorRequestUrl(`/api/cs/conversations/${encodeURIComponent(orderopsTicketId)}/messages`);
    const response = await doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(POLL_TIMEOUT_MS), cache: 'no-store' });
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw Object.assign(new Error(`OrderOps refused the mirror principal (${response.status})`), { auth: true }); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OrderOps returned ${response.status}`); }
    const text = await response.text();
    if (text.length > MAX_BODY) throw new Error('OrderOps response exceeds bound');
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) throw new Error('OrderOps messages response was not a list');
    return parsed as OrderOpsMessage[];
  }
  /** Find the OrderOps conversation for a ticket code; only an exact ticketNumber match counts. */
  async function findConversation(code: string, bearer: string): Promise<{ id: string; ticketNumber: string; subject?: string; status?: string; customer?: { name?: string; email?: string; phone?: string } | null; customerName?: string; customerEmail?: string; customerPhone?: string } | null> {
    const url = mirrorRequestUrl(`/api/cs/conversations?search=${encodeURIComponent(code)}&limit=5`);
    const response = await doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(POLL_TIMEOUT_MS), cache: 'no-store' });
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw Object.assign(new Error(`OrderOps refused the mirror principal (${response.status})`), { auth: true }); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OrderOps returned ${response.status}`); }
    const text = await response.text();
    if (text.length > MAX_BODY) throw new Error('OrderOps response exceeds bound');
    const parsed = JSON.parse(text) as { conversations?: unknown[] } | unknown[];
    const list = (Array.isArray(parsed) ? parsed : parsed.conversations ?? []) as { id?: string; ticketNumber?: string }[];
    const hit = list.find((c) => typeof c.ticketNumber === 'string' && c.ticketNumber.toUpperCase() === code.toUpperCase() && typeof c.id === 'string');
    return (hit as ReturnType<typeof findConversation> extends Promise<infer R> ? R : never) ?? null;
  }
  const inflightFiles = new Map<string, Promise<{ type: string; bytes: Buffer } | { error: string; status: number }>>();
  let fileQueue: Promise<unknown> = Promise.resolve();
  async function fetchFile(path: string): Promise<{ type: string; bytes: Buffer } | { error: string; status: number }> {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(mirrorRequestUrl(path), { method: 'GET', headers: { Authorization: `Bearer ${await credential()}` }, redirect: 'error', signal: AbortSignal.timeout(20_000), cache: 'no-store' });
      if (response.status === 429 && attempt < FILE_BUSY_RETRIES) {
        await response.body?.cancel();
        await sleep(Math.min(5, Math.max(1, Number(response.headers.get('retry-after')) || 1)) * 1000 * (attempt + 1));
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); return { error: response.status === 429 ? 'OrderOps is busy; try again in a moment' : `OrderOps returned ${response.status}`, status: response.status === 404 ? 404 : response.status === 429 ? 503 : 502 }; }
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!SHOWABLE_TYPE.test(type)) { await response.body?.cancel(); return { error: 'Only photos and PDFs are shown here', status: 415 }; }
      if (Number(response.headers.get('content-length') ?? 0) > ATTACHMENT_MAX_BYTES) { await response.body?.cancel(); return { error: 'File is larger than 10 MB', status: 413 }; }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > ATTACHMENT_MAX_BYTES) return { error: 'File is larger than 10 MB', status: 413 };
      return { type, bytes };
    }
  }
  return {
    findConversation: async (code: string) => findConversation(code, await credential()),
    /**
     * Read one ticket now (the task pane asked); records new messages with the usual dedupe.
     * If the save is blocked by another writer it retries once, then hands back the live
     * messages so the pane still shows the thread; a busy database is not a poll error.
     */
    async readNow(ticketId: string): Promise<{ added: number; error: string | null; live?: SyncMessage[] }> {
      const t = tickets.read(ticketId);
      if (!t) return { added: 0, error: 'Ticket not found' };
      let messages: SyncMessage[];
      try {
        messages = (await readMessages(t.orderops_ticket_id, await credential())).map(mapOrderOpsMessage).filter((m): m is SyncMessage => m !== null);
      } catch (e) {
        const err = e as Error & { auth?: boolean };
        try { tickets.markPollError(t.id, err.message, new Date(now())); } catch (w) { if (!isDatabaseBusy(w)) throw w; }
        if (err.auth) { authBlockedUntil = now() + AUTH_BLOCK_MS; cached = null; }
        return { added: 0, error: err.message };
      }
      for (let attempt = 0; ; attempt++) {
        try {
          return { added: tickets.applyPolledMessages(t.id, messages, new Date(now())).added, error: null };
        } catch (e) {
          if (!isDatabaseBusy(e)) throw e;
          if (attempt >= 1) { log.warn(`[cs-ticket-poll] ticket ${t.orderops_ticket_id}: database busy, showing live messages unsaved`); return { added: 0, error: null, live: messages }; }
          await sleep(500);
        }
      }
    },
    /**
     * Fetch one attachment file through the read-only principal; images and PDFs only, 10 MB cap.
     * OrderOps admits two requests at a time per principal and answers 429 beyond that, so files
     * are fetched one at a time (leaving a slot for thread reads), a 429 is retried after its
     * Retry-After, and concurrent asks for the same file share one fetch.
     */
    fetchAttachment(reference: string): Promise<{ type: string; bytes: Buffer } | { error: string; status: number }> {
      const path = attachmentPath(reference);
      if (!path) return Promise.resolve({ error: 'This file is not stored in OrderOps', status: 404 });
      const pending = inflightFiles.get(path);
      if (pending) return pending;
      const job = fileQueue.then(() => fetchFile(path));
      fileQueue = job.catch(() => undefined);
      inflightFiles.set(path, job);
      void job.finally(() => inflightFiles.delete(path)).catch(() => undefined);
      return job;
    },
    /** Called often (the bot background loop ticks every few seconds); runs at most once per interval. */
    async tick(force = false): Promise<PollSummary> {
      const summary: PollSummary = { skipped: null, polled: 0, added: 0, woke: 0, errors: 0 };
      if (!force && now() - lastRun < POLL_INTERVAL_MS) return { ...summary, skipped: 'interval' };
      if (now() < authBlockedUntil) return { ...summary, skipped: 'auth_block' };
      lastRun = now();
      const candidates = tickets.pollCandidates(POLL_BATCH).filter((t) => (backoff.get(t.id)?.nextAt ?? 0) <= now());
      if (!candidates.length) return summary;
      let bearer: string;
      try { bearer = await credential(); } catch (e) { log.warn(`[cs-ticket-poll] credential unavailable: ${(e as Error).message}`); return { ...summary, skipped: 'credential' }; }
      for (const t of candidates) {
        try {
          const messages = (await readMessages(t.orderops_ticket_id, bearer)).map(mapOrderOpsMessage).filter((m): m is SyncMessage => m !== null);
          const r = tickets.applyPolledMessages(t.id, messages, new Date(now()));
          backoff.delete(t.id);
          summary.polled++; summary.added += r.added; summary.woke += Number(r.woke);
          if (r.added) log.info(`[cs-ticket-poll] ticket ${t.orderops_ticket_id}: ${r.added} new message(s)${r.woke ? ', ticket chat woken' : ''}`);
        } catch (e) {
          const err = e as Error & { auth?: boolean };
          summary.errors++;
          if (isDatabaseBusy(err)) { log.warn(`[cs-ticket-poll] ticket ${t.orderops_ticket_id}: database busy, retrying next round`); continue; }
          tickets.markPollError(t.id, err.message, new Date(now()));
          if (err.auth) {
            authBlockedUntil = now() + AUTH_BLOCK_MS;
            cached = null;
            if (!authLogged) { log.warn(`[cs-ticket-poll] ${err.message}; pausing the mirror for 15 minutes`); authLogged = true; }
            break;
          }
          const prior = backoff.get(t.id)?.failures ?? 0;
          backoff.set(t.id, { failures: prior + 1, nextAt: now() + BACKOFF_MS[Math.min(prior, BACKOFF_MS.length - 1)]! });
          log.warn(`[cs-ticket-poll] ticket ${t.orderops_ticket_id}: ${err.message}`);
        }
      }
      if (summary.polled) authLogged = false;
      return summary;
    },
    backoffState: (ticketId: string) => backoff.get(ticketId) ?? null,
    authBlockedUntil: () => authBlockedUntil,
  };
}
export type TicketPoller = ReturnType<typeof createTicketPoller>;
