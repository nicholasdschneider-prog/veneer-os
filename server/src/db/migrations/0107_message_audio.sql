CREATE TABLE message_audio (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 source_hash TEXT NOT NULL,
 parts_json TEXT NOT NULL,
 UNIQUE(conversation_id, source_hash)
);
CREATE TABLE message_audio_parts (
 message_id TEXT NOT NULL REFERENCES message_audio(id) ON DELETE CASCADE,
 part INTEGER NOT NULL,
 audio BLOB NOT NULL,
 PRIMARY KEY(message_id, part)
);
