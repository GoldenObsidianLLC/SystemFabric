-- Correct the content route slug character class. The previous expression put a
-- hyphen between '_' and '/', which PostgreSQL interpreted as an invalid range.
-- This is a forward migration: do not edit 0001_initial.sql after it has been applied.
ALTER TABLE content_items
  DROP CONSTRAINT IF EXISTS content_items_slug_check;

ALTER TABLE content_items
  ADD CONSTRAINT content_items_slug_check
  CHECK (slug ~ '^[a-z0-9][a-z0-9_/-]{0,240}$');
