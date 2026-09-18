/**
 * Finds a *fresh* verification code in ONE configured mailbox so a browser
 * tool can type it into a login form — the email twin of smsCode.ts.
 *
 * Privacy contract: the mailbox is fixed by configuration, never chosen by the
 * agent; only messages inside the caller's time window are ever looked at;
 * and nothing derived from a message — body, snippet, headers beyond the
 * sender and subject that the agent already asked for — is logged, stored, or
 * put in an error. There are deliberately no `console.*` calls here.
 *
 * The messages come from the already-authenticated Composio Gmail connector,
 * executed server-side with the session the install stored. The Composio key
 * and the session id stay in this process; the agent gets nothing back but the
 * shape of what happened (see secretFill.ts).
 */
import type Database from 'better-sqlite3';
import { slugifyLabel, type ComposioInstallConfig } from '../connectors/catalog.js';
import type { UserConnectorRow } from '../db/db.js';
import { MAX_CODE_TEXT_LENGTH, matchCodeTexts } from './smsCode.js';

const DEFAULT_MAX_AGE_SECONDS = 600;
const DEFAULT_WAIT_SECONDS = 90;
export const MAX_EMAIL_WAIT_SECONDS = 180;
const DEFAULT_POLL_MS = 5_000;

/** Newest-first fetch cap; the window already bounds how much we can see. */
const FETCH_LIMIT = 10;

/** How far past its own window a consumed message id is remembered. */
const CONSUMED_GRACE_MS = 60_000;

export type EmailCodeErrorKind = 'unavailable' | 'no_access' | 'not_found' | 'bad_pattern' | 'bad_filter';

export class EmailCodeError extends Error {
  readonly kind: EmailCodeErrorKind;

  constructor(kind: EmailCodeErrorKind, message: string) {
    super(message);
    this.name = 'EmailCodeError';
    this.kind = kind;
  }
}

/** One message as the source hands it over. Never leaves this module except as `EmailCodeMatch`. */
export interface EmailMessage {
  id: string;
  threadId: string | null;
  /** Bare address when the source can give one; otherwise the raw From header. */
  sender: string;
  subject: string;
  receivedAtMs: number;
  /** Plain text to scan for the code: body, or a snippet when that is all there is. */
  text: string;
}

export interface EmailFetchQuery {
  /** Only messages received at or after this instant matter. */
  sinceMs: number;
  /** Address or domain filter the source may push down; the reader re-checks it. */
  sender?: string;
  limit: number;
}

/**
 * Where the messages come from. One instance per process, bound to the
 * configured mailbox; `fetchRecent` is the only thing that touches the network.
 */
export interface EmailCodeSource {
  /** The configured mailbox address; the agent cannot pick another. */
  readonly mailbox: string;
  /** Default sender allowlist (addresses or domains); empty accepts any sender. */
  readonly senders: readonly string[];
  fetchRecent(query: EmailFetchQuery): Promise<EmailMessage[]>;
}

export interface EmailCodeQuery {
  /** Chat the code is being filled for; scopes the replay memory. */
  conversationId: string;
  /** Sender address or domain to require. Falls back to the source allowlist. */
  sender?: string;
  /** Case-insensitive substring the subject must contain. */
  subject?: string;
  /** Gmail thread id the message must belong to. */
  threadId?: string;
  /** How far back a message may be and still count. Default 600. */
  maxAgeSeconds?: number;
  /** How long to keep polling for a new message. Default 90, clamped to [0, 180]. 0 = one query. */
  waitSeconds?: number;
  /** Regex source overriding the default code shape. */
  pattern?: string;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Poll interval while waiting. Default 5000. */
  pollMs?: number;
}

export interface EmailCodeMatch {
  code: string;
  sender: string;
  subject: string;
  messageId: string;
  messageAgeSeconds: number;
}

// ---------------------------------------------------------------------------
// Replay memory.
//
// A code that has been typed once must not be typed again from the same
// message: a second fill_email_code call inside the window would otherwise
// happily re-fill a code the site already rejected or consumed. Keyed per chat
// and expiring with the window, so it never grows past what one login needs.
// ---------------------------------------------------------------------------

