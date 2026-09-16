import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express, { type Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { isUnread, markSeen, markTurnFinished } from '../src/conversations/unread.js';
import { migrate } from '../src/db/migrate.js';
import { createApiRouter } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

function seedUnreadDb(filename = ':memory:'): Database.Database {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')").run();
  db.prepare(
    "INSERT INTO users (id, email, display_name, role, status) VALUES (3, 'pending@example.com', 'Pending', 'member', 'pending')",
  ).run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, visibility, title, provider, native_session_id, channel)
     VALUES ('team-chat', 1, 1, 'team', 'Team chat', 'claude', 'session-team', 'web'),
            ('private-chat', 1, 1, 'private', 'Private chat', 'claude', 'session-private', 'web')`,
  ).run();
  return db;
}

describe('conversation unread', () => {
  it('treats a missing row as not unread', () => {
    const db = seedUnreadDb();
    expect(isUnread(db, 1, 'team-chat')).toBe(false);
    db.close();
  });

  it('marks every active teammate unread except current viewers', () => {
    const db = seedUnreadDb();
    markTurnFinished(db, { id: 'team-chat', user_id: 1, visibility: 'team' }, [1]);
    expect(isUnread(db, 1, 'team-chat')).toBe(false);
    expect(isUnread(db, 2, 'team-chat')).toBe(true);
    expect(isUnread(db, 3, 'team-chat')).toBe(false);
    db.close();
  });

  it('keeps private-chat unread on the creator only', () => {
    const db = seedUnreadDb();
    markTurnFinished(db, { id: 'private-chat', user_id: 1, visibility: 'private' }, []);
    expect(isUnread(db, 1, 'private-chat')).toBe(true);
    expect(isUnread(db, 2, 'private-chat')).toBe(false);
    db.close();
  });

  it('can mark unread again after a previous view', () => {
    const db = seedUnreadDb();
    markTurnFinished(db, { id: 'team-chat', user_id: 1, visibility: 'team' }, []);
    markSeen(db, 2, 'team-chat');
    expect(isUnread(db, 2, 'team-chat')).toBe(false);
    markTurnFinished(db, { id: 'team-chat', user_id: 1, visibility: 'team' }, []);
    expect(isUnread(db, 2, 'team-chat')).toBe(true);
    db.close();
  });

  it('acquires the write lock before reading users from a shared WAL database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-unread-concurrency-'));
    const filename = path.join(dir, 'veneer-pro.db');
    const primary = seedUnreadDb(filename);
    const concurrent = new Database(filename);
    primary.pragma('journal_mode = WAL');
    primary.pragma('busy_timeout = 10');
    concurrent.pragma('busy_timeout = 10');
    primary.exec(
      'CREATE TABLE concurrency_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO concurrency_probe VALUES (1, 0)',
    );

    let concurrentWriteSucceeded = false;
    const hooked = new Proxy(primary, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes('SELECT id FROM users')) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementKey) {
                if (statementKey === 'all') {
                  return (...params: unknown[]) => {
                    const rows = (statementTarget.all as (...values: unknown[]) => unknown[])(...params);
                    try {
                      concurrent.prepare('UPDATE concurrency_probe SET value = value + 1 WHERE id = 1').run();
                      concurrentWriteSucceeded = true;
                    } catch (err) {
                      if (!(err instanceof Error) || !('code' in err) || !String(err.code).startsWith('SQLITE_BUSY')) {
                        throw err;
                      }
                    }
                    return rows;
                  };
                }
                const value = Reflect.get(statementTarget, statementKey, statementTarget) as unknown;
                return typeof value === 'function' ? value.bind(statementTarget) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Database.Database;

    try {
      expect(() =>
        markTurnFinished(hooked, { id: 'team-chat', user_id: 1, visibility: 'team' }, []),
      ).not.toThrow();
      expect(concurrentWriteSucceeded).toBe(false);
      expect(isUnread(primary, 1, 'team-chat')).toBe(true);
      expect(isUnread(primary, 2, 'team-chat')).toBe(true);
    } finally {
      primary.close();
      concurrent.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('conversation unread routes', () => {
  let server: Server;
  let base: string;
  let db: Database.Database;
  let email = 'owner@example.com';

  beforeAll(async () => {
    db = seedUnreadDb();
    const ctx = {
      db,
      resolveIdentity: async (req: Request) => ({
        email,
        ...(typeof req.headers['x-agent-chat'] === 'string'
          ? { agentConversationId: req.headers['x-agent-chat'] }
          : {}),
      }),
      manager: { statusOf: async () => 'idle', interrupt: async () => true },
    } as unknown as AppContext;
    const app = express();
    app.use('/api', createApiRouter(ctx));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  async function listUnread(as: string): Promise<Record<string, boolean>> {
    email = as;
    const response = await fetch(`${base}/api/conversations?project=none`);
    const body = (await response.json()) as { conversations: { id: string; unread: boolean }[] };
    return Object.fromEntries(body.conversations.map((conversation) => [conversation.id, conversation.unread]));
  }

  it('shows unread after a finished turn and clears it for the user who opens the chat', async () => {
    markTurnFinished(db, { id: 'team-chat', user_id: 1, visibility: 'team' }, []);
    expect(await listUnread('owner@example.com')).toMatchObject({ 'team-chat': true });
    expect(await listUnread('member@example.com')).toMatchObject({ 'team-chat': true });

    email = 'owner@example.com';
    const opened = await fetch(`${base}/api/conversations/team-chat`);
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as { conversation: { unread: boolean } }).conversation.unread).toBe(false);

    expect(await listUnread('owner@example.com')).toMatchObject({ 'team-chat': false });
    expect(await listUnread('member@example.com')).toMatchObject({ 'team-chat': true });
  });

  it('lets a viewer mark a chat unread for themselves only', async () => {
    markSeen(db, 1, 'team-chat');
    markSeen(db, 2, 'team-chat');
    email = 'member@example.com';
    const marked = await fetch(`${base}/api/conversations/team-chat/unread`, { method: 'POST' });
    expect(marked.status).toBe(200);
    expect(((await marked.json()) as { conversation: { unread: boolean } }).conversation.unread).toBe(true);
    expect(await listUnread('member@example.com')).toMatchObject({ 'team-chat': true });
    expect(await listUnread('owner@example.com')).toMatchObject({ 'team-chat': false });

    email = 'member@example.com';
    const hidden = await fetch(`${base}/api/conversations/private-chat/unread`, { method: 'POST' });
    expect(hidden.status).toBe(404);
    expect(isUnread(db, 1, 'private-chat')).toBe(false);
  });

  it('does not clear unread when an agent reads the chat', async () => {
    markTurnFinished(db, { id: 'team-chat', user_id: 1, visibility: 'team' }, []);
    email = 'member@example.com';
    const agentRead = await fetch(`${base}/api/conversations/team-chat`, {
      headers: { 'x-agent-chat': 'team-chat' },
    });
    expect(agentRead.status).toBe(200);
    expect(((await agentRead.json()) as { conversation: { unread: boolean } }).conversation.unread).toBe(true);
    expect(await listUnread('member@example.com')).toMatchObject({ 'team-chat': true });
  });
});
