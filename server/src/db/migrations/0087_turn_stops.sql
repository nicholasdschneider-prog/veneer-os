-- A user Stop kills the provider CLI, and Claude does not reliably write its
-- "[Request interrupted by user]" marker before dying. On the next --resume the
-- session file looks exactly like a runner restart, so the transcript parser
-- wrongly showed "Veneer restarted while this turn was running". Record stops
-- durably here so the snapshot can relabel those notices.
CREATE TABLE turn_stops (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  stopped_at      TEXT NOT NULL,
  reason          TEXT NOT NULL
);

CREATE INDEX turn_stops_conversation ON turn_stops(conversation_id, id);
