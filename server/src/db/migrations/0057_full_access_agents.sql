-- Veneer hosts are dedicated agent machines. Existing and built-in agents
-- receive the same full machine access as newly created agents.
UPDATE assistants SET full_access = 1;
