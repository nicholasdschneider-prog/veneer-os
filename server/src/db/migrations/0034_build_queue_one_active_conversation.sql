-- One chat can do only one source build at a time. Consolidate any duplicate
-- active rows created before this invariant was enforced, then protect it at
-- the database layer as well as in the coordinator.
CREATE TEMP TABLE build_queue_duplicate_groups AS
SELECT conversation_id, MIN(id) AS keeper_id
FROM build_queue
WHERE status IN ('queued', 'running', 'failed')
GROUP BY conversation_id
HAVING COUNT(*) > 1;

UPDATE build_queue AS keeper
SET brief = brief || (
  SELECT group_concat(char(10) || char(10) || 'Additional queued request: ' || title || char(10) || char(10) || brief, '')
  FROM (
    SELECT duplicate.title, duplicate.brief
    FROM build_queue AS duplicate
    WHERE duplicate.conversation_id = keeper.conversation_id
      AND duplicate.status IN ('queued', 'running', 'failed')
      AND duplicate.id <> keeper.id
    ORDER BY duplicate.id
  )
)
WHERE keeper.id IN (SELECT keeper_id FROM build_queue_duplicate_groups);

-- If the kept row was already dispatched, a runner restart will resume from
-- pending_turns rather than rebuilding its prompt from build_queue. Carry the
-- consolidated work into that durable prompt too so no queued request is lost.
UPDATE pending_turns AS pending
SET prompt = prompt || (
  SELECT group_concat(char(10) || char(10) || 'Additional queued request: ' || duplicate.title || char(10) || char(10) || duplicate.brief, '')
  FROM build_queue_duplicate_groups AS groups
  JOIN build_queue AS duplicate ON duplicate.conversation_id = groups.conversation_id
  WHERE groups.conversation_id = pending.conversation_id
    AND duplicate.id <> groups.keeper_id
    AND duplicate.status IN ('queued', 'running', 'failed')
)
WHERE pending.conversation_id IN (
  SELECT groups.conversation_id
  FROM build_queue_duplicate_groups AS groups
  JOIN build_queue AS keeper ON keeper.id = groups.keeper_id
  WHERE keeper.status = 'running'
);

UPDATE build_queue AS duplicate
SET status = 'skipped',
    error = 'Consolidated into build #' || (
      SELECT keeper_id
      FROM build_queue_duplicate_groups AS groups
      WHERE groups.conversation_id = duplicate.conversation_id
    ),
    finished_at = datetime('now')
WHERE duplicate.status IN ('queued', 'running', 'failed')
  AND EXISTS (
    SELECT 1
    FROM build_queue_duplicate_groups AS groups
    WHERE groups.conversation_id = duplicate.conversation_id
      AND groups.keeper_id <> duplicate.id
  );

DROP TABLE build_queue_duplicate_groups;

CREATE UNIQUE INDEX idx_build_queue_one_active_conversation
ON build_queue(conversation_id)
WHERE status IN ('queued', 'running', 'failed');
