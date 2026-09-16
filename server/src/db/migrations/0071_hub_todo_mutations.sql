-- Cache successful hub Todo writes so a network retry cannot create or apply
-- the same mutation twice. The request hash prevents key reuse for new data.
CREATE TABLE hub_todo_mutations (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_hub_todo_mutations_created ON hub_todo_mutations(created_at);
