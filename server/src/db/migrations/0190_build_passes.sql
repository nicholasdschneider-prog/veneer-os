-- A build approval Nick (or James) gave in one chat, carried to the chat that
-- will queue the build. Minted only inside an approver's own turn; redeemed
-- once by the chat it names, within its expiry.
CREATE TABLE build_passes (
  id                     TEXT PRIMARY KEY,
  source_conversation_id TEXT NOT NULL,
  source_turn_at         TEXT,
  approver_user_id       INTEGER NOT NULL REFERENCES users(id),
  target_conversation_id TEXT NOT NULL,
  request_key            TEXT,
  scope_note             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at             TEXT NOT NULL,
  used_at                TEXT,
  used_by_job_id         INTEGER
);
CREATE INDEX build_passes_target ON build_passes(target_conversation_id) WHERE used_at IS NULL;
CREATE UNIQUE INDEX build_passes_request ON build_passes(source_conversation_id, request_key) WHERE request_key IS NOT NULL;
