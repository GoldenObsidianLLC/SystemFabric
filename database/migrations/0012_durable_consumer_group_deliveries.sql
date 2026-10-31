-- SystemFabric 0.5.3: durable per-consumer-group outbox delivery.
-- The source event remains immutable in outbox_events; each consumer group gets
-- an independently leased delivery record with its own retry/dead-letter state.

CREATE TABLE IF NOT EXISTS outbox_consumer_groups (
  consumer_group text PRIMARY KEY
    CHECK (consumer_group ~ '^[a-z][a-z0-9._-]{0,99}$'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox_deliveries (
  event_id uuid NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
  consumer_group text NOT NULL REFERENCES outbox_consumer_groups(consumer_group) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','processed','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (event_id, consumer_group),
  CHECK (
    (status = 'processing' AND locked_by IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'processing' AND locked_by IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS outbox_deliveries_ready_idx
  ON outbox_deliveries(consumer_group, available_at, created_at, event_id)
  WHERE status IN ('pending','processing');

CREATE INDEX IF NOT EXISTS outbox_deliveries_group_status_idx
  ON outbox_deliveries(consumer_group, status, created_at, event_id);

CREATE INDEX IF NOT EXISTS outbox_events_aggregate_order_idx
  ON outbox_events(aggregate_type, aggregate_id, aggregate_version, created_at, id);
