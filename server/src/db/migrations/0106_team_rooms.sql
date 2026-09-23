CREATE TABLE team_rooms (
 id TEXT PRIMARY KEY,
 team_id TEXT NOT NULL REFERENCES business_teams(id),
 kind TEXT NOT NULL CHECK(kind IN ('dm','group')),
 name TEXT NOT NULL,
 owner_id INTEGER NOT NULL REFERENCES users(id),
 dm_key TEXT UNIQUE,
 request_key TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 last_seq INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(owner_id,request_key)
);
CREATE TABLE team_room_members (
 room_id TEXT NOT NULL REFERENCES team_rooms(id) ON DELETE CASCADE,
 member_key TEXT NOT NULL,
 user_id INTEGER REFERENCES users(id),
 bot_id TEXT REFERENCES conversations(id),
 epoch TEXT NOT NULL,
 seen_seq INTEGER NOT NULL DEFAULT 0,
 left_at TEXT,
 PRIMARY KEY(room_id,member_key),
 CHECK((user_id IS NOT NULL AND bot_id IS NULL) OR (user_id IS NULL AND bot_id IS NOT NULL))
);
CREATE TABLE team_room_messages (
 id TEXT PRIMARY KEY,
 room_id TEXT NOT NULL REFERENCES team_rooms(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL,
 author_key TEXT NOT NULL,
 author_name TEXT NOT NULL,
 text TEXT NOT NULL,
 mentions_json TEXT NOT NULL,
 attachments_json TEXT NOT NULL,
 request_key TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(room_id,seq),
 UNIQUE(room_id,author_key,request_key)
);
CREATE TABLE team_room_deliveries (
 wake_id TEXT PRIMARY KEY REFERENCES conversation_wakeups(id),
 room_id TEXT NOT NULL REFERENCES team_rooms(id),
 message_id TEXT NOT NULL REFERENCES team_room_messages(id),
 bot_id TEXT NOT NULL REFERENCES conversations(id),
 bot_epoch TEXT NOT NULL,
 author_key TEXT NOT NULL,
 author_epoch TEXT NOT NULL
);
CREATE TABLE team_room_files (
 id TEXT PRIMARY KEY,
 room_id TEXT NOT NULL REFERENCES team_rooms(id),
 uploader_key TEXT NOT NULL,
 name TEXT NOT NULL,
 storage_path TEXT NOT NULL,
 size INTEGER NOT NULL,
 message_id TEXT REFERENCES team_room_messages(id),
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX team_room_user ON team_room_members(user_id,room_id);
CREATE INDEX team_room_bot ON team_room_members(bot_id,room_id);
CREATE INDEX team_room_messages_order ON team_room_messages(room_id,seq);
-- Isolated provider sessions: no private bot transcript enters a room, and no
-- room transcript enters the original bot conversation.
CREATE TABLE team_room_workers (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
 room_id TEXT NOT NULL REFERENCES team_rooms(id),
 bot_id TEXT NOT NULL REFERENCES conversations(id),
 bot_epoch TEXT NOT NULL,
 UNIQUE(room_id,bot_id,bot_epoch)
);
