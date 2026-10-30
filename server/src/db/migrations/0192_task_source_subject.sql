-- The OrderOps ticket subject behind a task, kept by the status sweep so the board can link the order it names.
ALTER TABLE bot_task_source_status ADD COLUMN subject TEXT;
