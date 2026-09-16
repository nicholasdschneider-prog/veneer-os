-- Record whether Veneer sends an OAuth scope snapshot or only validates the
-- provider-managed default. Existing access profiles used explicit scopes.
ALTER TABLE connector_auth_configs
  ADD COLUMN oauth_scope_strategy TEXT NOT NULL DEFAULT 'explicit'
    CHECK (oauth_scope_strategy IN ('explicit', 'managed_default'));
