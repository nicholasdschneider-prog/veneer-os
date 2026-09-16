-- A project may choose the agent new chats start with. NULL preserves the
-- site-wide default. The reference is nullable so removing an agent safely
-- returns affected projects to that site default.
ALTER TABLE projects
  ADD COLUMN default_assistant_id INTEGER REFERENCES assistants(id) ON DELETE SET NULL;
