import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrate.js';
import { openDb } from '../src/db/db.js';
import { indexConversation } from '../src/botWorkflows/search.js';
import { namespaceHistory, originalNativeId } from '../src/runtime/providerSwitch.js';
import { HistoryPages } from '../src/runtime/historyPages.js';
import { queuedResultReplyWake } from '../src/bots/communication.js';
import { queuedRoomWakeAllowed } from '../src/rooms/service.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import type { ConversationRow } from '../src/db/db.js';
import type { AppContext } from '../src/context.js';

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-repair-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function memoryDb() {
  const db = new Database(':memory:');
  migrate(db, path.resolve('src/db/migrations'));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'o@example.com','O','owner')").run();
  db.prepare("INSERT INTO conversations(id,assistant_id,user_id,provider,native_session_id,last_active_at) VALUES('c',1,1,'codex','n','2026-11-04 12:00:00')").run();
  return db;
}
const turn = (i: number, at: string, turnId = `t${i}`): ConversationEvent[] => [
  { type: 'turn_started', turnId, role: 'user', text: `question ${i}`, at, via: 'web' },
  { type: 'text_final', turnId, markdown: `answer ${i}`, at },
];

describe('search index cost', () => {
  function setup(events: ConversationEvent[]) {
    const db = memoryDb();
    const searchableEvents = vi.fn(async () => events);
    const ctx = { db, manager: { searchableEvents } } as unknown as AppContext;
    const conv = db.prepare("SELECT * FROM conversations WHERE id='c'").get() as ConversationRow;
    return { db, ctx, conv, searchableEvents };
  }
  const ftsWrites = (db: Database.Database) => db.prepare("SELECT total_changes() AS n").get() as { n: number };

  it('asks only for what is new, and records progress last', async () => {
    const { db, ctx, conv, searchableEvents } = setup(turn(1, '2026-11-04T11:00:00.000Z'));
    await indexConversation(ctx, conv);
    expect(searchableEvents).toHaveBeenLastCalledWith('c', null);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bot_search_documents').get()).toEqual({ n: 2 });
    await indexConversation(ctx, conv);
    expect(searchableEvents).toHaveBeenLastCalledWith('c', '2026-11-04 12:00:00');
  });

  it('writes nothing when the same messages come back, even after a session change renames their turns', async () => {
    const original = [...turn(1, '2026-11-04T11:00:00.000Z'), ...turn(2, '2026-11-04T11:05:00.000Z')];
    const { db, ctx, conv, searchableEvents } = setup(original);
    await indexConversation(ctx, conv);
    const before = ftsWrites(db).n;
    await indexConversation(ctx, conv);
    // Only the progress upsert touches the database.
    expect(ftsWrites(db).n - before).toBe(1);
    searchableEvents.mockResolvedValue(namespaceHistory(namespaceHistory(original)));
    await indexConversation(ctx, conv);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bot_search_documents').get()).toEqual({ n: 4 });
  });

  it('indexes a long first backfill in short transactions', async () => {
    const events = Array.from({ length: 300 }, (_, i) => turn(i, `2026-11-04T11:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`)).flat();
    const { db, ctx, conv } = setup(events);
    const transactions: number[] = [];
    const run = db.transaction.bind(db);
    db.transaction = ((fn: (batch: ConversationEvent[]) => void) => run((batch: ConversationEvent[]) => { transactions.push(batch.length); fn(batch); })) as typeof db.transaction;
    await indexConversation(ctx, conv);
    expect(Math.max(...transactions)).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bot_search_documents').get()).toEqual({ n: 600 });
  });
});

describe('history namespaces', () => {
  it('stay one level deep across repeated session changes', () => {
    const once = namespaceHistory(turn(1, 'x'));
    const twice = namespaceHistory(once);
    const id = (twice[0] as { turnId: string }).turnId;
    expect(id).toMatch(/^[0-9a-f-]{36}:t1$/);
    expect(id).not.toBe((once[0] as { turnId: string }).turnId);
    expect(originalNativeId(id)).toBe('t1');
    expect(originalNativeId('019abc:plain')).toBe('019abc:plain');
  });
});

