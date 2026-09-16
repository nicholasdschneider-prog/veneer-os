import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appleDateToMs,
  decodeAttributedBody,
  defaultMessagesDbPath,
  messagesDbCandidates,
  extractCode,
  findSmsCode,
  msToAppleDate,
  msToAppleSeconds,
  normalizeDigits,
  senderMatches,
  SmsCodeError,
} from '../src/veneerBrowser/smsCode.js';

const IS_MAC = process.platform === 'darwin';

/** Fixed clock so message ages in the assertions are exact. */
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const now = () => NOW;

type LengthForm = 'short' | 'u16' | 'u32';

/**
 * Builds a buffer shaped like the archived NSAttributedString that Messages
 * stores in `attributedBody`: enough typedstream scaffolding to be realistic,
 * then the NSString tag, the marker, a length prefix and UTF-8 bytes.
 */
function buildAttributedBody(text: string, form: LengthForm = 'short'): Buffer {
  const payload = Buffer.from(text, 'utf8');
  let prefix: Buffer;
  if (form === 'short') {
    prefix = Buffer.from([payload.length]);
  } else if (form === 'u16') {
    prefix = Buffer.alloc(3);
    prefix[0] = 0x81;
    prefix.writeUInt16LE(payload.length, 1);
  } else {
    prefix = Buffer.alloc(5);
    prefix[0] = 0x82;
    prefix.writeUInt32LE(payload.length, 1);
  }
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]),
    Buffer.from('streamtyped', 'latin1'),
    Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12]),
    Buffer.from('NSAttributedString', 'latin1'),
    Buffer.from([0x00, 0x84, 0x84, 0x08]),
    Buffer.from('NSObject', 'latin1'),
    Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84, 0x84, 0x12]),
    Buffer.from('NSString', 'latin1'),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    prefix,
    payload,
  ]);
}

interface TestDb {
  file: string;
  db: InstanceType<typeof Database>;
}

const openDbs: TestDb[] = [];
const tempDirs: string[] = [];

function makeDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-smscode-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'chat.db');
  const db = new Database(file);
  // The real chat.db is WAL; match it so the readonly reader exercises the
  // same -wal/-shm path and concurrent inserts are not blocked.
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      date INTEGER,
      text TEXT,
      attributedBody BLOB,
      handle_id INTEGER,
      is_from_me INTEGER
    );
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
  `);
  const entry = { file, db };
  openDbs.push(entry);
  return entry;
}

interface InsertOptions {
  id: number;
  secondsAgo: number;
  text?: string | null;
  body?: Buffer | null;
  handleRowId?: number;
  fromMe?: boolean;
  clock?: number;
  seconds?: boolean;
}

function insertMessage(db: InstanceType<typeof Database>, options: InsertOptions): void {
  const clock = options.clock ?? NOW;
  const ms = clock - options.secondsAgo * 1000;
  db.prepare(
    'INSERT INTO message (ROWID, date, text, attributedBody, handle_id, is_from_me) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    options.id,
    options.seconds ? msToAppleSeconds(ms) : msToAppleDate(ms),
    options.text ?? null,
    options.body ?? null,
    options.handleRowId ?? 0,
    options.fromMe ? 1 : 0,
  );
}

afterEach(() => {
  for (const entry of openDbs.splice(0)) {
    try {
      entry.db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('extractCode', () => {
  it('reads a hyphenated code as digits', () => {
    expect(extractCode('Your code is 123-456')).toBe('123456');
    expect(extractCode('Your code is 123 456')).toBe('123456');
  });

  it('reads a plain digit run', () => {
    expect(extractCode('Amazon: 483920 is your OTP')).toBe('483920');
  });

  it('returns null when there is no code', () => {
    expect(extractCode('Your package arrives tomorrow')).toBeNull();
    expect(extractCode('')).toBeNull();
  });

  it('ignores digit runs that are part of a longer number', () => {
    expect(extractCode('Order 12345678901 shipped')).toBeNull();
  });

  it('uses group 1 of an override pattern', () => {
    expect(extractCode('Use PIN 4821 now', 'PIN (\\d{4})')).toBe('4821');
    expect(extractCode('Code: A1B2C3 expires soon', 'Code: ([A-Z0-9]{6})')).toBe('A1B2C3');
  });

  it('uses the whole match when the override has no group', () => {
    expect(extractCode('token 9081 here', '\\d{4}')).toBe('9081');
  });

  it('rejects an invalid override pattern', () => {
    let caught: unknown;
    try {
      extractCode('anything', '([');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SmsCodeError);
    expect((caught as SmsCodeError).kind).toBe('bad_pattern');
  });

  it('caps the haystack it scans', () => {
    // The code sits past the 2000 char guard, so it is intentionally missed.
    expect(extractCode(`${'a'.repeat(2100)} 483920`)).toBeNull();
  });
});

describe('apple date conversion', () => {
  it('round-trips the nanosecond form', () => {
    const raw = msToAppleDate(NOW);
    expect(raw).toBeGreaterThan(1e12);
    expect(appleDateToMs(raw)).toBe(NOW);
  });

  it('round-trips the legacy seconds form', () => {
    const raw = msToAppleSeconds(NOW);
    expect(raw).toBeLessThan(1e12);
    expect(appleDateToMs(raw)).toBe(NOW);
  });

  it('treats 0 as the Apple epoch', () => {
    expect(appleDateToMs(0)).toBe(Date.UTC(2001, 0, 1));
  });
});

describe('decodeAttributedBody', () => {
  it('decodes the short length form', () => {
    expect(decodeAttributedBody(buildAttributedBody('Your code is 123-456'))).toBe('Your code is 123-456');
  });

  it('decodes the 0x81 u16 length form', () => {
    const text = `${'long message '.repeat(20)}code 483920`;
    expect(text.length).toBeGreaterThan(0x7f);
    expect(decodeAttributedBody(buildAttributedBody(text, 'u16'))).toBe(text);
  });

  it('decodes the 0x82 u32 length form', () => {
    expect(decodeAttributedBody(buildAttributedBody('code 483920', 'u32'))).toBe('code 483920');
  });

  it('returns null for a truncated buffer', () => {
    const full = buildAttributedBody('Your code is 123-456');
    expect(decodeAttributedBody(full.subarray(0, full.length - 5))).toBeNull();
    expect(decodeAttributedBody(full.subarray(0, 20))).toBeNull();
  });

  it('returns null when the structure is missing', () => {
    expect(decodeAttributedBody(Buffer.alloc(0))).toBeNull();
    expect(decodeAttributedBody(Buffer.from('not a typedstream at all'))).toBeNull();
  });
});

describe('senderMatches', () => {
  it('requires exact equality for short codes', () => {
    expect(senderMatches('262966', '262966')).toBe(true);
    expect(senderMatches('262966', '966')).toBe(false);
  });

  it('tolerates a country prefix on phone numbers', () => {
    expect(senderMatches('+15551234567', '5551234567')).toBe(true);
    expect(senderMatches('+15551234567', '+1 (555) 123-4567')).toBe(true);
    expect(senderMatches('+15551234567', '5559998888')).toBe(false);
  });

  it('compares email handles case-insensitively', () => {
    expect(senderMatches('Alerts@Example.COM', 'alerts@example.com')).toBe(true);
    expect(senderMatches('alerts@example.com', 'other@example.com')).toBe(false);
  });

  it('accepts any handle when no sender is requested', () => {
    expect(senderMatches('+15551234567')).toBe(true);
    expect(senderMatches(null, '')).toBe(true);
    expect(senderMatches(null, '+15551234567')).toBe(false);
  });

  it('normalizes digits', () => {
    expect(normalizeDigits('+1 (555) 123-4567')).toBe('15551234567');
    expect(normalizeDigits(null)).toBe('');
  });
});

describe.skipIf(!IS_MAC)('findSmsCode', () => {
  function seedTypicalInbox(db: InstanceType<typeof Database>): void {
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '+15551234567');
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(2, '262966');
    insertMessage(db, { id: 1, secondsAgo: 600, text: 'Stale code 111111', handleRowId: 1 });
    insertMessage(db, { id: 2, secondsAgo: 200, text: 'Your code is 123-456', handleRowId: 1 });
    insertMessage(db, { id: 3, secondsAgo: 100, text: 'See you tomorrow', handleRowId: 1 });
    insertMessage(db, { id: 4, secondsAgo: 50, text: 'I sent 999999', handleRowId: 1, fromMe: true });
    insertMessage(db, { id: 5, secondsAgo: 150, text: 'Amazon: 483920 is your OTP', handleRowId: 2 });
  }

  it('picks the newest in-window match and skips sent and stale rows', async () => {
    const { file, db } = makeDb();
    seedTypicalInbox(db);

    const match = await findSmsCode({ dbPath: file, now, waitSeconds: 0, maxAgeSeconds: 300 });
    expect(match).toEqual({ code: '483920', sender: '262966', messageAgeSeconds: 150 });
  });

  it('filters by sender', async () => {
    const { file, db } = makeDb();
    seedTypicalInbox(db);

    const match = await findSmsCode({
      dbPath: file,
      now,
      waitSeconds: 0,
      maxAgeSeconds: 300,
      sender: '555 123 4567',
    });
    expect(match).toEqual({ code: '123456', sender: '+15551234567', messageAgeSeconds: 200 });
  });

  it('resolves the sender through the chat joins when handle_id is 0', async () => {
    const { file, db } = makeDb();
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(7, '+15557654321');
    db.prepare('INSERT INTO chat (ROWID) VALUES (?)').run(3);
    insertMessage(db, { id: 11, secondsAgo: 30, text: 'Your code is 552-118', handleRowId: 0 });
    db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(3, 11);
    db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(3, 7);

    const match = await findSmsCode({
      dbPath: file,
      now,
      waitSeconds: 0,
      sender: '+1 555 765 4321',
    });
    expect(match).toEqual({ code: '552118', sender: '+15557654321', messageAgeSeconds: 30 });
  });

  it('falls back to attributedBody when text is NULL', async () => {
    const { file, db } = makeDb();
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '262966');
    insertMessage(db, {
      id: 21,
      secondsAgo: 42,
      text: null,
      body: buildAttributedBody('Your verification code is 908-273'),
      handleRowId: 1,
    });

    const match = await findSmsCode({ dbPath: file, now, waitSeconds: 0 });
    expect(match).toEqual({ code: '908273', sender: '262966', messageAgeSeconds: 42 });
  });

  it('reads a legacy seconds-format database', async () => {
    const { file, db } = makeDb();
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '262966');
    insertMessage(db, { id: 31, secondsAgo: 60, text: 'Code 771-903', handleRowId: 1, seconds: true });

    const match = await findSmsCode({ dbPath: file, now, waitSeconds: 0 });
    expect(match).toEqual({ code: '771903', sender: '262966', messageAgeSeconds: 60 });
  });

  it('reports not_found without leaking any message text', async () => {
    const { file, db } = makeDb();
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '+15551234567');
    insertMessage(db, { id: 41, secondsAgo: 10, text: 'Dinner at 7, ok? secret-topic', handleRowId: 1 });
    insertMessage(db, { id: 42, secondsAgo: 900, text: 'Old code 445-221', handleRowId: 1 });

    let caught: unknown;
    try {
      await findSmsCode({ dbPath: file, now, waitSeconds: 0, maxAgeSeconds: 300, sender: '262966' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SmsCodeError);
    const error = caught as SmsCodeError;
    expect(error.kind).toBe('not_found');
    expect(error.message).toContain('262966');
    expect(error.message).not.toContain('Dinner');
    expect(error.message).not.toContain('secret-topic');
    expect(error.message).not.toContain('445');
  });

  it('keeps polling and picks up a message that arrives after the first query', async () => {
    const { file, db } = makeDb();
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '262966');
    const clock = Date.now();

    const pending = findSmsCode({
      dbPath: file,
      waitSeconds: 1,
      pollMs: 10,
      maxAgeSeconds: 300,
      now: () => clock,
    });

    // Land the message only after the first poll has already come up empty.
    setTimeout(() => {
      insertMessage(db, { id: 51, secondsAgo: 0, text: 'Your code is 620-431', handleRowId: 1, clock });
    }, 60);

    await expect(pending).resolves.toEqual({ code: '620431', sender: '262966', messageAgeSeconds: 0 });
  });

  // A caller-supplied regex is the one piece of attacker-shaped input this
  // module takes. V8 cannot be interrupted mid-backtrack, so the only proof
  // that matters is wall-clock: the call must come back, not wedge the runner.
  it('kills a catastrophically backtracking caller pattern instead of wedging the runner', async () => {
    const { file, db } = makeDb();
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '262966');
    // The 'b' has to sit inside MAX_TEXT_LENGTH or the slice would drop it and
    // leave a string that (a+)+$ matches instantly.
    insertMessage(db, { id: 61, secondsAgo: 10, text: `${'a'.repeat(1999)}b`, handleRowId: 1 });

    const startedAt = Date.now();
    const error = await findSmsCode({
      dbPath: file, now, waitSeconds: 0, maxAgeSeconds: 300, pattern: '(a+)+$',
    }).then(() => null, (err: SmsCodeError) => err);
    expect(error).toBeInstanceOf(SmsCodeError);
    expect(error?.kind).toBe('bad_pattern');
    expect(error?.message).toBe('pattern took too long');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 10_000);

  it('still honours a well-behaved caller pattern', async () => {
    const { file, db } = makeDb();
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '262966');
    insertMessage(db, { id: 62, secondsAgo: 20, text: 'Your Acme token is ABC-7788', handleRowId: 1 });

    const match = await findSmsCode({
      dbPath: file, now, waitSeconds: 0, maxAgeSeconds: 300, pattern: '([A-Z]{3}-\\d{4})',
    });
    expect(match).toEqual({ code: 'ABC-7788', sender: '262966', messageAgeSeconds: 20 });
  });

  it('rejects an invalid pattern before opening the database', async () => {
    await expect(findSmsCode({ dbPath: '/nonexistent/chat.db', pattern: '([', waitSeconds: 0 })).rejects.toMatchObject(
      { kind: 'bad_pattern' },
    );
  });

  it('reports a missing database as unavailable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-smscode-missing-'));
    tempDirs.push(dir);
    await expect(findSmsCode({ dbPath: path.join(dir, 'chat.db'), waitSeconds: 0 })).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });
});

describe('platform gate', () => {
  it('refuses to run off macOS', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      await expect(findSmsCode({ waitSeconds: 0 })).rejects.toMatchObject({ kind: 'unsupported_platform' });
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});

/** True only when this process can actually open the real chat.db read-only. */
function liveDbReadable(): boolean {
  if (!IS_MAC) return false;
  try {
    const db = new Database(defaultMessagesDbPath(), { readonly: true, fileMustExist: true });
    db.prepare('SELECT 1 AS ok').get();
    db.close();
    return true;
  } catch {
    return false;
  }
}

const LIVE_DB_READABLE = liveDbReadable();

describe.skipIf(!LIVE_DB_READABLE)('live Messages database smoke test', () => {
  it('either finds a very recent code or reports not_found, never no_access', async () => {
    let kind: string | null = null;
    let gotCode = false;
    try {
      const match = await findSmsCode({ waitSeconds: 0, maxAgeSeconds: 1 });
      gotCode = typeof match.code === 'string' && match.code.length > 0;
    } catch (err) {
      expect(err).toBeInstanceOf(SmsCodeError);
      kind = (err as SmsCodeError).kind;
    }
    // Deliberately asserts nothing about the code itself.
    expect(gotCode || kind === 'not_found').toBe(true);
  });
});

describe('defaultMessagesDbPath', () => {
  it('points at the login home even when HOME is a service home', () => {
    const savedHome = process.env.HOME;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-service-home-'));
    try {
      const loginHome = os.userInfo().homedir;
      const candidates = messagesDbCandidates();
      expect(candidates[0]).toBe(path.join(loginHome, 'Library', 'Messages', 'chat.db'));
      expect(candidates).toContain(path.join(process.env.HOME, 'Library', 'Messages', 'chat.db'));
      expect(defaultMessagesDbPath().startsWith(loginHome) || defaultMessagesDbPath().startsWith(process.env.HOME)).toBe(true);
      // The login home wins whenever its database exists (the normal Mac case).
      if (fs.existsSync(candidates[0])) expect(defaultMessagesDbPath()).toBe(candidates[0]);
    } finally {
      process.env.HOME = savedHome;
    }
  });
});