const consumed = new Map<string, Map<string, number>>();

function pruneConsumed(conversationId: string, nowMs: number): Map<string, number> {
  const ids = consumed.get(conversationId) ?? new Map<string, number>();
  for (const [id, expiresAt] of ids) {
    if (expiresAt <= nowMs) ids.delete(id);
  }
  if (ids.size) consumed.set(conversationId, ids);
  else consumed.delete(conversationId);
  return ids;
}

function rememberConsumed(conversationId: string, messageId: string, expiresAtMs: number): void {
  const ids = consumed.get(conversationId) ?? new Map<string, number>();
  ids.set(messageId, expiresAtMs);
  consumed.set(conversationId, ids);
}

/** Test hook; production never needs it because entries expire on their own. */
export function clearConsumedEmailCodes(conversationId?: string): void {
  if (conversationId === undefined) consumed.clear();
  else consumed.delete(conversationId);
}

// ---------------------------------------------------------------------------
// Filters.
// ---------------------------------------------------------------------------

/** "Help Desk <help@example.com>" -> "help@example.com"; a bare address passes through. */
export function senderAddress(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  const angled = /<([^<>]+)>\s*$/.exec(value);
  return (angled ? angled[1]! : value).trim().toLowerCase();
}

/**
 * An allowlist entry is either a full address ("noreply@shipsurance.com") or a
 * domain ("shipsurance.com"), which also covers its subdomains.
 */
export function senderAllowed(sender: string, allowlist: readonly string[]): boolean {
  const entries = allowlist.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!entries.length) return true;
  const address = senderAddress(sender);
  if (!address) return false;
  const domain = address.includes('@') ? address.slice(address.lastIndexOf('@') + 1) : address;
  return entries.some((entry) => {
    if (entry.includes('@')) return address === entry;
    return domain === entry || domain.endsWith(`.${entry}`);
  });
}

