-- Cross-instance messaging keeps message bodies only while delivery is pending.
-- Credentials never enter SQLite; they live in DATA_DIR/hub-keyring.json (0600).
CREATE TABLE hub_inbound_messages (
  idempotency_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE remote_outbox (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  instance_slug TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'delivering', 'delivered', 'failed')),
  disposition TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error_code TEXT,
  source_conversation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);

CREATE INDEX remote_outbox_due_idx
  ON remote_outbox(state, next_attempt_at);
