-- Personal connector authorization follows the user who initiated each turn,
-- including turns that wait in the durable queue or resume after a restart.
ALTER TABLE queued_messages
  ADD COLUMN actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE pending_turns
  ADD COLUMN actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE conversation_wakeups
  ADD COLUMN actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

UPDATE queued_messages
   SET actor_user_id = (
     SELECT conversations.user_id
       FROM conversations
      WHERE conversations.id = queued_messages.conversation_id
   )
 WHERE actor_user_id IS NULL;

UPDATE pending_turns
   SET actor_user_id = (
     SELECT conversations.user_id
       FROM conversations
      WHERE conversations.id = pending_turns.conversation_id
   )
 WHERE actor_user_id IS NULL;

UPDATE conversation_wakeups
   SET actor_user_id = (
     SELECT conversations.user_id
       FROM conversations
      WHERE conversations.id = conversation_wakeups.conversation_id
   )
 WHERE actor_user_id IS NULL;
