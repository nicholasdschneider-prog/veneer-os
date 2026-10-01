-- Personal presentation state; never a decision or business authorization.
CREATE TABLE question_line_state (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 selected_id TEXT,
 show_evidence INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE question_line_positions (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 decision_id TEXT NOT NULL REFERENCES bot_decisions(id) ON DELETE CASCADE,
 served_ms INTEGER NOT NULL DEFAULT 0,
 until_ms INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id, decision_id)
);
