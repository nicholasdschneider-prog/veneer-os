-- Master calendar: one person's merged Google calendars in a side panel.
-- Events stay in Google; Veneer keeps only presentation and reminder state.
CREATE TABLE master_calendar_settings (
 user_id INTEGER PRIMARY KEY REFERENCES users(id),
 panel_open INTEGER NOT NULL DEFAULT 0 CHECK(panel_open IN (0,1)),
 view_days INTEGER NOT NULL DEFAULT 1 CHECK(view_days IN (1,3)),
 default_lead_minutes INTEGER DEFAULT 10 CHECK(default_lead_minutes IS NULL OR default_lead_minutes IN (0,5,10,15,30,60)),
 -- "<connectorId>:<calendarId>" -> true when shown, false when hidden; absent follows Google.
 visibility_json TEXT NOT NULL DEFAULT '{}',
 -- "<connectorId>:<calendarId>" -> minutes, or null for no reminder.
 calendar_leads_json TEXT NOT NULL DEFAULT '{}',
 updated_ms INTEGER NOT NULL
);
-- Per-event override. NULL lead_minutes means no reminder for that event.
CREATE TABLE master_calendar_event_leads (
 user_id INTEGER NOT NULL REFERENCES users(id),
 event_key TEXT NOT NULL,
 lead_minutes INTEGER CHECK(lead_minutes IS NULL OR lead_minutes IN (0,5,10,15,30,60)),
 updated_ms INTEGER NOT NULL,
 PRIMARY KEY(user_id, event_key)
);
-- Dismiss and snooze, shared by every device of the person.
CREATE TABLE master_calendar_reminder_state (
 user_id INTEGER NOT NULL REFERENCES users(id),
 occurrence_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('dismissed','snoozed')),
 snooze_until_ms INTEGER,
 updated_ms INTEGER NOT NULL,
 PRIMARY KEY(user_id, occurrence_key)
);
-- One push per device per reminder firing (occurrence plus due time, so a snooze can fire again).
CREATE TABLE master_calendar_push_sent (
 device_id TEXT NOT NULL,
 firing_key TEXT NOT NULL,
 sent_ms INTEGER NOT NULL,
 PRIMARY KEY(device_id, firing_key)
);
CREATE INDEX master_calendar_push_sent_age ON master_calendar_push_sent(sent_ms);
