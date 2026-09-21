-- Huddles: focused multi-bot group threads around one outcome. A huddle is not
-- a conversation; every member bot keeps running in its own chat with its own
-- identity, permissions and tools. Messages are delivered by waking the
-- recipient chats through conversation_wakeups, so delivery survives restarts.
CREATE TABLE huddles (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  business_team_id TEXT REFERENCES business_teams(id),
  goal TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  status_note TEXT NOT NULL DEFAULT '',
  lead_conversation_id TEXT NOT NULL REFERENCES conversations(id),
  owner_conversation_id TEXT REFERENCES conversations(id),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_by_conversation_id TEXT REFERENCES conversations(id),
  request_key TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  closed_by TEXT,
  close_verification TEXT,
  reopened_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One open huddle per outcome per business: a second open_huddle for the same
-- goal joins the existing thread instead of creating a duplicate.
CREATE UNIQUE INDEX huddles_open_dedupe ON huddles(scope_key, dedupe_key) WHERE status='open';
CREATE UNIQUE INDEX huddles_request_key ON huddles(created_by_conversation_id, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX huddles_scope ON huddles(scope_key, status, updated_at);

CREATE TABLE huddle_members (
  huddle_id TEXT NOT NULL REFERENCES huddles(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('lead','member')),
  invited_by TEXT NOT NULL DEFAULT '',
  joined_at TEXT NOT NULL,
  left_at TEXT,
  -- Delivery cursors. delivered_seq advances when a wake carrying messages up
  -- to wake_seq is delivered to the bot chat; read_seq when the bot reads.
  delivered_seq INTEGER NOT NULL DEFAULT 0,
  read_seq INTEGER NOT NULL DEFAULT 0,
  wake_seq INTEGER NOT NULL DEFAULT 0,
  pending_wakeup_id TEXT,
  last_wake_at TEXT,
  PRIMARY KEY(huddle_id, conversation_id)
);
CREATE INDEX huddle_members_conversation ON huddle_members(conversation_id);

CREATE TABLE huddle_messages (
  id TEXT PRIMARY KEY,
  huddle_id TEXT NOT NULL REFERENCES huddles(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('message','handoff','status','system')),
  author_conversation_id TEXT,
  author_user_id INTEGER,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  targets_json TEXT NOT NULL DEFAULT '[]',
  recipients_json TEXT NOT NULL DEFAULT '[]',
  action_id TEXT,
  request_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(huddle_id, seq)
);
CREATE UNIQUE INDEX huddle_messages_request ON huddle_messages(huddle_id, author_conversation_id, request_key) WHERE request_key IS NOT NULL;

CREATE TABLE huddle_actions (
  id TEXT PRIMARY KEY,
  huddle_id TEXT NOT NULL REFERENCES huddles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  owner_conversation_id TEXT REFERENCES conversations(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','blocked','cancelled')),
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX huddle_actions_huddle ON huddle_actions(huddle_id, status);
