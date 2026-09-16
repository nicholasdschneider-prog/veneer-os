-- AI-generated conversation titles (2026-07-05). Claude Code writes a rolling
-- "ai-title" summary into its own session transcript as a conversation
-- progresses; the manager mirrors it into conversations.title after each turn.
-- title_auto tracks whether that mirroring still owns the title (1) or the
-- user has renamed the conversation via PATCH, which should stick (0).
ALTER TABLE conversations ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 1;
