-- User lifecycle: unknown-but-authenticated emails are now auto-provisioned as
-- pending members (see /me), so a user needs a status separate from its role.
-- 'pending' awaits admin approval, 'active' is a normal user, 'disabled' is an
-- offboarded account kept for history (there is no DELETE). Existing rows adopt
-- the 'active' default — correct, since they were all hand-provisioned. last_seen_at
-- backs presence/last-active display; created_at already serves as first-seen.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','disabled'));
ALTER TABLE users ADD COLUMN last_seen_at TEXT;