describe('opening a long chat', () => {
  it('builds the same pages as the synchronous path while yielding to other work', async () => {
    const store = new HistoryPages();
    try {
      const events = Array.from({ length: 2500 }, (_, i) => turn(i, '2026-11-04T11:00:00.000Z')).flat();
      let ticks = 0;
      const timer = setInterval(() => { ticks += 1; }, 0);
      const opened = await store.openAsync('chat', events, 7, 'e');
      clearInterval(timer);
      const plain = store.open('chat', events, 7, 'e');
      expect(ticks).toBeGreaterThan(0);
      expect(opened.events).toEqual(plain.events);
      expect({ ...opened.history, token: '' }).toEqual({ ...plain.history, token: '' });
      expect(store.record('chat', opened.history.token, 4999)).toMatchObject({ type: 'text_final', markdown: 'answer 2499' });
    } finally { store.close(); }
  });
});

describe('write lock', () => {
  it('waits instead of failing when a read-then-write transaction loses the race', () => {
    const dir = tmp();
    const a = openDb(dir);
    const b = new Database(path.join(dir, 'veneer-pro.db'));
    b.pragma('busy_timeout = 2000');
    try {
      a.exec('CREATE TABLE t(x)');
      // A deferred transaction read, then another service committed: SQLITE_BUSY_SNAPSHOT at once.
      const deferred = a.transaction(() => {
        a.prepare('SELECT COUNT(*) FROM t').get();
        b.prepare('INSERT INTO t VALUES (1)').run();
        a.prepare('INSERT INTO t VALUES (2)').run();
      }).deferred;
      expect(deferred).toThrow(/locked/);
      // The default holds the write lock first, so the other writer waits its turn.
      b.pragma('busy_timeout = 0');
      const immediate = a.transaction(() => {
        expect(() => b.prepare('INSERT INTO t VALUES (3)').run()).toThrow(/locked/);
        a.prepare('INSERT INTO t VALUES (4)').run();
        const nested = a.transaction(() => a.prepare('INSERT INTO t VALUES (5)').run());
        nested();
      });
      immediate();
      expect(a.prepare('SELECT x FROM t ORDER BY x').all()).toEqual([{ x: 1 }, { x: 4 }, { x: 5 }]);
    } finally { b.close(); a.close(); }
  });
});

describe('queued wake lookups', () => {
  it('use the receipt index instead of scanning every wake-up', () => {
    const db = memoryDb();
    db.prepare("INSERT INTO conversation_wakeups(id,conversation_id,wake_key,reason,scheduled_for,status) VALUES('w','c','message-thread:1','r','2026-11-04T00:00:00Z','delivered')").run();
    db.prepare("INSERT INTO hub_inbound_messages(idempotency_key,conversation_id,message_id,source_kind) VALUES('wakeup:w','c',5,'wakeup')").run();
    expect(queuedResultReplyWake(db, 'c', 5)).toMatchObject({ id: 'w' });
    expect(queuedResultReplyWake(db, 'c', 6)).toBeUndefined();
    expect(queuedRoomWakeAllowed(db, 'c', 5)).toBe(true);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT w.* FROM hub_inbound_messages h JOIN conversation_wakeups w
      ON w.id=substr(h.idempotency_key, 8) AND h.source_kind='wakeup' WHERE h.conversation_id=? AND h.message_id=? AND w.wake_key LIKE 'message-thread:%'`)
      .all('c', 5) as { detail: string }[];
    expect(plan.map((row) => row.detail).join(' ')).not.toMatch(/SCAN/);
  });
});

describe('hot path indexes', () => {
  const plan = (db: Database.Database, sql: string) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((row) => row.detail).join(' | ');

  it('reads one chat’s browser events without scanning the audit table', () => {
    const db = memoryDb();
    expect(plan(db, "SELECT MAX(id) AS id FROM veneer_browser_audit WHERE client_scope='s' AND conversation_id='c' AND action='clone.created'"))
      .toContain('idx_veneer_browser_audit_conversation_action');
    const events = plan(db, "SELECT action, metadata_json, created_at FROM veneer_browser_audit WHERE client_scope='s' AND conversation_id='c' AND id>1 ORDER BY id");
    expect(events).toContain('idx_veneer_browser_audit_conversation');
    expect(events).not.toContain('TEMP B-TREE');
  });

  it('finds a bot’s lanes and a wake’s routine delivery by index', () => {
    const db = memoryDb();
    expect(plan(db, "SELECT conversation_id FROM coordination_lanes WHERE owner_id='c'")).toContain('idx_coordination_lanes_owner');
    expect(plan(db, "SELECT routine_id FROM bot_routine_deliveries WHERE wakeup_id='w'")).toContain('idx_bot_routine_deliveries_wakeup');
  });
});
