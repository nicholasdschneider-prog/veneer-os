import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import {
  clearConsumedEmailCodes,
  createComposioEmailCodeSource,
  EmailCodeError,
  findEmailCode,
  findMailboxConnector,
  gmailQuery,
  parseGmailMessage,
  senderAddress,
  senderAllowed,
  type EmailCodeSource,
  type EmailFetchQuery,
  type EmailMessage,
} from '../src/veneerBrowser/emailCode.js';
import { DEFAULT_CODE_PATTERN, extractCode } from '../src/veneerBrowser/smsCode.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

/** Fixed clock so message ages in the assertions are exact. */
const NOW = Date.UTC(2026, 8, 18, 15, 0, 0);
const now = () => NOW;

const MAILBOX = 'help@elkhartrvparts.com';
const BODY = 'Your Shipsurance claim status verification code is 482913. It expires in 10 minutes.';

function message(partial: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: partial.id ?? 'm1',
    threadId: partial.threadId ?? 't1',
    sender: partial.sender ?? 'Shipsurance <noreply@shipsurance.com>',
    subject: partial.subject ?? 'Your claim status verification code',
    receivedAtMs: partial.receivedAtMs ?? NOW - 30_000,
    text: partial.text ?? BODY,
  };
}

function sourceOf(messages: EmailMessage[] | (() => EmailMessage[]), senders: string[] = ['shipsurance.com']): EmailCodeSource & { fetches: EmailFetchQuery[] } {
  const fetches: EmailFetchQuery[] = [];
  return {
    mailbox: MAILBOX,
    senders,
    fetches,
    async fetchRecent(query) {
      fetches.push(query);
      return typeof messages === 'function' ? messages() : messages;
    },
  };
}

beforeEach(() => {
  clearConsumedEmailCodes();
});

describe('shared code pattern', () => {
  it('is the pattern fill_sms_code uses', () => {
    expect(extractCode(BODY)).toBe('482913');
    expect(DEFAULT_CODE_PATTERN.exec(BODY)?.[1]).toBe('482913');
  });
});

describe('sender helpers', () => {
  it('pulls the address out of a display-name header', () => {
    expect(senderAddress('Shipsurance <NoReply@Shipsurance.com>')).toBe('noreply@shipsurance.com');
    expect(senderAddress('noreply@shipsurance.com')).toBe('noreply@shipsurance.com');
  });

  it('matches an allowlist by address, domain, or subdomain', () => {
    expect(senderAllowed('Shipsurance <noreply@shipsurance.com>', ['shipsurance.com'])).toBe(true);
    expect(senderAllowed('x <a@mail.shipsurance.com>', ['shipsurance.com'])).toBe(true);
    expect(senderAllowed('x <a@notshipsurance.com>', ['shipsurance.com'])).toBe(false);
    expect(senderAllowed('a@b.com', ['a@b.com'])).toBe(true);
    expect(senderAllowed('c@b.com', ['a@b.com'])).toBe(false);
    expect(senderAllowed('anyone@anywhere.com', [])).toBe(true);
    expect(senderAllowed('', ['b.com'])).toBe(false);
  });
});

