-- SystemFabric 0.5.3: explicit event-type subscriptions for consumer groups.
-- Empty arrays represent an intentionally unsubscribed legacy group (fail closed).
ALTER TABLE outbox_consumer_groups
  ADD COLUMN IF NOT EXISTS event_types text[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE INDEX IF NOT EXISTS outbox_consumer_groups_event_types_idx
  ON outbox_consumer_groups USING GIN(event_types);

-- Pre-0.5.3 content workflow events reused the editorial revision number, so
-- submit/approve/publish transitions could share one aggregate_version. Re-sequence
-- historical content events in their original commit-time order, then advance the
-- canonical lock_version floor so future events continue that sequence.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY aggregate_id
           ORDER BY created_at, id
         )::integer AS sequence
    FROM outbox_events
   WHERE aggregate_type = 'content'
)
UPDATE outbox_events event
   SET aggregate_version = -ranked.sequence
  FROM ranked
 WHERE event.id = ranked.id;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY aggregate_id
           ORDER BY created_at, id
         )::integer AS sequence
    FROM outbox_events
   WHERE aggregate_type = 'content'
)
UPDATE outbox_events event
   SET aggregate_version = ranked.sequence
  FROM ranked
 WHERE event.id = ranked.id;

UPDATE content_items content
   SET lock_version = GREATEST(COALESCE(content.lock_version, 1), event_versions.max_sequence)
  FROM (
    SELECT aggregate_id, max(aggregate_version) AS max_sequence
      FROM outbox_events
     WHERE aggregate_type = 'content'
     GROUP BY aggregate_id
  ) event_versions
 WHERE content.id = event_versions.aggregate_id;
