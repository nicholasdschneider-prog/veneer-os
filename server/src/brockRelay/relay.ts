import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { decisionOrders, defaultDecisionChoices, type Decision, type EvidenceItem, type StaleMark } from '../bots/service.js';
import { attachmentPath } from '../csTickets/poll.js';
import { presentMessage, type CsTicketMessageRow, type CsTicketRow } from '../csTickets/service.js';

/**
 * Brock relay (docs/brock-relay.md): Tess's needs-Nick decision cards are
 * pushed to the Grok Bot "Brock" so Nick gets an iOS notification, and Brock
 * can answer through the James API. Brock never works tickets; Tess stays the
 * case owner and the Veneer web cards keep working unchanged.
 *
 * Every setting is a Doppler secret (refreshed by the web service without a
 * restart), so the relay is switched on, to test only, or off from Doppler.
 */
export const BROCK_KEYS = {
  mode: 'BROCK_RELAY_MODE',
  url: 'BROCK_RELAY_WEBHOOK_URL',
  secret: 'BROCK_RELAY_WEBHOOK_SECRET',
  testChat: 'BROCK_RELAY_TEST_CHAT_ID',
  botChats: 'BROCK_RELAY_BOT_CHAT_IDS',
} as const;
export const DEFAULT_RELAY_BOT = 'Tess';
export const FILE_URL_TTL_MS = 7 * 86_400_000;
/** A file link keeps working this long after its card resolves, so a just-answered card still shows its photos. */
const FILE_GRACE_AFTER_RESOLVE_MS = 3_600_000;
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
export const MAX_ATTEMPTS = 12;
const MAX_CLIENT_ERROR_ATTEMPTS = 3;
const MAX_ATTACHMENTS = 40;
const MAX_MESSAGES = 10;

export type RelayMode = 'off' | 'test' | 'live';
export interface RelaySettings { mode: Exclude<RelayMode, 'off'>; url: URL; secret: string; testChatId: string | null; botChatIds: string[]; publicBase: string }
export type GetSecret = (name: string) => string | null;

