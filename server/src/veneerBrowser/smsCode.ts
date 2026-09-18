/**
 * Finds a *fresh* verification code in the local macOS Messages database so a
 * browser tool can type it into a login form.
 *
 * Privacy contract: this module only ever reads messages inside the caller's
 * time window (`maxAgeSeconds`), never the message history at large, and it
 * never logs, stores, or echoes message text — not even in error messages.
 * There are deliberately no `console.*` calls here.
 *
 * This is only ever wired up on the operator's own Mac; the caller applies that gate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { isMacOS } from '../platform.js';

type Db = InstanceType<typeof Database>;

/** Milliseconds between the Unix epoch and the Apple/CoreData epoch (2001-01-01). */
const APPLE_EPOCH_OFFSET_MS = 978_307_200_000;

/** `message.date` values above this are nanoseconds since 2001, below are seconds. */
const NANOSECOND_THRESHOLD = 1e12;

const DEFAULT_MAX_AGE_SECONDS = 300;
const DEFAULT_WAIT_SECONDS = 90;
const MAX_WAIT_SECONDS = 180;
const DEFAULT_POLL_MS = 3_000;

/** Cap the haystack so a pathological pattern cannot backtrack forever. */
const MAX_TEXT_LENGTH = 2_000;

/** Newest-first row cap; the window already bounds how much we can see. */
const ROW_LIMIT = 50;

/**
 * Matches "123-456", "123 456" and bare 4-8 digit runs, but not a digit run
 * that is part of a longer number (order/tracking IDs).
 */
export const DEFAULT_CODE_PATTERN = /(?<!\d)(\d{3}[-\s]\d{3}|\d{4,8})(?!\d)/;

export type SmsCodeErrorKind =
  | 'unavailable'
  | 'no_access'
  | 'not_found'
  | 'bad_pattern'
  | 'unsupported_platform';

export class SmsCodeError extends Error {
  readonly kind: SmsCodeErrorKind;

  constructor(kind: SmsCodeErrorKind, message: string) {
    super(message);
    this.name = 'SmsCodeError';
    this.kind = kind;
  }
}

export interface SmsCodeQuery {
  /** Phone number, short code, or iMessage email to require. Omit to accept any sender. */
  sender?: string;
  /** How far back a message may be and still count. Default 300. */
  maxAgeSeconds?: number;
  /** How long to keep polling for a new message. Default 90, clamped to [0, 180]. 0 = one query. */
  waitSeconds?: number;
  /** Regex source overriding the default code shape. */
  pattern?: string;
  /** Default `~/Library/Messages/chat.db`. */
  dbPath?: string;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Poll interval while waiting. Default 3000. */
  pollMs?: number;
}

export interface SmsCodeMatch {
  code: string;
  sender: string;
  messageAgeSeconds: number;
}

interface MessageRow {
  id: number;
  date: number;
  text: string | null;
  body: Buffer | null;
  handleId: number | null;
  handle: string | null;
}

/**
 * Only rows newer than the cutoff are ever selected — this WHERE clause is the
 * privacy boundary, not a performance tweak, so do not widen it.
 */
const SELECT_RECENT_SQL = `
  SELECT m.ROWID AS id, m.date AS date, m.text AS text, m.attributedBody AS body,
         m.handle_id AS handleId, h.id AS handle
  FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.is_from_me = 0 AND m.date > ?
  ORDER BY m.date DESC
  LIMIT ${ROW_LIMIT}
`;

/** Group chats and some SMS relays leave `handle_id` at 0; the chat join still knows who sent it. */
const SELECT_CHAT_HANDLE_SQL = `
  SELECT h.id AS handle
  FROM chat_message_join cmj
  JOIN chat_handle_join chj ON chj.chat_id = cmj.chat_id
  JOIN handle h ON h.ROWID = chj.handle_id
  WHERE cmj.message_id = ?
  LIMIT 1
`;

