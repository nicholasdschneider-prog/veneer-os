-- Focused members retain operational capabilities, with an explicit bot scope.
CREATE TABLE focused_workspaces (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 team_id TEXT NOT NULL REFERENCES business_teams(id)
);
CREATE TABLE focused_bot_access (
 user_id INTEGER NOT NULL REFERENCES focused_workspaces(user_id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 PRIMARY KEY(user_id, conversation_id)
);
