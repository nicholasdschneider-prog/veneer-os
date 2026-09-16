-- Network capture ("Advanced capture") is refused on the signed-in browser by
-- default: request traffic carries session cookies, bearer tokens, and response
-- bodies, so an injected page that talks the agent into a capture command could
-- exfiltrate the user's live session. A grant is therefore written ONLY by the
-- authenticated user over HTTP; no MCP tool can create a row here.
--
-- The grant is keyed to one working copy (clone_profile_id), not just the chat.
-- A working copy is the disposable clone a chat runs against, so a grant can
-- never carry into a new copy: discarding or replacing the copy leaves the row
-- unmatched, and the code deletes it wherever the clone row is removed.
CREATE TABLE veneer_browser_capture_grants (
  conversation_id  TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  client_scope     TEXT NOT NULL,
  clone_profile_id TEXT NOT NULL,
  granted_by       INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_veneer_browser_capture_grants_scope
  ON veneer_browser_capture_grants(client_scope, clone_profile_id);