// Messages lives in the login user's home. The runner may run with HOME
// pointed at a separate service home (VP_SERVICE_HOME), so os.homedir() is
// not enough; the passwd entry for the uid is the reliable source.
export function messagesDbCandidates(): string[] {
  const homes: string[] = [];
  try {
    homes.push(os.userInfo().homedir);
  } catch {
    // No passwd entry (rare); fall through to HOME.
  }
  homes.push(os.homedir());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const home of homes) {
    if (!home || seen.has(home)) continue;
    seen.add(home);
    out.push(path.join(home, 'Library', 'Messages', 'chat.db'));
  }
  return out;
}

export function defaultMessagesDbPath(): string {
  const candidates = messagesDbCandidates();
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0] ?? path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
}

export function normalizeDigits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

/** Apple stores `message.date` as seconds (old) or nanoseconds (modern) since 2001-01-01. */
export function appleDateToMs(raw: number | bigint): number {
  const value = typeof raw === 'bigint' ? Number(raw) : raw;
  if (!Number.isFinite(value)) return Number.NaN;
  const ms = Math.abs(value) > NANOSECOND_THRESHOLD ? value / 1e6 : value * 1000;
  return Math.round(ms + APPLE_EPOCH_OFFSET_MS);
}

/**
 * Unix ms -> Apple nanoseconds. The result exceeds Number.MAX_SAFE_INTEGER, so
 * it is only exact to ~128ns; that is far finer than the second-level cutoffs
 * this is used for, and better-sqlite3 binds the integer-valued double fine.
 */
export function msToAppleDate(ms: number): number {
  return (ms - APPLE_EPOCH_OFFSET_MS) * 1e6;
}

/** Same conversion for the legacy seconds-based column format. */
export function msToAppleSeconds(ms: number): number {
  return Math.round((ms - APPLE_EPOCH_OFFSET_MS) / 1000);
}

const NS_STRING_TAG = Buffer.from('NSString', 'latin1');
/** typedstream preamble that immediately precedes the string's length prefix. */
const NS_STRING_MARKER = Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]);

/**
 * Modern Messages rows leave `text` NULL and keep the body in an archived
 * NSAttributedString. We only pull the plain string out rather than parsing
 * the whole typedstream, and bail out (null) on anything unexpected.
 */
export function decodeAttributedBody(buf: Buffer): string | null {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  const tagAt = buf.indexOf(NS_STRING_TAG);
  if (tagAt < 0) return null;
  const markerAt = buf.indexOf(NS_STRING_MARKER, tagAt + NS_STRING_TAG.length);
  if (markerAt < 0) return null;

  let at = markerAt + NS_STRING_MARKER.length;
  const prefix = buf[at];
  if (prefix === undefined) return null;
  at += 1;

  let length: number;
  if (prefix < 0x80) {
    length = prefix;
  } else if (prefix === 0x81) {
    if (at + 2 > buf.length) return null;
    length = buf.readUInt16LE(at);
    at += 2;
  } else if (prefix === 0x82) {
    if (at + 4 > buf.length) return null;
    length = buf.readUInt32LE(at);
    at += 4;
  } else {
    return null;
  }

  if (length <= 0 || at + length > buf.length) return null;
  return buf.toString('utf8', at, at + length);
}

function compilePattern(pattern?: string): RegExp {
  if (!pattern) return DEFAULT_CODE_PATTERN;
  try {
    return new RegExp(pattern);
  } catch {
    throw new SmsCodeError('bad_pattern', `Invalid code pattern: ${pattern}`);
  }
}

/** Where a pattern matched, before the digits-only normalization is applied. */
interface PatternHit {
  index: number;
  raw: string;
}

/**
 * First match per text, in order. Kept tiny and shared because the worker below
 * has to run the identical loop on the other side of a string boundary — change
 * one and you must change the other.
 */