function positiveOr(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Sender and subject filters are ordinary strings; cap them so a query can never become a payload. */
function filterText(value: string | undefined, label: string): string | undefined {
  const text = (value ?? '').trim();
  if (!text) return undefined;
  if (text.length > 200) throw new EmailCodeError('bad_filter', `${label} must be 200 characters or fewer.`);
  return text;
}

export async function findEmailCode(source: EmailCodeSource, query: EmailCodeQuery): Promise<EmailCodeMatch> {
  // Fail fast on a bad pattern before touching the mailbox at all.
  try {
    await matchCodeTexts([], query.pattern);
  } catch {
    throw new EmailCodeError('bad_pattern', `Invalid code pattern: ${query.pattern}`);
  }
  const wantedSender = filterText(query.sender, 'sender');
  const wantedSubject = filterText(query.subject, 'subject')?.toLowerCase();
  const wantedThread = filterText(query.threadId, 'thread_id');
  // The agent's sender narrows the configured allowlist; it can never widen it.
  if (wantedSender && !senderAllowed(wantedSender, source.senders)) {
    throw new EmailCodeError(
      'bad_filter',
      `Sender ${wantedSender} is outside the configured allowlist for ${source.mailbox}.`,
    );
  }

  const now = query.now ?? Date.now;
  const maxAgeSeconds = positiveOr(query.maxAgeSeconds, DEFAULT_MAX_AGE_SECONDS);
  const waitSeconds = Math.min(positiveOr(query.waitSeconds, DEFAULT_WAIT_SECONDS), MAX_EMAIL_WAIT_SECONDS);
  const pollMs = Math.max(1, positiveOr(query.pollMs, DEFAULT_POLL_MS));

  const startedAt = now();
  // The window is pinned at call start so a long wait cannot widen it.
  const cutoffMs = startedAt - maxAgeSeconds * 1000;

  for (;;) {
    let messages: EmailMessage[];
    try {
      messages = await source.fetchRecent({
        sinceMs: cutoffMs,
        ...(wantedSender ? { sender: wantedSender } : {}),
        limit: FETCH_LIMIT,
      });
    } catch (error) {
      throw toEmailCodeError(error, source.mailbox);
    }
    const nowMs = now();
    const used = pruneConsumed(query.conversationId, nowMs);

    // Scoped to this iteration: no message outlives the poll that read it.
    const candidates = messages
      .filter((message) => message.receivedAtMs >= cutoffMs)
      .filter((message) => !used.has(message.id))
      .filter((message) => senderAllowed(message.sender, wantedSender ? [wantedSender] : source.senders))
      .filter((message) => !wantedSubject || message.subject.toLowerCase().includes(wantedSubject))
      .filter((message) => !wantedThread || message.threadId === wantedThread)
      .sort((a, b) => b.receivedAtMs - a.receivedAtMs);

    const texts = candidates.map((message) => `${message.subject}\n${message.text}`.slice(0, MAX_CODE_TEXT_LENGTH));
    let hits;
    try {
      hits = await matchCodeTexts(texts, query.pattern);
    } catch {
      throw new EmailCodeError('bad_pattern', 'The code pattern took too long or is invalid.');
    }
    const hit = hits[0];
    if (hit) {
      const message = candidates[hit.index]!;
      rememberConsumed(query.conversationId, message.id, nowMs + maxAgeSeconds * 1000 + CONSUMED_GRACE_MS);
      return {
        code: hit.code,
        sender: senderAddress(message.sender) || message.sender,
        subject: message.subject.slice(0, 200),
        messageId: message.id,
        messageAgeSeconds: Math.max(0, Math.round((nowMs - message.receivedAtMs) / 1000)),
      };
    }

    if (now() - startedAt >= waitSeconds * 1000) break;
    await sleep(pollMs);
  }

  throw new EmailCodeError(
    'not_found',
    `No unused code from ${wantedSender ?? (source.senders.length ? source.senders.join(', ') : 'any sender')} ` +
      `in ${source.mailbox} in the last ${maxAgeSeconds} s after waiting ${waitSeconds} s.`,
  );
}

/**
 * Only the failure *kind* is kept from a source error. A Composio or HTTP error
 * may quote the request or a response body, so its text is never forwarded.
 */
function toEmailCodeError(error: unknown, mailbox: string): EmailCodeError {
  if (error instanceof EmailCodeError) return error;
  const message = String((error as Error)?.message ?? '');
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|expired|revoked|reconnect/i.test(message)) {
    return new EmailCodeError(
      'no_access',
      `The ${mailbox} connection refused the read. Reconnect the Gmail connector on the Connectors page and try again.`,
    );
  }
  return new EmailCodeError('unavailable', `The ${mailbox} mailbox could not be read right now.`);
}

// ---------------------------------------------------------------------------
// Composio-backed source.
// ---------------------------------------------------------------------------

export interface ComposioEmailCodeSourceOptions {
  db: Database.Database;
  mailbox: string;
  senders: readonly string[];
  /** Explicit user_connectors.id; otherwise the Gmail install labeled with the mailbox. */
  connectorId?: number | null;
  /** Read at call time; the key never lives on this object. */
  composioApiKey: () => string | null;
  /** Injectable executor, for tests. Defaults to the Composio SDK session. */
  execute?: (apiKey: string, sessionId: string, slug: string, args: Record<string, unknown>) => Promise<{
    data?: unknown;
    error?: unknown;
    successful?: boolean;
  }>;
}

/**
 * The connected Gmail install that IS the configured mailbox: slug gmail,
 * label equal to the mailbox, shared with everyone. Fails closed on zero or
 * more than one match so the tool can never drift to a personal install or a
 * look-alike label. An explicit connector id must still satisfy the same rule.
 */
export function findMailboxConnector(
  db: Database.Database,
  mailbox: string,
  connectorId?: number | null,
): UserConnectorRow {
  const wanted = slugifyLabel(mailbox);
  const rows = (db.prepare(
    "SELECT * FROM user_connectors WHERE connector_slug = 'gmail' AND status = 'connected' AND sharing = 'shared' ORDER BY id",
  ).all() as UserConnectorRow[])
    .filter((row) => row.label && slugifyLabel(row.label) === wanted)
    .filter((row) => !connectorId || row.id === connectorId);
  if (rows.length !== 1) {
    throw new EmailCodeError(
      'unavailable',
      rows.length === 0
        ? `No connected, shared Gmail connector is labeled ${mailbox}. Connect it on the Connectors page.`
        : `${rows.length} shared Gmail connectors are labeled ${mailbox}; set VP_EMAIL_CODE_CONNECTOR_ID to pick one.`,
    );
  }
  return rows[0]!;
}

