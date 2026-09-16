-- Project root folder (2026-07-06): a project may point at any absolute
-- directory on the system instead of the default workspaces/projects/<slug>.
-- NULL = the default. Like the slug, root_dir is fixed at creation: chats'
-- native CLI sessions are keyed by their working directory, so moving a
-- project's folder would orphan every chat's history. Deleting a project with
-- a custom root_dir never removes the folder (it's the user's, not ours).
ALTER TABLE projects ADD COLUMN root_dir TEXT;
