-- Provider-neutral same-conversation wake-ups. The runner is the only
-- dispatcher; pending rows survive web/runner restarts and overdue rows fire
-- when the runner comes back.
CREATE TABLE conversation_wakeups (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  wake_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  cancelled_at TEXT
);

CREATE UNIQUE INDEX idx_conversation_wakeups_pending_key
  ON conversation_wakeups(conversation_id, wake_key)
  WHERE status = 'pending';
CREATE INDEX idx_conversation_wakeups_due
  ON conversation_wakeups(status, scheduled_for);
CREATE INDEX idx_conversation_wakeups_conversation
  ON conversation_wakeups(conversation_id, created_at DESC);

-- The existing receipt table also supplies durable message idempotency. Keep
-- hub provenance separate from wake delivery so a wake receipt can never pass
-- the machine-authenticated hub verification endpoint.
ALTER TABLE hub_inbound_messages ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'hub'
  CHECK (source_kind IN ('hub', 'wakeup'));
