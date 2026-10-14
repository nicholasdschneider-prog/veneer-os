-- James digest contract v1 (out/build823/digest-contract.md rev 4): ERVP items
-- spooled under $DATA_DIR/james-digest are imported here, and each ET date's
-- single digest email is claimed in james_digests before it is sent. A push
-- whose emailed outcome cannot be proven is email_unknown and is never re-sent;
-- SQLite cannot alter a CHECK, so james_pushes is rebuilt with its rows and indexes.
CREATE TABLE james_pushes_v3 (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('thread', 'heartbeat', 'escalation')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'emailed', 'failed', 'deferred_digest', 'email_unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  emailed_to TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  digest_date TEXT
);
INSERT INTO james_pushes_v3 (id, conversation_id, kind, payload_json, status, attempts, last_error, emailed_to, created_at, finished_at, digest_date)
SELECT id, conversation_id, kind, payload_json, status, attempts, last_error, emailed_to, created_at, finished_at, digest_date FROM james_pushes;
DROP INDEX james_pushes_deferred;
DROP INDEX james_pushes_thread;
DROP TABLE james_pushes;
ALTER TABLE james_pushes_v3 RENAME TO james_pushes;
CREATE INDEX james_pushes_thread ON james_pushes(conversation_id, created_at);
CREATE INDEX james_pushes_deferred ON james_pushes(status) WHERE status = 'deferred_digest';

-- One row per ERVP spool item; key is the spool file name (sha256 of source + "\n" + idempotency_key).
CREATE TABLE james_digest_items (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  urgent TEXT CHECK (urgent IS NULL OR urgent IN ('money', 'customer')),
  needs_nick_today INTEGER NOT NULL DEFAULT 0,
  needed_on TEXT,
  reason TEXT,
  evidence_json TEXT,
  immediate_json TEXT,
  state TEXT NOT NULL DEFAULT 'ingested' CHECK (state IN ('ingested', 'digested', 'digest_unknown')),
  -- ET date of the digest that carries the item; NULL while it waits.
  digest_date TEXT,
  message_id TEXT,
  ingested_at TEXT NOT NULL,
  UNIQUE (source, idempotency_key)
);
CREATE INDEX james_digest_items_pending ON james_digest_items(digest_date, created_at);

CREATE TABLE james_digest_rejections (
  key TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  rejected_at TEXT NOT NULL,
  digest_date TEXT
);

-- One row per ET date, inserted before the send: a date is emailed at most once.
CREATE TABLE james_digests (
  date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'fallback', 'unknown', 'failed')),
  to_address TEXT,
  message_id TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  push_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  -- ET date of the digest that told Nick about this one being unknown.
  reported_in TEXT,
  claimed_at TEXT NOT NULL,
  finished_at TEXT
);
