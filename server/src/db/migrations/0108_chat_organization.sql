CREATE TABLE chat_organization (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 scope TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 definition TEXT NOT NULL,
 PRIMARY KEY(user_id,scope)
);
CREATE INDEX bot_search_latest_assistant ON bot_search_documents(conversation_id,kind,at DESC);