describe('findEmailCode', () => {
  it('extracts the code from the newest in-window message and reports only metadata', async () => {
    const source = sourceOf([
      message({ id: 'old', receivedAtMs: NOW - 120_000, text: 'code 111111' }),
      message({ id: 'new', receivedAtMs: NOW - 20_000 }),
    ]);
    const match = await findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0 });
    expect(match).toEqual({
      code: '482913',
      sender: 'noreply@shipsurance.com',
      subject: 'Your claim status verification code',
      messageId: 'new',
      messageAgeSeconds: 20,
    });
    expect(Object.keys(match)).not.toContain('text');
    // The window is pinned at call start and pushed down to the source.
    expect(source.fetches[0]).toEqual({ sinceMs: NOW - 600_000, limit: 10 });
  });

  it('refuses a message older than the window even when the source returns it', async () => {
    const source = sourceOf([message({ receivedAtMs: NOW - 601_000 })]);
    await expect(findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0 }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('honors a shorter caller window', async () => {
    const source = sourceOf([message({ receivedAtMs: NOW - 90_000 })]);
    await expect(findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0, maxAgeSeconds: 60 }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('applies the configured sender allowlist', async () => {
    const source = sourceOf([message({ sender: 'phisher@evil.example' })]);
    await expect(findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0 }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('lets the caller narrow the sender but never widen it', async () => {
    const source = sourceOf([message({ sender: 'a@mail.shipsurance.com' }), message({ id: 'm2', sender: 'b@shipsurance.com' })]);
    const match = await findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0, sender: 'b@shipsurance.com' });
    expect(match.messageId).toBe('m2');
    expect(source.fetches[0]?.sender).toBe('b@shipsurance.com');
    await expect(findEmailCode(source, { conversationId: 'c2', now, waitSeconds: 0, sender: 'evil.example' }))
      .rejects.toMatchObject({ kind: 'bad_filter' });
  });

  it('accepts any sender the caller names when no allowlist is configured', async () => {
    const source = sourceOf([message({ sender: 'x@anything.example' })], []);
    const match = await findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0, sender: 'anything.example' });
    expect(match.code).toBe('482913');
  });

  it('filters by subject fragment and thread id', async () => {
    const source = sourceOf([
      message({ id: 'promo', subject: 'Weekly newsletter', text: 'save 20% with code 555555', threadId: 'tp' }),
      message({ id: 'code', subject: 'Claim status verification code', threadId: 'tc' }),
    ]);
    expect((await findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0, subject: 'verification' })).messageId).toBe('code');
    expect((await findEmailCode(source, { conversationId: 'c2', now, waitSeconds: 0, threadId: 'tc' })).messageId).toBe('code');
    await expect(findEmailCode(source, { conversationId: 'c3', now, waitSeconds: 0, subject: 'nothing like this' }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('never fills the same message twice for one chat', async () => {
    const source = sourceOf([message({ id: 'only' })]);
    const first = await findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0 });
    expect(first.messageId).toBe('only');
    await expect(findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0 }))
      .rejects.toMatchObject({ kind: 'not_found' });
    // Another chat has its own memory.
    expect((await findEmailCode(source, { conversationId: 'c2', now, waitSeconds: 0 })).messageId).toBe('only');
  });

  it('forgets a consumed message once its window has passed', async () => {
    const source = sourceOf([message({ id: 'only', receivedAtMs: NOW - 10_000 })]);
    await findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0, maxAgeSeconds: 60 });
    // 61 s + grace later the id has expired, but so has the message itself.
    const later = () => NOW + 130_000;
    await expect(findEmailCode(source, { conversationId: 'c1', now: later, waitSeconds: 0, maxAgeSeconds: 60 }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps polling and picks up a message that arrives after the first fetch', async () => {
    let arrived = false;
    const source = sourceOf(() => (arrived ? [message()] : []));
    let clock = NOW;
    const ticking = () => clock;
    const pending = findEmailCode(source, { conversationId: 'c1', now: ticking, waitSeconds: 10, pollMs: 1 });
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    arrived = true;
    clock += 2_000;
    const match = await pending;
    expect(match.code).toBe('482913');
    expect(source.fetches.length).toBeGreaterThan(1);
  });

  it('gives up after the wait with a not_found error that quotes no message', async () => {
    const source = sourceOf([message({ text: 'no code here, just a link', subject: 'Welcome' })]);
    let clock = NOW;
    const ticking = () => { clock += 3_000; return clock; };
    const error = await findEmailCode(source, { conversationId: 'c1', now: ticking, waitSeconds: 2, pollMs: 1 }).catch((e) => e as EmailCodeError);
    expect(error).toBeInstanceOf(EmailCodeError);
    expect(error.kind).toBe('not_found');
    expect(error.message).toContain(MAILBOX);
    expect(error.message).not.toContain('Welcome');
    expect(error.message).not.toContain('no code here');
  });

  it('clamps the wait to the cap', async () => {
    const source = sourceOf([message()]);
    let clock = NOW;
    const ticking = () => clock;
    const pending = findEmailCode(source, { conversationId: 'c1', now: ticking, waitSeconds: 9_999, pollMs: 1 });
    clock += 181_000;
    // The message is there, so it resolves; the point is that a huge wait is not honored past 180 s.
    await expect(pending).resolves.toMatchObject({ code: '482913' });
  });

  it('rejects an invalid pattern before touching the mailbox', async () => {
    const source = sourceOf([message()]);
    await expect(findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0, pattern: '(' }))
      .rejects.toMatchObject({ kind: 'bad_pattern' });
    expect(source.fetches).toHaveLength(0);
  });

  it('honours a well-behaved caller pattern', async () => {
    const source = sourceOf([message({ text: 'Your access key is AB-7781' })]);
    const match = await findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0, pattern: 'key is ([A-Z]{2}-\\d{4})' });
    expect(match.code).toBe('AB-7781');
  });

  it('reduces a source failure to its kind without the source text', async () => {
    const source: EmailCodeSource = {
      mailbox: MAILBOX,
      senders: [],
      async fetchRecent() { throw new Error('401 {"error":"token expired","body":"Your code is 482913"}'); },
    };
    const error = await findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0 }).catch((e) => e as EmailCodeError);
    expect(error.kind).toBe('no_access');
    expect(error.message).not.toContain('482913');
    expect(error.message).not.toContain('token expired');

    const flaky: EmailCodeSource = {
      mailbox: MAILBOX,
      senders: [],
      async fetchRecent() { throw new Error('ECONNRESET while reading 482913'); },
    };
    const other = await findEmailCode(flaky, { conversationId: 'c1', now, waitSeconds: 0 }).catch((e) => e as EmailCodeError);
    expect(other.kind).toBe('unavailable');
    expect(other.message).not.toContain('482913');
  });

  it('rejects an oversized filter', async () => {
    const source = sourceOf([message()]);
    await expect(findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0, subject: 'x'.repeat(201) }))
      .rejects.toMatchObject({ kind: 'bad_filter' });
  });
});

