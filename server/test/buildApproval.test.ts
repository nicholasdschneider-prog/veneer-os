import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import {
  BUILD_APPROVERS_SETTING,
  isReplyToTechnical,
  isTechnicalConversation,
  requestMayStartBuild,
  turnMayStartBuild,
} from '../src/buildQueue/buildApproval.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
let db: Database.Database;

function chat(id: string, slug = 'assistant', channel = 'web') {
  const a = db.prepare('SELECT id FROM assistants WHERE slug = ?').get(slug) as { id: number };
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES (?, ?, 1, ?, 'claude', ?, ?)`,
  ).run(id, a.id, id, `native-${id}`, channel);
}
function turn(conversationId: string, actor: number | null, origin: object | null) {
  db.prepare(
    "INSERT INTO pending_turns (conversation_id, prompt, actor_user_id, origin_json, status) VALUES (?, 'p', ?, ?, 'pending')",
  ).run(conversationId, actor, origin ? JSON.stringify(origin) : null);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'nick@example.com', 'Nick', 'owner')").run();
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (2, 'ali@example.com', 'Ali', 'member')").run();
});

describe('only Nick (or James on his behalf) starts code work', () => {
  it("allows Nick's own live turn, including James link posts made as the owner", () => {
    chat('c');
    turn('c', 1, null);
    expect(turnMayStartBuild(db, 'c')).toBe(true);
  });

  it("allows a result-thread reply from Nick and a queued build's own turn", () => {
    chat('r');
    turn('r', 1, { kind: 'result_reply', from: 'Nick', to: 'Bot' });
    expect(turnMayStartBuild(db, 'r')).toBe(true);
    chat('b');
    turn('b', 1, { kind: 'build_queue', from: 'Build queue', to: 'Platform Dev' });
    expect(turnMayStartBuild(db, 'b')).toBe(true);
  });

  it('refuses another employee, a bot message, a wake-up and a spare run', () => {
    chat('m');
    turn('m', 2, null);
    expect(turnMayStartBuild(db, 'm')).toBe(false);
    chat('a');
    turn('a', 1, { kind: 'agent', from: 'Tess', to: 'Boris' });
    expect(turnMayStartBuild(db, 'a')).toBe(false);
    chat('w');
    turn('w', 1, { kind: 'wakeup', from: 'Boris', to: 'Boris' });
    expect(turnMayStartBuild(db, 'w')).toBe(false);
    chat('s');
    turn('s', 1, { kind: 'result_reply', from: 'x', to: 'y', spareRunId: 'run' });
    expect(turnMayStartBuild(db, 's')).toBe(false);
  });

  it('refuses automation chats, scheduled runs and unknown turns', () => {
    chat('auto', 'assistant', 'automation');
    turn('auto', 1, null);
    expect(turnMayStartBuild(db, 'auto')).toBe(false);
    chat('routine');
    turn('routine', 1, null);
    db.prepare("INSERT INTO scheduled_tasks (id, user_id, assistant_id, name, prompt, schedule_json, timezone, provider) VALUES ('t', 1, 1, 't', 'p', '{}', 'UTC', 'claude')").run();
    db.prepare("INSERT INTO scheduled_task_runs (id, scheduled_task_id, conversation_id, scheduled_for, trigger, status) VALUES ('run', 't', 'routine', '2026-10-14', 'scheduled', 'running')").run();
    expect(turnMayStartBuild(db, 'routine')).toBe(false);
    chat('idle');
    expect(turnMayStartBuild(db, 'idle')).toBe(false);
    expect(turnMayStartBuild(db, undefined)).toBe(false);
  });

  it('honors a widened approver setting and direct human requests', () => {
    chat('m');
    turn('m', 2, null);
    db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(BUILD_APPROVERS_SETTING, '[1,2]');
    expect(turnMayStartBuild(db, 'm')).toBe(true);
    expect(requestMayStartBuild(db, { user: { id: 2 } })).toBe(true);
  });

  it('treats Platform Dev and Boris as technical, and lets bots answer them', () => {
    chat('pd', 'platform-dev');
    chat('boris');
    chat('tess');
    db.prepare("INSERT INTO bot_registrations (conversation_id, name, active, registered_by) VALUES ('boris', 'Boris', 1, 1)").run();
    expect(isTechnicalConversation(db, 'pd')).toBe(true);
    expect(isTechnicalConversation(db, 'boris')).toBe(true);
    expect(isTechnicalConversation(db, 'tess')).toBe(false);
    expect(isReplyToTechnical(db, 'tess', 'boris')).toBe(false);
    db.prepare(
      "INSERT INTO agent_message_receipts (source_conversation_id, target_conversation_id, message_id, message_text, disposition) VALUES ('boris', 'tess', 'm1', 'please verify', 'delivered')",
    ).run();
    expect(isReplyToTechnical(db, 'tess', 'boris')).toBe(true);
  });
});