export function ownerId(db: Database.Database): number | null {
  return (db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id ?? null;
}

/** The relay settings, or null when it is off or incomplete (the reason names keys only, never values). */
export function relaySettings(db: Database.Database, getSecret: GetSecret, publicBase: string | null): { settings: RelaySettings | null; reason: string | null } {
  const raw = (getSecret(BROCK_KEYS.mode) ?? 'off').toLowerCase();
  if (raw !== 'test' && raw !== 'live') return { settings: null, reason: raw === 'off' ? null : `${BROCK_KEYS.mode} must be off, test or live` };
  const missing: string[] = [];
  const urlText = getSecret(BROCK_KEYS.url);
  const secret = getSecret(BROCK_KEYS.secret);
  let url: URL | null = null;
  try { url = urlText ? new URL(urlText) : null; } catch { url = null; }
  if (!url || url.protocol !== 'https:') missing.push(`${BROCK_KEYS.url} (https)`);
  if (!secret || secret.length < 24) missing.push(`${BROCK_KEYS.secret} (24+ characters)`);
  if (!publicBase) missing.push('VP_APPS_PUBLIC_ORIGIN');
  const testChatId = getSecret(BROCK_KEYS.testChat);
  if (raw === 'test' && !testChatId) missing.push(BROCK_KEYS.testChat);
  if (missing.length) return { settings: null, reason: `relay is ${raw} but missing ${missing.join(', ')}` };
  const listed = (getSecret(BROCK_KEYS.botChats) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const botChatIds = listed.length ? listed
    : (db.prepare('SELECT conversation_id FROM bot_registrations WHERE name=? AND active=1').all(DEFAULT_RELAY_BOT) as { conversation_id: string }[]).map((r) => r.conversation_id);
  return { settings: { mode: raw, url: url!, secret: secret!, testChatId, botChatIds, publicBase: publicBase!.replace(/\/+$/, '') }, reason: null };
}

// ---- Signing -------------------------------------------------------------

/** Same scheme as the James push: HMAC-SHA256 of the raw body with the shared secret. */
export function signBody(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

export interface FileClaims { d: string; v: number; k: 'img' | 'ev' | 'tm' | 'blob'; i?: number; m?: string; h?: string; exp: number }
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
/** File links use a key derived from the secret, so a link can never be replayed as a webhook signature. */
const fileKey = (secret: string) => crypto.createHmac('sha256', secret).update('brock-relay-file-url-v1').digest();
export function signFileToken(secret: string, claims: FileClaims): string {
  const payload = b64(JSON.stringify(claims));
  return `v1.${payload}.${b64(crypto.createHmac('sha256', fileKey(secret)).update(`v1.${payload}`).digest())}`;
}
export function verifyFileToken(secret: string, token: string, nowMs: number): FileClaims | null {
  const [ver, payload, sig] = token.split('.');
  if (ver !== 'v1' || !payload || !sig || token.split('.').length !== 3) return null;
  const expected = crypto.createHmac('sha256', fileKey(secret)).update(`v1.${payload}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as FileClaims;
    if (typeof claims.exp !== 'number' || claims.exp < nowMs || typeof claims.d !== 'string' || typeof claims.v !== 'number') return null;
    return claims;
  } catch { return null; }
}

// ---- Card payload --------------------------------------------------------

interface RelayRow { decision_id: string; version: number; status: 'active' | 'resolved'; test: number; resolution: string | null; answered_via: string | null; raised_at: string; resolved_at: string | null }
interface OutboxRow { id: number; event_type: 'card.raised' | 'card.resolved'; decision_id: string; version: number; detail_json: string; status: string; attempts: number; next_attempt_at: string; last_error: string | null; created_at: string }
type P = {
  question: string; recommendation: string; consequence: string; blocked_action: string; deadline?: string | null;
  choices?: { id: string; label: string; description?: string; action: string; answer?: string; recommended?: boolean }[];
  review_summary?: Record<string, unknown> & { action_title?: string };
  images?: { label: string; sha256?: string }[];
  evidence_items?: EvidenceItem[];
  case_timeline?: unknown[];
  as_of?: { ticket_id?: string; orders?: { order_number: string }[] };
  shopify_order?: { number?: string } | null;
  message_delivery?: { payload: { channel: string; recipients: string[]; subject: string; body: string; customer: string; ticket: string; attachments?: { name: string; reference: string; sha256?: string }[] } };
};
const clip = (s: string | null | undefined, n: number) => (s ?? '').length > n ? `${(s ?? '').slice(0, n - 1)}…` : (s ?? '');
const iso = (sqlite: string) => /[zZ]|[+-]\d\d:?\d\d$/.test(sqlite) ? new Date(sqlite).toISOString() : new Date(`${sqlite.replace(' ', 'T')}Z`).toISOString();

function ticketFor(db: Database.Database, d: Decision & { cs_ticket_id?: string | null; task_id?: string | null }): CsTicketRow | undefined {
  if (d.cs_ticket_id) { const t = db.prepare('SELECT * FROM cs_tickets WHERE id=?').get(d.cs_ticket_id) as CsTicketRow | undefined; if (t) return t; }
  if (d.task_id) return db.prepare('SELECT * FROM cs_tickets WHERE task_id=?').get(d.task_id) as CsTicketRow | undefined;
  return undefined;
}
function fileKind(name: string, hint?: string): 'image' | 'document' | 'file' {
  if (hint === 'image') return 'image';
  if (/\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)$/i.test(name)) return 'image';
  if (hint === 'document' || /\.(pdf|docx?|xlsx?|csv|txt)$/i.test(name)) return 'document';
  return 'file';
}

export interface Attachment { id: string; origin: 'card_image' | 'card_evidence' | 'ticket_message' | 'proposed_reply'; kind: 'image' | 'document' | 'file'; name: string; sha256: string | null; url: string | null; expires_at: string | null; unavailable_reason?: string }

/** Every file on the card and its ticket, each as a signed link Brock fetches without a login. */
export function cardAttachments(db: Database.Database, d: Decision, sign: (claims: Omit<FileClaims, 'd' | 'v' | 'exp'>) => { url: string; expires_at: string }): { attachments: Attachment[]; truncated: boolean } {
  const p = JSON.parse(d.proposal_json) as P;
  const out: Attachment[] = [];
  for (const [i, img] of (p.images ?? []).entries()) {
    out.push(img.sha256 ? { id: `img-${i}`, origin: 'card_image', kind: 'image', name: img.label, sha256: img.sha256, ...sign({ k: 'img', i }) }
      : { id: `img-${i}`, origin: 'card_image', kind: 'image', name: img.label, sha256: null, url: null, expires_at: null, unavailable_reason: 'image not bound to retained bytes' });
  }
  const human = (db.prepare("SELECT payload_json FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='evidence_added' ORDER BY rowid").all(d.id, d.version) as { payload_json: string }[])
    .map((r) => JSON.parse(r.payload_json) as EvidenceItem);
  for (const [i, item] of [...(p.evidence_items ?? []), ...human].entries()) {
    if (item.retained && item.sha256) out.push({ id: `ev-${i}`, origin: 'card_evidence', kind: fileKind(item.label, item.kind), name: item.label, sha256: item.sha256, ...sign({ k: 'ev', i }) });
    else if (item.kind === 'image' || item.kind === 'document') out.push({ id: `ev-${i}`, origin: 'card_evidence', kind: item.kind, name: item.label, sha256: null, url: null, expires_at: null, unavailable_reason: 'file was not retained on the card' });
  }
  const ticket = ticketFor(db, d as Decision & { cs_ticket_id?: string | null; task_id?: string | null });
  if (ticket) {
    const messages = db.prepare("SELECT * FROM cs_ticket_messages WHERE ticket_id=? AND direction<>'note' ORDER BY at").all(ticket.id) as CsTicketMessageRow[];
    for (const m of messages) {
      for (const [i, a] of presentMessage(m).attachments.entries()) {
        const id = `tm-${m.id}-${i}`;
        out.push(attachmentPath(a.reference) ? { id, origin: 'ticket_message', kind: fileKind(a.name), name: a.name, sha256: null, ...sign({ k: 'tm', m: m.id, i }) }
          : { id, origin: 'ticket_message', kind: fileKind(a.name), name: a.name, sha256: null, url: null, expires_at: null, unavailable_reason: 'outside link Veneer cannot fetch' });
      }
    }
  }
  for (const [i, a] of (p.message_delivery?.payload.attachments ?? []).entries()) {
    out.push(a.sha256 ? { id: `pr-${i}`, origin: 'proposed_reply', kind: fileKind(a.name), name: a.name, sha256: a.sha256, ...sign({ k: 'blob', h: a.sha256 }) }
      : { id: `pr-${i}`, origin: 'proposed_reply', kind: fileKind(a.name), name: a.name, sha256: null, url: null, expires_at: null, unavailable_reason: 'not retained on this server' });
  }
  return { attachments: out.slice(0, MAX_ATTACHMENTS), truncated: out.length > MAX_ATTACHMENTS };
}

export function buildCard(db: Database.Database, d: Decision, settings: RelaySettings, nowMs: number) {
  const p = JSON.parse(d.proposal_json) as P;
  const dx = d as Decision & { cs_ticket_id?: string | null; task_id?: string | null };
  const bot = db.prepare('SELECT name FROM bot_registrations WHERE conversation_id=?').get(d.conversation_id) as { name: string } | undefined;
  const task = dx.task_id ? db.prepare('SELECT id,title,case_key FROM bot_tasks WHERE id=?').get(dx.task_id) as { id: string; title: string; case_key: string | null } | undefined : undefined;
  const ticket = ticketFor(db, dx);
  const orders = decisionOrders(p as Parameters<typeof decisionOrders>[0]);
  const customerName = ticket?.customer_name || p.message_delivery?.payload.customer || null;
  const customer = customerName || ticket?.customer_email || ticket?.customer_phone
    ? { name: customerName, email: ticket?.customer_email || null, phone: ticket?.customer_phone || null } : null;
  const exp = nowMs + FILE_URL_TTL_MS;
  const sign = (c: Omit<FileClaims, 'd' | 'v' | 'exp'>) => ({
    url: `${settings.publicBase}/api/james/brock/files/${signFileToken(settings.secret, { ...c, d: d.id, v: d.version, exp })}`,
    expires_at: new Date(exp).toISOString(),
  });
  const { attachments, truncated } = cardAttachments(db, d, sign);
  const messages = ticket ? (db.prepare("SELECT * FROM cs_ticket_messages WHERE ticket_id=? AND direction<>'note' ORDER BY at DESC LIMIT ?").all(ticket.id, MAX_MESSAGES) as CsTicketMessageRow[]).reverse() : [];
  const evidence = [...(p.evidence_items ?? [])].filter((e) => e.text && (e.kind === 'record' || e.kind === 'message'));
  const delivery = p.message_delivery?.payload;
  return {
    card_id: d.id,
    version: d.version,
    bot: { name: bot?.name ?? null, conversation_id: d.conversation_id },
    raised_at: iso(d.updated_at),
    deadline: p.deadline ?? null,
    ticket: {
      orderops_ticket_id: p.as_of?.ticket_id ?? ticket?.orderops_ticket_id ?? null,
      cs_ticket_id: ticket?.id ?? null,
      task_id: task?.id ?? null,
      case_key: task?.case_key ?? null,
      subject: ticket?.subject || task?.title || null,
    },
    customer,
    customer_note: customer ? null : 'No customer name or contact on this card or its ticket.',
    order_number: orders[0] ?? null,
    order_numbers: orders,
    order_note: orders.length ? null : 'No order number on this card or its ticket.',
    title: p.review_summary?.action_title ?? null,
    question: p.question,
    options: (p.choices ?? defaultDecisionChoices).map((c) => ({
      id: c.id, label: c.label, description: ('description' in c ? c.description : undefined) ?? null, action: c.action,
      value: ('answer' in c ? c.answer : undefined) ?? null, recommended: Boolean('recommended' in c && c.recommended),
    })),
    free_text_allowed: true,
    backstory: {
      recommendation: p.recommendation,
      consequence: p.consequence,
      blocked_action: p.blocked_action,
      review_summary: p.review_summary ?? null,
      case_timeline: p.case_timeline ?? [],
      evidence_notes: evidence.map((e) => ({ kind: e.kind, label: e.label, source: e.source.system, text: clip(e.text, 600) })),
      ticket_summary: ticket?.summary ? clip(ticket.summary, 1200) : null,
      recent_messages: messages.map((m) => ({ at: m.at, direction: m.direction, author: m.author_label || m.author, text: clip(m.body, 800) })),
      proposed_reply: delivery ? { channel: delivery.channel, recipients: delivery.recipients, subject: delivery.subject || null, body: delivery.body } : null,
    },
    attachments,
    attachments_truncated: truncated,
    links: {
      card_url: `${settings.publicBase}/#/chat/${d.conversation_id}`,
      refresh_url: `${settings.publicBase}/api/james/brock/cards/${d.id}`,
      answer_url: `${settings.publicBase}/api/james/brock/answer`,
    },
  };
}

// ---- Resolution ----------------------------------------------------------

export function resolutionOf(db: Database.Database, row: RelayRow, d: Decision | undefined, inScope: boolean): { resolution: string; detail: Record<string, unknown> } | null {
  if (!d) return { resolution: 'withdrawn', detail: { detail: 'The card no longer exists.' } };
  if (d.version > row.version) return { resolution: 'superseded', detail: { superseded_by_version: d.version } };
  if (d.state !== 'needs_input') {
    const a = d.answer_json ? JSON.parse(d.answer_json) as { action?: string; text?: string; choice_id?: string; choice_label?: string; answer?: string; automatic?: boolean; by_bot?: boolean } : {};
    const answer = { action: a.action ?? null, text: a.text ?? null, choice_id: a.choice_id ?? null, choice_label: a.choice_label ?? null, value: a.answer ?? null };
    if (a.automatic) return { resolution: 'expired', detail: { answer } };
    if (a.by_bot) return { resolution: 'withdrawn', detail: { answer } };
    const via = row.answered_via ?? (db.prepare("SELECT 1 FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='answered' AND request_key LIKE 'brock:%'").get(d.id, d.version) ? 'grokbot_brock' : 'veneer');
    return { resolution: 'answered', detail: { answered_via: via, answer } };
  }
  if (d.stale_json) return { resolution: 'stale', detail: { detail: (JSON.parse(d.stale_json) as StaleMark).detail } };
  if (!inScope) return { resolution: 'unrelayed', detail: { detail: 'The card is no longer waiting on Nick through the relay.' } };
  return null;
}

// ---- Reconcile and dispatch ---------------------------------------------

export interface RelayDeps { db: Database.Database; getSecret: GetSecret; publicBase: string | null; fetch: typeof fetch; now: () => number; log: (m: string) => void }

export function createBrockRelay(deps: RelayDeps) {
  const { db } = deps;
  let lastReason: string | null = null;
  function settings(): RelaySettings | null {
    const { settings, reason } = relaySettings(db, deps.getSecret, deps.publicBase);
    if (reason !== lastReason) { lastReason = reason; if (reason) deps.log(`[brock-relay] off: ${reason}`); }
    return settings;
  }
  function scopeChats(s: RelaySettings) {
    return [...new Set([...(s.mode === 'live' ? s.botChatIds : []), ...(s.testChatId ? [s.testChatId] : [])])];
  }
  function inScope(s: RelaySettings, d: Decision, owner: number) {
    return scopeChats(s).includes(d.conversation_id) && d.assignee_id === owner && d.state === 'needs_input' && !d.stale_json
      && Boolean(db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(d.conversation_id));
  }
  const enqueue = (type: OutboxRow['event_type'], decisionId: string, version: number, detail: Record<string, unknown> = {}) =>
    db.prepare('INSERT INTO brock_relay_outbox(event_type,decision_id,version,detail_json,next_attempt_at) VALUES(?,?,?,?,?)')
      .run(type, decisionId, version, JSON.stringify(detail), new Date(deps.now()).toISOString());

  /** Diff open needs-Nick cards against what Brock has; queue raised/resolved events. */
  function reconcile(s: RelaySettings) {
    const owner = ownerId(db);
    if (owner === null) return;
    const chats = scopeChats(s);
    const now = new Date(deps.now()).toISOString();
    db.transaction(() => {
      for (const row of db.prepare("SELECT * FROM brock_relay_cards WHERE status='active'").all() as RelayRow[]) {
        const d = db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(row.decision_id) as Decision | undefined;
        const r = resolutionOf(db, row, d, Boolean(d && inScope(s, d, owner)));
        if (!r) continue;
        db.prepare("UPDATE brock_relay_cards SET status='resolved',resolution=?,answered_via=COALESCE(answered_via,?),resolved_at=? WHERE decision_id=?")
          .run(r.resolution, (r.detail.answered_via as string | undefined) ?? null, now, row.decision_id);
        enqueue('card.resolved', row.decision_id, row.version, { resolution: r.resolution, ...r.detail });
      }
      if (!chats.length) return;
      const open = db.prepare(`SELECT * FROM bot_decisions WHERE state='needs_input' AND stale_json IS NULL AND assignee_id=?
        AND conversation_id IN (${chats.map(() => '?').join(',')})`).all(owner, ...chats) as Decision[];
      for (const d of open) {
        if (!inScope(s, d, owner)) continue;
        const row = db.prepare('SELECT * FROM brock_relay_cards WHERE decision_id=?').get(d.id) as RelayRow | undefined;
        const raise = !row || row.version < d.version || (row.status === 'resolved' && row.resolution === 'unrelayed' && row.version === d.version);
        if (!raise) continue;
        db.prepare(`INSERT INTO brock_relay_cards(decision_id,version,status,test,raised_at) VALUES(?,?,'active',?,?)
          ON CONFLICT(decision_id) DO UPDATE SET version=excluded.version,status='active',test=excluded.test,resolution=NULL,answered_via=NULL,raised_at=excluded.raised_at,resolved_at=NULL`)
          .run(d.id, d.version, d.conversation_id === s.testChatId ? 1 : 0, now);
        enqueue('card.raised', d.id, d.version);
      }
    })();
  }

  function payloadFor(s: RelaySettings, e: OutboxRow): Record<string, unknown> | 'skip' {
    const row = db.prepare('SELECT * FROM brock_relay_cards WHERE decision_id=?').get(e.decision_id) as RelayRow | undefined;
    const base = { type: e.event_type, event_id: `veneer-brock-evt-${e.id}`, sent_at: new Date(deps.now()).toISOString(), test: Boolean(row?.test) };
    if (e.event_type === 'card.raised') {
      if (!row || row.status !== 'active' || row.version !== e.version) return 'skip';
      const d = db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(e.decision_id) as Decision | undefined;
      if (!d || d.version !== e.version) return 'skip';
      return { ...base, card: buildCard(db, d, s, deps.now()) };
    }
    const raised = db.prepare("SELECT status FROM brock_relay_outbox WHERE event_type='card.raised' AND decision_id=? AND version=? ORDER BY id DESC LIMIT 1").get(e.decision_id, e.version) as { status: string } | undefined;
    if (!raised || raised.status !== 'sent') return 'skip';
    const detail = JSON.parse(e.detail_json) as Record<string, unknown>;
    return {
      ...base, card_id: e.decision_id, version: e.version,
      resolution: detail.resolution, answered_via: detail.answered_via ?? null, answer: detail.answer ?? null,
      superseded_by_version: detail.superseded_by_version ?? null, detail: detail.detail ?? null,
      resolved_at: row?.resolved_at ?? e.created_at,
    };
  }

  async function post(s: RelaySettings, e: OutboxRow, payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    const response = await deps.fetch(s.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${s.secret}`,
        'x-veneer-signature': signBody(s.secret, body),
        'x-veneer-event': e.event_type,
        'x-veneer-event-id': `veneer-brock-evt-${e.id}`,
        'idempotency-key': `veneer-brock-evt-${e.id}`,
        'user-agent': 'veneer-brock-relay/1',
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.text()).split(s.secret).join('[REDACTED]').replace(/https?:\/\/\S+/g, '[url]').replace(/\s+/g, ' ').trim().slice(0, 200); } catch { /* unreadable */ }
      throw Object.assign(new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`), { status: response.status });
    }
    await response.body?.cancel().catch(() => {});
  }

  /** Send due events strictly in order; the first failure stops the pass so Brock never sees resolved before raised. */
  async function dispatch(s: RelaySettings) {
    for (let n = 0; n < 50; n++) {
      const e = db.prepare("SELECT * FROM brock_relay_outbox WHERE status='pending' ORDER BY id LIMIT 1").get() as OutboxRow | undefined;
      if (!e || Date.parse(e.next_attempt_at) > deps.now()) return;
      const payload = payloadFor(s, e);
      if (payload === 'skip') { db.prepare("UPDATE brock_relay_outbox SET status='skipped' WHERE id=?").run(e.id); continue; }
      const attempts = e.attempts + 1;
      const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
      db.prepare('UPDATE brock_relay_outbox SET attempts=?,next_attempt_at=? WHERE id=?').run(attempts, new Date(deps.now() + delay).toISOString(), e.id);
      try {
        await post(s, e, payload);
        db.prepare("UPDATE brock_relay_outbox SET status='sent',sent_at=?,last_error=NULL WHERE id=?").run(new Date(deps.now()).toISOString(), e.id);
        deps.log(`[brock-relay] sent ${e.event_type} event ${e.id} for card ${e.decision_id.slice(0, 8)} v${e.version}`);
      } catch (err) {
        const status = (err as { status?: number }).status;
        const message = status ? (err as Error).message : `${(err as Error).name}: ${String((err as { cause?: { code?: string } }).cause?.code ?? 'request failed')}`;
        const clientError = typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
        const dead = attempts >= (clientError ? MAX_CLIENT_ERROR_ATTEMPTS : MAX_ATTEMPTS);
        db.prepare('UPDATE brock_relay_outbox SET last_error=?,status=? WHERE id=?').run(message, dead ? 'dead' : 'pending', e.id);
        deps.log(`[brock-relay] ${e.event_type} event ${e.id} attempt ${attempts} failed (${status ? `HTTP ${status}` : 'network'})${dead ? '; gave up' : ''}`);
        if (!dead) return;
      }
    }
  }

  function prune() {
    db.prepare("DELETE FROM brock_relay_outbox WHERE status IN ('sent','skipped','dead') AND created_at < ?").run(new Date(deps.now() - 30 * 86_400_000).toISOString());
  }

  const card = (decisionId: string): RelayRow | undefined =>
    db.prepare('SELECT * FROM brock_relay_cards WHERE decision_id=?').get(decisionId) as RelayRow | undefined;

  return {
    settings,
    reconcile,
    dispatch,
    prune,
    /** One full pass: reconcile then send. Safe to call often. */
    async tick() {
      const s = settings();
      if (!s) return;
      reconcile(s);
      await dispatch(s);
    },
    card,
    activeCards(): RelayRow[] {
      return db.prepare("SELECT * FROM brock_relay_cards WHERE status='active' ORDER BY raised_at").all() as RelayRow[];
    },
    /** A file link stays valid while its card version is active, and briefly after it resolves. */
    fileAllowed(claims: FileClaims): boolean {
      const row = card(claims.d);
      if (!row || row.version !== claims.v) return false;
      if (row.status === 'active') return true;
      return Boolean(row.resolved_at && deps.now() - Date.parse(row.resolved_at) < FILE_GRACE_AFTER_RESOLVE_MS);
    },
    markAnsweredVia(decisionId: string, via: string) {
      db.prepare('UPDATE brock_relay_cards SET answered_via=? WHERE decision_id=?').run(via, decisionId);
    },
  };
}
export type BrockRelay = ReturnType<typeof createBrockRelay>;
