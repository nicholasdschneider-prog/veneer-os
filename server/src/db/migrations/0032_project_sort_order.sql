-- Projects keep an explicit user-chosen position. Seed existing rows in the
-- same activity-first order the API used before this column existed, so the
-- migration itself does not unexpectedly reshuffle the sidebar.
ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT
    p.id,
    ROW_NUMBER() OVER (
      ORDER BY
        CASE WHEN MAX(c.last_active_at) IS NULL THEN 1 ELSE 0 END,
        MAX(c.last_active_at) DESC,
        p.created_at DESC,
        p.id
    ) - 1 AS position
  FROM projects p
  LEFT JOIN conversations c ON c.project_id = p.id AND c.archived = 0
  GROUP BY p.id
)
UPDATE projects
SET sort_order = (SELECT position FROM ranked WHERE ranked.id = projects.id);
