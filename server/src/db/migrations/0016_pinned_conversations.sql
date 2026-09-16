-- Pinned chats (2026-07-20). One nullable column carries both the flag and the
-- manual order: NULL = not pinned; otherwise lower sorts first. New pins take
-- MIN-1 (land on top); drag-reorder renumbers 0..n-1 via PUT /conversations/pins.
ALTER TABLE conversations ADD COLUMN pin_order INTEGER;
