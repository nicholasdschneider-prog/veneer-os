CREATE TABLE bot_teaching_audio (
 id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES bot_teaching_sessions(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL,
 offset_ms INTEGER NOT NULL CHECK(offset_ms>=0 AND offset_ms<600000),
 duration_ms INTEGER NOT NULL CHECK(duration_ms>0 AND duration_ms<=600000),
 mime TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 audio BLOB NOT NULL,
 transcript TEXT,
 UNIQUE(session_id,request_key)
);