async function executeWithSdk(
  apiKey: string,
  sessionId: string,
  slug: string,
  args: Record<string, unknown>,
): Promise<{ data?: unknown; error?: unknown; successful?: boolean }> {
  const { Composio } = await import('@composio/core');
  const session = await new Composio({ apiKey, allowTracking: false }).sessions.use(sessionId);
  return session.execute(slug, args);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function timestampMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e11 ? value : value * 1000;
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  if (/^\d+$/.test(value.trim())) return timestampMs(Number(value));
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Normalizes one GMAIL_FETCH_EMAILS item. The field names are Composio's;
 * every alternative spelling seen in its responses is accepted, and a message
 * without an id or a timestamp is dropped rather than guessed at.
 */
export function parseGmailMessage(value: unknown): EmailMessage | null {
  const item = record(value);
  if (!item) return null;
  const id = text(item.messageId) || text(item.id);
  const receivedAtMs = timestampMs(item.messageTimestamp ?? item.internalDate ?? item.date);
  if (!id || !Number.isFinite(receivedAtMs)) return null;
  const preview = record(item.preview);
  const payload = record(item.payload);
  const headers = Array.isArray(payload?.headers) ? payload!.headers as unknown[] : [];
  const header = (name: string): string => {
    for (const entry of headers) {
      const h = record(entry);
      if (h && text(h.name).toLowerCase() === name) return text(h.value);
    }
    return '';
  };
  const body = text(item.messageText) || text(item.snippet) || text(preview?.body);
  return {
    id,
    threadId: text(item.threadId) || null,
    sender: text(item.sender) || text(item.from) || header('from'),
    subject: text(item.subject) || text(preview?.subject) || header('subject'),
    receivedAtMs,
    text: body,
  };
}

/** Gmail's search syntax: `after:` takes epoch seconds; `from:` accepts an address or a domain. */
export function gmailQuery(query: EmailFetchQuery): string {
  const parts = [`after:${Math.max(0, Math.floor(query.sinceMs / 1000) - 60)}`, '-in:sent', '-in:drafts'];
  if (query.sender) parts.push(`from:${query.sender.replace(/[\s"()]/g, '')}`);
  return parts.join(' ');
}

export function createComposioEmailCodeSource(options: ComposioEmailCodeSourceOptions): EmailCodeSource {
  const execute = options.execute ?? executeWithSdk;
  return {
    mailbox: options.mailbox,
    senders: [...options.senders],
    async fetchRecent(query: EmailFetchQuery): Promise<EmailMessage[]> {
      const row = findMailboxConnector(options.db, options.mailbox, options.connectorId);
      let sessionId = '';
      try {
        sessionId = text((JSON.parse(row.config_json) as Partial<ComposioInstallConfig>).sessionId);
      } catch {
        sessionId = '';
      }
      if (!sessionId) {
        throw new EmailCodeError('no_access', `The ${options.mailbox} Gmail connector must be reconnected.`);
      }
      const apiKey = options.composioApiKey();
      if (!apiKey) throw new EmailCodeError('unavailable', 'Composio is not configured on this instance.');
      const result = await execute(apiKey, sessionId, 'GMAIL_FETCH_EMAILS', {
        query: gmailQuery(query),
        max_results: Math.max(1, Math.min(50, query.limit)),
        include_payload: true,
        verbose: true,
        user_id: 'me',
      });
      if (result.error || result.successful === false) {
        // The SDK error text may quote the request; only its kind survives.
        throw new Error(typeof result.error === 'string' ? result.error : 'fetch failed');
      }
      const data = record(result.data);
      const list = Array.isArray(data?.messages) ? data!.messages as unknown[] : Array.isArray(data?.data) ? data!.data as unknown[] : [];
      const messages: EmailMessage[] = [];
      for (const item of list) {
        const parsed = parseGmailMessage(item);
        if (parsed) messages.push(parsed);
      }
      return messages;
    },
  };
}
