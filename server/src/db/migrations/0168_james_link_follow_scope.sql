-- James link: registered bots' standing chats mention James constantly and were
-- auto-followed by the 0167 backfill. They are followed only on James's request.
-- A question waits on James only in a thread he started or follows.
UPDATE james_threads
   SET followed = 0
 WHERE started_by <> 'james'
   AND conversation_id IN (SELECT conversation_id FROM bot_registrations);
UPDATE james_threads
   SET status = 'open', question_since = NULL
 WHERE status = 'waiting_on_james' AND started_by <> 'james' AND followed = 0;
