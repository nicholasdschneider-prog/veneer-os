-- Custom fonts (2026-08-03): licensed font files an owner uploads so published
-- pages and apps can use a brand typeface that Google Fonts does not carry.
-- Each font file is one object in the SAME R2 bucket as pages, under the key
-- `f/<id>/<file_name>`. That prefix is deliberately outside `p/`, which is the
-- only prefix the seven-day page-expiry lifecycle rule touches (pages/r2.ts),
-- so font objects never expire. Rows carry only metadata — the bytes live in R2.
--
-- `family` is what an agent writes in CSS (`font-family: "Harman Sans"`); the
-- brand's headingFont/font values are matched against it case-insensitively to
-- decide whether a family is a hosted custom font or a Google Fonts name.
CREATE TABLE page_fonts (
  id           TEXT PRIMARY KEY,
  family       TEXT NOT NULL,
  weight       TEXT NOT NULL DEFAULT '400',
  style        TEXT NOT NULL DEFAULT 'normal' CHECK (style IN ('normal', 'italic')),
  file_name    TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  object_key   TEXT NOT NULL UNIQUE,
  public_url   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_page_fonts_family ON page_fonts(family);