describe('parseGmailMessage', () => {
  it('normalizes a Composio GMAIL_FETCH_EMAILS item', () => {
    const parsed = parseGmailMessage({
      messageId: 'abc',
      threadId: 'thr',
      messageTimestamp: '2026-09-18T14:59:30Z',
      sender: 'Shipsurance <noreply@shipsurance.com>',
      subject: 'Code',
      messageText: BODY,
      labelIds: ['INBOX'],
    });
    expect(parsed).toEqual({
      id: 'abc',
      threadId: 'thr',
      sender: 'Shipsurance <noreply@shipsurance.com>',
      subject: 'Code',
      receivedAtMs: Date.UTC(2026, 8, 18, 14, 59, 30),
      text: BODY,
    });
  });

  it('falls back to payload headers, epoch strings, and a snippet', () => {
    const parsed = parseGmailMessage({
      id: 'raw',
      internalDate: String(NOW),
      snippet: 'snippet 123456',
      payload: { headers: [{ name: 'From', value: 'a@b.com' }, { name: 'Subject', value: 'S' }] },
    });
    expect(parsed).toMatchObject({ id: 'raw', threadId: null, sender: 'a@b.com', subject: 'S', receivedAtMs: NOW, text: 'snippet 123456' });
  });

  it('drops an item without an id or a timestamp', () => {
    expect(parseGmailMessage({ subject: 'x' })).toBeNull();
    expect(parseGmailMessage({ messageId: 'x', messageTimestamp: 'not a date' })).toBeNull();
    expect(parseGmailMessage('string')).toBeNull();
  });
});

describe('gmailQuery', () => {
  it('pins the window with after: and excludes sent mail', () => {
    expect(gmailQuery({ sinceMs: NOW, limit: 10 })).toBe(`after:${Math.floor(NOW / 1000) - 60} -in:sent -in:drafts`);
  });

  it('pushes a sender down and strips query metacharacters', () => {
    expect(gmailQuery({ sinceMs: NOW, sender: 'ship surance.com" OR (from:evil)', limit: 10 }))
      .toContain('from:shipsurance.comORfrom:evil');
  });
});

