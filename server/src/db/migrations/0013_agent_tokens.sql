-- Durable agent-tools tokens (2026-07-08). Per-turn tokens that let a chat's
-- spawned agent call back into the REST API as its owner used to live in an
-- in-memory Map. With the web/runner process split the runner mints a token
-- and the web process resolves it — different processes — so the token must
-- live in the shared DB. `expires_at` is epoch milliseconds; expired rows are
-- swept lazily on resolve.
CREATE TABLE agent_tokens (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
