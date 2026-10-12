-- James link: a thread registry over every chat, a per-thread turn ledger
-- stamped in both directions, and the push/email delivery log for James's
-- Grok Bot. Nothing here is ever deleted; archive is a status.

CREATE TABLE james_threads (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  started_by TEXT NOT NULL CHECK (started_by IN ('james', 'nick', 'bot')),
  started_by_source TEXT NOT NULL DEFAULT 'live' CHECK (started_by_source IN ('backfill', 'live', 'james')),
  followed INTEGER NOT NULL DEFAULT 0 CHECK (followed IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'waiting_on_james', 'waiting_on_veneer', 'done', 'archived')),
  turn INTEGER NOT NULL DEFAULT 0 CHECK (turn >= 0),
  last_activity TEXT NOT NULL,
  question_since TEXT,
  question_pushed_at TEXT,
  quiet_pushed_at TEXT,
  done_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX james_threads_status ON james_threads(status, last_activity);
CREATE INDEX james_threads_james ON james_threads(started_by, followed, status);

-- One row per stamped message. source_ref dedupes replayed events.
CREATE TABLE james_thread_messages (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('to_veneer', 'from_veneer')),
  author TEXT NOT NULL CHECK (author IN ('james', 'human', 'bot', 'veneer')),
  via TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (conversation_id, turn),
  UNIQUE (conversation_id, direction, source_ref)
);

CREATE TABLE james_pushes (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('thread', 'heartbeat', 'escalation')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'emailed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  emailed_to TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);
CREATE INDEX james_pushes_thread ON james_pushes(conversation_id, created_at);

-- Reasons waiting to be batched into the next push for a thread
-- (conversation_id NULL = the daily heartbeat).
CREATE TABLE james_push_events (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('reply', 'question_unanswered', 'quiet', 'heartbeat', 'status_changed', 'test')),
  turn INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}',
  -- james_pushes.id once batched; 0 when the thread vanished before sending.
  push_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX james_push_events_pending ON james_push_events(push_id, conversation_id);

CREATE TABLE james_email_commands (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT,
  command TEXT,
  sender TEXT NOT NULL,
  result TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE james_link_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
