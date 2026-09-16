import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { ConversationRow } from '../src/db/db.js';
import {
  createConversationManager,
  spliceUserStopNotices,
} from '../src/runtime/conversationManager.js';
import type { ProviderAdapter, TurnSpec } from '../src/providers/types.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import { USER_STOPPED_NOTICE, VENEER_RESTARTED_NOTICE } from '../src/runtime/events.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

function userMessage(at: string): ConversationEvent {
  return { type: 'turn_started', turnId: `t-${at}`, role: 'user', text: 'hello', at, via: 'web' };
}

function restartNotice(at?: string): ConversationEvent {
  return { type: 'notice', message: VENEER_RESTARTED_NOTICE, ...(at ? { at } : {}) };
}

describe('spliceUserStopNotices', () => {
  it('relabels a notice when a stop falls after the last user message', () => {
    const out = spliceUserStopNotices(
      [userMessage('2026-09-01T10:00:00Z'), restartNotice('2026-09-01T10:05:00Z')],
      ['2026-09-01T10:02:00Z'],
    );
    expect(out[1]).toEqual({ type: 'notice', message: USER_STOPPED_NOTICE, at: '2026-09-01T10:05:00Z' });
  });

  it('leaves the notice alone when the stop predates the last user message', () => {
    const events = [userMessage('2026-09-01T10:00:00Z'), restartNotice('2026-09-01T10:05:00Z')];
    expect(spliceUserStopNotices(events, ['2026-09-01T09:30:00Z'])).toEqual(events);
  });

  it('leaves the notice alone when the stop is after the notice', () => {
    const events = [userMessage('2026-09-01T10:00:00Z'), restartNotice('2026-09-01T10:05:00Z')];
    expect(spliceUserStopNotices(events, ['2026-09-01T10:06:00Z'])).toEqual(events);
  });

  it('leaves everything untouched with no recorded stops', () => {
    const events = [userMessage('2026-09-01T10:00:00Z'), restartNotice('2026-09-01T10:05:00Z')];
    expect(spliceUserStopNotices(events, [])).toEqual(events);
  });

  it('leaves a notice with no timestamp untouched', () => {
    const events = [userMessage('2026-09-01T10:00:00Z'), restartNotice()];
    expect(spliceUserStopNotices(events, ['2026-09-01T10:02:00Z'])).toEqual(events);
  });

  it('matches each stop to at most one notice', () => {
    const out = spliceUserStopNotices(
      [
        userMessage('2026-09-01T10:00:00Z'),
        restartNotice('2026-09-01T10:05:00Z'),
        userMessage('2026-09-01T11:00:00Z'),
        restartNotice('2026-09-01T11:05:00Z'),
      ],
      ['2026-09-01T10:02:00Z', '2026-09-01T11:02:00Z'],
    );
    expect(out.map((e) => (e.type === 'notice' ? e.message : e.type))).toEqual([
      'turn_started',
      USER_STOPPED_NOTICE,
      'turn_started',
      USER_STOPPED_NOTICE,
    ]);
  });

  it('does not let one stop relabel two notices in the same turn', () => {
    const out = spliceUserStopNotices(
      [
        userMessage('2026-09-01T10:00:00Z'),
        restartNotice('2026-09-01T10:05:00Z'),
        restartNotice('2026-09-01T10:06:00Z'),
      ],
      ['2026-09-01T10:02:00Z'],
    );
    expect(out.filter((e) => e.type === 'notice' && e.message === USER_STOPPED_NOTICE)).toHaveLength(1);
    expect(out.filter((e) => e.type === 'notice' && e.message === VENEER_RESTARTED_NOTICE)).toHaveLength(1);
  });
});

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('owner@example.com', 'Sam', 'owner')").run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES ('conv-1', 1, 1, 'Test', 'claude', 'sid-1', 'web')`,
  ).run();
  return db;
}

/** Minimal adapter whose turn never ends on its own, so interrupt() has a live turn to kill. */
function stallingAdapter() {
  const killReasons: string[] = [];
  const adapter: ProviderAdapter = {
    id: 'claude',
    mintSessionId: () => 'sid',
    runTurn(_spec: TurnSpec) {
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => (resolveDone = r));
      return {
        done,
        kill: (reason?: string) => {
          killReasons.push(reason ?? 'user');
          resolveDone();
        },
        steer: async () => true,
        respondToApproval: () => true,
      };
    },
    readTranscript: async () => [],
  };
  return { adapter, killReasons };
}

describe('interrupt() records user stops', () => {
  let db: Database.Database;
  let conv: ConversationRow;
  beforeEach(() => {
    db = openTestDb();
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('conv-1') as ConversationRow;
  });

  function makeManager(adapter: ProviderAdapter) {
    return createConversationManager({
      db,
      adapters: { claude: adapter },
      resolveWorkspace: () => ({ workspaceDir: '/tmp', assistantSlug: 'assistant', elevated: false }),
      log: { warn: () => undefined, error: () => undefined },
    });
  }

  it('writes a turn_stops row for a user stop', () => {
    const { adapter } = stallingAdapter();
    const manager = makeManager(adapter);
    manager.postMessage(conv, 'do the thing');
    expect(manager.interrupt(conv.id)).toBe(true);
    const rows = db.prepare('SELECT conversation_id, stopped_at, reason FROM turn_stops').all() as {
      conversation_id: string;
      stopped_at: string;
      reason: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversation_id).toBe('conv-1');
    expect(rows[0]!.reason).toBe('user');
    expect(Number.isFinite(Date.parse(rows[0]!.stopped_at))).toBe(true);
  });

  it('does not record a watchdog timeout kill', () => {
    const { adapter } = stallingAdapter();
    const manager = makeManager(adapter);
    manager.postMessage(conv, 'do the thing');
    expect(manager.interrupt(conv.id, 'timeout')).toBe(true);
    expect(db.prepare('SELECT * FROM turn_stops').all()).toHaveLength(0);
  });
});
