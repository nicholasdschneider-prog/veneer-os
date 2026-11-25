-- Brock relay: needs-Nick cards pushed to the Grok Bot "Brock", and the durable event outbox.
CREATE TABLE brock_relay_cards (
  decision_id TEXT PRIMARY KEY REFERENCES bot_decisions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','resolved')),
  test INTEGER NOT NULL DEFAULT 0 CHECK (test IN (0,1)),
  resolution TEXT,
  answered_via TEXT,
  raised_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
CREATE INDEX brock_relay_cards_status ON brock_relay_cards(status);
-- Payloads are built at send time, so no signed URL is ever stored.
CREATE TABLE brock_relay_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK (event_type IN ('card.raised','card.resolved')),
  decision_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT
);
CREATE INDEX brock_relay_outbox_due ON brock_relay_outbox(status, id);
