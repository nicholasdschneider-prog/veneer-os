-- Token governor: per-bot switches, honest per-turn usage, routine prechecks
-- and an audit of every rotation/skip/defer so before/after can be measured.

CREATE TABLE token_governor_bots (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  rotation INTEGER NOT NULL DEFAULT 0 CHECK (rotation IN (0, 1)),
  precheck INTEGER NOT NULL DEFAULT 0 CHECK (precheck IN (0, 1)),
  budget INTEGER NOT NULL DEFAULT 0 CHECK (budget IN (0, 1)),
  -- NULL means the built-in default (150k context, auto budget).
  rotation_threshold_tokens INTEGER CHECK (rotation_threshold_tokens IS NULL OR rotation_threshold_tokens >= 50000),
  daily_budget_tokens INTEGER CHECK (daily_budget_tokens IS NULL OR daily_budget_tokens > 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE turn_token_usage (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  bot_id TEXT,
  turn_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  wake_key TEXT,
  provider TEXT NOT NULL,
  outcome TEXT,
  context_tokens INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  UNIQUE (conversation_id, turn_id)
);
CREATE INDEX idx_turn_token_usage_bot ON turn_token_usage(bot_id, finished_at);
CREATE INDEX idx_turn_token_usage_finished ON turn_token_usage(finished_at);

CREATE TABLE token_governor_events (
  id INTEGER PRIMARY KEY,
  bot_id TEXT,
  conversation_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN (
    'rotation', 'rotation_deferred', 'precheck_skip', 'precheck_wake', 'precheck_error',
    'wake_deferred', 'wake_coalesced', 'budget_exceeded', 'budget_alert'
  )),
  detail_json TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_token_governor_events_bot ON token_governor_events(bot_id, kind, at);

CREATE TABLE routine_prechecks (
  routine_id TEXT PRIMARY KEY REFERENCES bot_routines(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL,
  last_signature TEXT,
  last_checked_at TEXT,
  last_full_run_at TEXT
);

-- Stage 1 (Nick, Nov 3 2026): AutoShip Worker gets every part; the owners of the
-- polling routines get the precheck. Absent rows on other installs are skipped.
INSERT INTO token_governor_bots (conversation_id, rotation, precheck, budget)
  SELECT id, 1, 1, 1 FROM conversations WHERE id = '1dcb56c5-be80-43c9-9b68-2817b931ecda';
INSERT INTO token_governor_bots (conversation_id, rotation, precheck, budget)
  SELECT id, 0, 1, 0 FROM conversations WHERE id IN (
    '7f83ff8e-43a3-4c16-b2bd-c304dd946d11',
    'f4131f81-27c5-4332-902a-a0d9873dfeb9',
    'a6a9b2d4-384c-423a-a2fa-4f623aaeeb98'
  );

-- AutoShip ship-to reply review: wake when either reply list changes.
INSERT INTO routine_prechecks (routine_id, config_json)
  SELECT id, '{"kind":"http_json","urls":["https://orderops-dev-web-production.up.railway.app/api/autoship/bot-ship/replies?owner=me&state=awaiting_bot","https://orderops-dev-web-production.up.railway.app/api/autoship/bot-ship/replies?owner=me&state=late"],"secret":{"name":"AUTOSHIP_BOT_TOKEN_AUTOSHIP_WORKER","project":"ervp","config":"prd"},"maxSkipMinutes":120}'
  FROM bot_routines WHERE id = '4f6be16e-23c8-4f88-bfcc-b0567b215d73';
-- Clara accounting inbox: wake when the accounting@ inbox changes; the full AP
-- slots always run.
INSERT INTO routine_prechecks (routine_id, config_json)
  SELECT id, '{"kind":"gmail","connectorIds":[3],"query":"in:inbox","maxSkipMinutes":180,"forceSlots":{"weekdays":[1,2,3,4,5,6],"times":["09:00","12:00","15:00","17:00"]}}'
  FROM bot_routines WHERE id = '5aabe607-d303-4eae-a4a2-19638a2d9613';
-- Archer silent inbox scan: wake when anything new reaches Nick's own mailboxes.
INSERT INTO routine_prechecks (routine_id, config_json)
  SELECT id, '{"kind":"gmail","connectorIds":[1,2,5,12],"query":"newer_than:2d -in:sent -in:drafts","maxSkipMinutes":180}'
  FROM bot_routines WHERE id = '72e55ece-6e03-474a-8943-aaacd7b4ba50';
-- Sage stalled paid orders: wake on huddle, purchasing-run or decision changes.
INSERT INTO routine_prechecks (routine_id, config_json)
  SELECT id, '{"kind":"local","huddleIds":["2cfd88dc-9066-46d1-b47c-f8e3249dec94"],"scheduledTaskIds":["9c72a42a-40df-4477-9ba6-07f74ac08bf3"],"decisionsOf":"a6a9b2d4-384c-423a-a2fa-4f623aaeeb98","maxSkipMinutes":180}'
  FROM bot_routines WHERE id = 'bbea938d-0331-40f5-8dd2-786410bba5ba';
