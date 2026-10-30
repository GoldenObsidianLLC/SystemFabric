-- SystemFabric 0.5.2: canonical metadata for durable PostgreSQL outbox events.
-- Keep the existing outbox_events.id as the stable eventId. The aggregate uniqueness
-- constraint remains the producer idempotency key for one event type/version.

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS schema_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES sites(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS correlation_id text,
  ADD COLUMN IF NOT EXISTS causation_id uuid,
  ADD COLUMN IF NOT EXISTS classification text NOT NULL DEFAULT 'internal';

-- Backfill site scope from the payloads written by the 0.5.1 content and relationship stores.
-- The regex guard prevents invalid legacy text from reaching the UUID cast.
UPDATE outbox_events
   SET site_id = (payload->>'siteId')::uuid
 WHERE site_id IS NULL
   AND jsonb_typeof(payload) = 'object'
   AND COALESCE(payload->>'siteId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

UPDATE outbox_events
   SET classification = CASE WHEN site_id IS NULL THEN 'internal' ELSE 'site-private' END
 WHERE classification = 'internal';

DO $$ BEGIN
  ALTER TABLE outbox_events
    ADD CONSTRAINT outbox_events_schema_version_check CHECK (schema_version >= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE outbox_events
    ADD CONSTRAINT outbox_events_classification_check
      CHECK (classification IN ('internal','site-private','public'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE outbox_events
    ADD CONSTRAINT outbox_events_correlation_id_check
      CHECK (correlation_id IS NULL OR length(correlation_id) BETWEEN 1 AND 128);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE outbox_events
    ADD CONSTRAINT outbox_events_site_scope_check
      CHECK (classification = 'internal' OR site_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS outbox_site_created_idx
  ON outbox_events(site_id,created_at,id)
  WHERE site_id IS NOT NULL;
