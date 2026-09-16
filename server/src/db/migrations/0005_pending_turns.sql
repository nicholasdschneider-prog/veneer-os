-- Turn auto-resume (2026-07-05). A conversation's in-flight turn is recorded
-- here when it starts and deleted when it completes (or the user interrupts).
-- A row that survives means the process died mid-turn (restart / ship / crash),
-- so at boot the manager re-runs it — agents continue instead of silently
-- stopping. `attempts` caps resumes so a turn that keeps crashing gives up.
CREATE TABLE pending_turns (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  prompt          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