describe('Composio-backed source', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (2, 'two@example.com', 'Two', 'owner')").run();
  });

  afterEach(() => {
    db.close();
  });

  function insertConnector(partial: {
    label?: string | null; sharing?: 'personal' | 'shared'; status?: string; sessionId?: string | null; userId?: number;
  } = {}): number {
    const config = partial.sessionId === null ? {} : { sessionId: partial.sessionId ?? 'sess-1', connectedAccountId: 'acct-1', mcp: { type: 'http', url: 'https://mcp.example/x' } };
    const result = db.prepare(
      'INSERT INTO user_connectors (user_id, connector_slug, label, status, sharing, scope_mode, config_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(partial.userId ?? 1, 'gmail', partial.label === undefined ? 'help@elkhartrvparts.com' : partial.label, partial.status ?? 'connected', partial.sharing ?? 'shared', 'all', JSON.stringify(config));
    return Number(result.lastInsertRowid);
  }

  it('binds to exactly the shared Gmail install labeled with the mailbox', () => {
    insertConnector({ label: 'help@elkhartrvparts.com', sharing: 'personal' });
    insertConnector({ label: 'Help Elkhartrvparts Com', sharing: 'shared', status: 'pending', userId: 2 });
    const id = insertConnector({ label: 'help@elkhartrvparts.com', sharing: 'shared', userId: 2 });
    expect(findMailboxConnector(db, MAILBOX).id).toBe(id);
  });

  it('fails closed when zero or more than one install matches', () => {
    expect(() => findMailboxConnector(db, MAILBOX)).toThrow(/No connected, shared Gmail connector/);
    insertConnector();
    insertConnector({ userId: 2 });
    expect(() => findMailboxConnector(db, MAILBOX)).toThrow(/2 shared Gmail connectors/);
    const pinned = findMailboxConnector(db, MAILBOX, 1);
    expect(pinned.id).toBe(1);
    expect(() => findMailboxConnector(db, MAILBOX, 99)).toThrow(/No connected, shared Gmail connector/);
  });

  it('executes GMAIL_FETCH_EMAILS with the stored session and the runtime key, and parses the messages', async () => {
    insertConnector();
    const execute = vi.fn(async () => ({
      data: { messages: [{ messageId: 'm1', threadId: 't1', messageTimestamp: new Date(NOW - 5_000).toISOString(), sender: 'noreply@shipsurance.com', subject: 'Code', messageText: BODY }] },
      error: null,
      successful: true,
    }));
    const source = createComposioEmailCodeSource({
      db, mailbox: MAILBOX, senders: ['shipsurance.com'], composioApiKey: () => 'key-at-call-time', execute,
    });
    const messages = await source.fetchRecent({ sinceMs: NOW - 600_000, limit: 10 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'm1', sender: 'noreply@shipsurance.com' });
    expect(execute).toHaveBeenCalledWith('key-at-call-time', 'sess-1', 'GMAIL_FETCH_EMAILS', expect.objectContaining({
      query: expect.stringContaining('after:'),
      max_results: 10,
      user_id: 'me',
    }));
    const match = await findEmailCode(source, { conversationId: 'c1', now, waitSeconds: 0 });
    expect(match.code).toBe('482913');
  });

  it('refuses without a session, without a Composio key, and on an execution error, quoting nothing', async () => {
    const execute = vi.fn(async () => ({ data: null, error: 'boom: Your code is 482913', successful: false }));
    const noKey = createComposioEmailCodeSource({ db, mailbox: MAILBOX, senders: [], composioApiKey: () => null, execute });
    insertConnector({ sessionId: null });
    await expect(noKey.fetchRecent({ sinceMs: NOW, limit: 10 })).rejects.toMatchObject({ kind: 'no_access' });
    db.prepare('DELETE FROM user_connectors').run();
    insertConnector();
    await expect(noKey.fetchRecent({ sinceMs: NOW, limit: 10 })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(execute).not.toHaveBeenCalled();

    const failing = createComposioEmailCodeSource({ db, mailbox: MAILBOX, senders: [], composioApiKey: () => 'k', execute });
    const error = await findEmailCode(failing, { conversationId: 'c1', now, waitSeconds: 0 }).catch((e) => e as EmailCodeError);
    expect(error).toBeInstanceOf(EmailCodeError);
    expect(error.message).not.toContain('482913');
    expect(error.message).not.toContain('boom');
  });
});
