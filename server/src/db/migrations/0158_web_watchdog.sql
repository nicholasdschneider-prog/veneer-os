-- Independent observation and repair-chat notification; no business effects.
CREATE TABLE web_watchdog_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 conversation_id TEXT REFERENCES conversations(id),
 owner_id INTEGER REFERENCES users(id),
 incident TEXT,
 bad_samples INTEGER NOT NULL DEFAULT 0,
 good_samples INTEGER NOT NULL DEFAULT 0,
 last_notice_ms INTEGER NOT NULL DEFAULT 0,
 last_sample_ms INTEGER NOT NULL DEFAULT 0
);
INSERT INTO web_watchdog_state(singleton) VALUES(1);
CREATE TABLE web_watchdog_samples (
 id INTEGER PRIMARY KEY,
 at_ms INTEGER NOT NULL,
 web_pid INTEGER,
 latency_ms REAL NOT NULL,
 cpu_percent REAL,
 event_loop_ms REAL,
 health_ok INTEGER NOT NULL,
 code TEXT NOT NULL
);
