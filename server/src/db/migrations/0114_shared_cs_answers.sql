-- Scoped behavior opt-in, not an access grant. Existing eligibility remains required.
CREATE TABLE nonexclusive_bot_queues (
 conversation_id TEXT PRIMARY KEY REFERENCES shared_bot_queues(conversation_id),
 business_id TEXT NOT NULL REFERENCES business_teams(id)
);
INSERT INTO nonexclusive_bot_queues(conversation_id,business_id)
 SELECT q.conversation_id,c.business_team_id FROM shared_bot_queues q JOIN conversations c ON c.id=q.conversation_id
 WHERE c.business_team_id='5bcfe66f-1bc1-46fb-bc8d-bdc217fe3d86';
