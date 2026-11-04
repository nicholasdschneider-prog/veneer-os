-- Every queued wake start resolves its receipt by chat and message. Without this
-- index, each lookup scanned all wake-ups on the runner's event loop.
CREATE INDEX idx_hub_inbound_message ON hub_inbound_messages(conversation_id, message_id);