function matchTexts(regex: RegExp, texts: string[]): PatternHit[] {
  const hits: PatternHit[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    const match = regex.exec(texts[index] ?? '');
    if (!match) continue;
    const raw = (match[1] ?? match[0]).trim();
    if (raw) hits.push({ index, raw });
  }
  return hits;
}

/**
 * With the default pattern the result is always digits ("123-456" -> "123456").
 * A caller override keeps its capture verbatim unless it is purely digits and
 * separators, so an alphanumeric override still works.
 */
function normalizeMatch(raw: string, custom: boolean): string | null {
  if (!custom || /^[\d\s-]+$/.test(raw)) return normalizeDigits(raw) || null;
  return raw;
}

/**
 * How long a caller-supplied pattern may run before it is killed. Generous for
 * any sane regex over 50 texts of 2000 characters, and far short of the poll.
 */
const PATTERN_TIMEOUT_MS = 1_000;

/**
 * A caller-supplied regex is attacker-shaped input.
 *
 * `(a+)+$` against 2000 a's followed by a b backtracks for longer than the
 * universe has left, and V8 offers no way to interrupt a regex once it has
 * entered one — a timer never fires, because the event loop never gets a turn.
 * On this runner that is not a slow tool call, it is the whole process wedged:
 * every chat's agent, every browser command, the IPC server.
 *
 * So a custom pattern never runs on this thread. It runs in a worker that is
 * terminated after PATTERN_TIMEOUT_MS, which is the only thing that actually
 * stops a regex mid-backtrack. The default pattern is ours, is linear, and
 * stays inline.
 */
