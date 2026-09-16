-- Build queues serialize writes per workspace instead of across the whole app.
-- Every pre-existing queue item came from Platform Dev, so it belongs to the
-- one live Veneer Pro source checkout.
ALTER TABLE build_queue ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'source';

DROP INDEX idx_build_queue_one_running;
DROP INDEX idx_build_queue_fifo;

CREATE INDEX idx_build_queue_fifo ON build_queue(scope_key, status, id);
CREATE UNIQUE INDEX idx_build_queue_one_running_scope
ON build_queue(scope_key)
WHERE status = 'running';
