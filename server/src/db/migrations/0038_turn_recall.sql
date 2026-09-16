-- Per-turn memory recall (2026-07-22). Captures the structured Supermemory
-- records that produced a turn's "Remembered context" block, so a reloaded
-- transcript can re-attach the per-message recall chip. On reload the native
-- transcript re-synthesizes turnIds (t1, t2, …) that no longer match the UUIDs
-- stored here, so the transcript route re-matches rows by prompt text + order.
CREATE TABLE turn_recall (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id         TEXT NOT NULL,
  prompt_text     TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX turn_recall_conversation ON turn_recall(conversation_id);