const PATTERN_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const regex = new RegExp(workerData.pattern);
const hits = [];
for (let index = 0; index < workerData.texts.length; index += 1) {
  const match = regex.exec(workerData.texts[index] ?? '');
  if (!match) continue;
  const raw = (match[1] ?? match[0]).trim();
  if (raw) hits.push({ index, raw });
}
parentPort.postMessage(hits);
`;

const PATTERN_TOO_SLOW = 'pattern took too long';

async function matchTextsInWorker(pattern: string, texts: string[]): Promise<PatternHit[]> {
  const worker = new Worker(PATTERN_WORKER, { eval: true, workerData: { pattern, texts } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<PatternHit[]>((resolve, reject) => {
      timer = setTimeout(() => reject(new SmsCodeError('bad_pattern', PATTERN_TOO_SLOW)), PATTERN_TIMEOUT_MS);
      worker.once('message', (hits: PatternHit[]) => resolve(Array.isArray(hits) ? hits : []));
      // The pattern is validated on this thread first, so an error here is the
      // worker itself failing; it still must not take the runner down.
      worker.once('error', () => reject(new SmsCodeError('bad_pattern', `Invalid code pattern: ${pattern}`)));
      worker.once('exit', (code) => {
        if (code !== 0) reject(new SmsCodeError('bad_pattern', PATTERN_TOO_SLOW));
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    // Unconditional: on the timeout path this is what interrupts the regex, and
    // on the happy path it releases the thread instead of leaking one per poll.
    await worker.terminate();
  }
}

/** One extracted code and the index of the text it came from. */
export interface CodeHit {
  index: number;
  code: string;
}

/**
 * First code per text, in order, with the same worker isolation findSmsCode
 * applies to a caller-supplied pattern. Shared with emailCode.ts so both
 * channels extract codes identically; `texts` must already be capped by the
 * caller (see MAX_CODE_TEXT_LENGTH).
 */
export async function matchCodeTexts(texts: string[], pattern?: string): Promise<CodeHit[]> {
  compilePattern(pattern);
  const hits = pattern ? await matchTextsInWorker(pattern, texts) : matchTexts(DEFAULT_CODE_PATTERN, texts);
  const out: CodeHit[] = [];
  for (const hit of hits) {
    const code = normalizeMatch(hit.raw, Boolean(pattern));
    if (code) out.push({ index: hit.index, code });
  }
  return out;
}

/** Haystack cap shared with the email reader. */
export const MAX_CODE_TEXT_LENGTH = MAX_TEXT_LENGTH;

/**
 * Returns the first code-shaped run in `text`, or null.
 *
 * Exported for the unit tests and for callers with a trusted pattern: it runs
 * the regex inline. findSmsCode deliberately does NOT use it for a
 * caller-supplied pattern — see matchTextsInWorker.
 */
export function extractCode(text: string, pattern?: string): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const hit = matchTexts(compilePattern(pattern), [text.slice(0, MAX_TEXT_LENGTH)])[0];
  return hit ? normalizeMatch(hit.raw, Boolean(pattern)) : null;
}

/**
 * Compares a Messages handle against a caller-supplied sender. Short codes must
 * match exactly; phone numbers match when one ends with the other, so
 * "+15551234567" and "5551234567" are the same sender.
 */
export function senderMatches(handleId: string | null | undefined, sender?: string | null): boolean {
  const wanted = (sender ?? '').trim();
  if (!wanted) return true;
  const handle = (handleId ?? '').trim();
  if (!handle) return false;

  // iMessage email handles are compared as raw strings, case-insensitively.
  if (handle.includes('@') || wanted.includes('@')) {
    return handle.toLowerCase() === wanted.toLowerCase();
  }

  const handleDigits = normalizeDigits(handle);
  const wantedDigits = normalizeDigits(wanted);
  if (!handleDigits || !wantedDigits) return handle.toLowerCase() === wanted.toLowerCase();
  if (handleDigits.length <= 6 || wantedDigits.length <= 6) return handleDigits === wantedDigits;
  return handleDigits.endsWith(wantedDigits) || wantedDigits.endsWith(handleDigits);
}

function realNodePath(): string {
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

function looksLikeAccessDenial(err: unknown): boolean {
  const code = String((err as { code?: unknown } | null)?.code ?? '');
  const message = String((err as { message?: unknown } | null)?.message ?? '');
  if (code === 'EPERM' || code === 'EACCES' || code === 'SQLITE_AUTH') return true;
  if (code.startsWith('SQLITE_CANTOPEN')) return true;
  if (/authorization denied/i.test(message)) return true;
  if (/unable to open database file/i.test(message)) return true;
  // A readonly open of a WAL database also needs the -wal/-shm siblings.
  if (code === 'ENOENT' && /-shm|-wal/.test(message)) return true;
  return false;
}

function toSmsCodeError(err: unknown, dbPath: string): SmsCodeError {
  if (err instanceof SmsCodeError) return err;
  if (!looksLikeAccessDenial(err)) {
    const code = String((err as { code?: unknown } | null)?.code ?? 'unknown');
    return new SmsCodeError('unavailable', `Could not read the Messages database at ${dbPath} (${code}).`);
  }
  return new SmsCodeError(
    'no_access',
    `Cannot read the Messages database at ${dbPath}. Grant Full Disk Access to the Node binary at ` +
      `${realNodePath()}: System Settings > Privacy & Security > Full Disk Access, add that binary, ` +
      `then restart the Veneer runner. Note the path changes whenever Homebrew upgrades node, so the ` +
      `grant has to be re-applied after a node upgrade.`,
  );
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

/** True when the database still uses the legacy seconds-based `date` column. */
function usesSecondsDates(db: Db): boolean {
  const row = db.prepare('SELECT date AS date FROM message ORDER BY ROWID DESC LIMIT 1').get() as
    | { date: number | null }
    | undefined;
  const date = row?.date;
  return typeof date === 'number' && date > 0 && date < NANOSECOND_THRESHOLD;
}

export async function findSmsCode(query: SmsCodeQuery = {}): Promise<SmsCodeMatch> {
  if (!isMacOS()) {
    throw new SmsCodeError(
      'unsupported_platform',
      'Reading SMS codes needs the macOS Messages database; this host is not macOS.',
    );
  }

  // Fail fast on a bad pattern before touching the database at all.
  compilePattern(query.pattern);

  const now = query.now ?? Date.now;
  const maxAgeSeconds = positiveOr(query.maxAgeSeconds, DEFAULT_MAX_AGE_SECONDS);
  const waitSeconds = Math.min(positiveOr(query.waitSeconds, DEFAULT_WAIT_SECONDS), MAX_WAIT_SECONDS);
  const pollMs = Math.max(1, positiveOr(query.pollMs, DEFAULT_POLL_MS));
  const dbPath = query.dbPath ?? defaultMessagesDbPath();
  const wantedSender = (query.sender ?? '').trim();

  const startedAt = now();
  // The window is pinned at call start so a long wait cannot widen it.
  const cutoffMs = startedAt - maxAgeSeconds * 1000;

  if (!fs.existsSync(dbPath)) {
    const tried = query.dbPath ? [dbPath] : messagesDbCandidates();
    throw new SmsCodeError('unavailable', `No Messages database at ${tried.join(' or ')}.`);
  }

  let db: Db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw toSmsCodeError(err, dbPath);
  }

  try {
    const selectRecent = db.prepare(SELECT_RECENT_SQL);
    const selectChatHandle = db.prepare(SELECT_CHAT_HANDLE_SQL);

    // Assume the modern nanosecond column; fall back to seconds only if an
    // empty result suggests we compared against the wrong unit.
    let cutoff = msToAppleDate(cutoffMs);
    let unitChecked = false;

    for (;;) {
      // `rows` is scoped to this iteration so no message ever outlives a poll.
      let rows = selectRecent.all(cutoff) as MessageRow[];
      if (rows.length === 0 && !unitChecked) {
        unitChecked = true;
        if (usesSecondsDates(db)) {
          cutoff = msToAppleSeconds(cutoffMs);
          rows = selectRecent.all(cutoff) as MessageRow[];
        }
      }

      // Scoped to this iteration for the same reason `rows` is: no message text
      // outlives the poll that read it. Each is capped so a pattern cannot be
      // handed an unbounded haystack.
      const candidates: { sender: string; text: string; date: number }[] = [];
      for (const row of rows) {
        let sender = (row.handle ?? '').trim();
        if (!sender) {
          const viaChat = selectChatHandle.get(row.id) as { handle?: string | null } | undefined;
          sender = (viaChat?.handle ?? '').trim();
        }
        if (wantedSender && !senderMatches(sender, wantedSender)) continue;

        const text = row.text && row.text.trim() ? row.text : row.body ? decodeAttributedBody(row.body) : null;
        if (!text) continue;
        candidates.push({ sender, text: text.slice(0, MAX_TEXT_LENGTH), date: row.date });
      }

      const texts = candidates.map((candidate) => candidate.text);
      // One worker per poll, covering every candidate at once.
      const hits = query.pattern
        ? await matchTextsInWorker(query.pattern, texts)
        : matchTexts(DEFAULT_CODE_PATTERN, texts);

      for (const hit of hits) {
        const candidate = candidates[hit.index];
        if (!candidate) continue;
        const code = normalizeMatch(hit.raw, Boolean(query.pattern));
        if (!code) continue;
        const messageMs = appleDateToMs(candidate.date);
        return {
          code,
          sender: candidate.sender,
          messageAgeSeconds: Math.max(0, Math.round((now() - messageMs) / 1000)),
        };
      }

      if (now() - startedAt >= waitSeconds * 1000) break;
      await sleep(pollMs);
    }
  } catch (err) {
    throw toSmsCodeError(err, dbPath);
  } finally {
    try {
      db.close();
    } catch {
      // A failed close is not worth masking the real outcome.
    }
  }

  throw new SmsCodeError(
    'not_found',
    `No matching code from ${wantedSender || 'any sender'} in the last ${maxAgeSeconds} s ` +
      `after waiting ${waitSeconds} s.`,
  );
}
