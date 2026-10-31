-- F1.9: draft-only collaboration sequencing and bounded accepted-operation replay.
-- A separate collaboration sequence is intentionally independent of editorial version
-- and the content aggregate lock_version used by the outbox projector.

CREATE TABLE IF NOT EXISTS content_collaboration_documents (
  content_id uuid PRIMARY KEY REFERENCES content_items(id) ON DELETE CASCADE,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  oldest_replay_sequence bigint NOT NULL DEFAULT 0
    CHECK (oldest_replay_sequence >= 0 AND oldest_replay_sequence <= sequence),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content_collaboration_operations (
  content_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence >= 1),
  op_id uuid NOT NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  original_operation jsonb NOT NULL CHECK (jsonb_typeof(original_operation) = 'object'),
  applied_operation jsonb NOT NULL CHECK (jsonb_typeof(applied_operation) = 'object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_id, sequence),
  UNIQUE (content_id, op_id),
  CHECK (original_operation->>'opId' = op_id::text),
  CHECK (applied_operation->>'opId' = op_id::text)
);

CREATE INDEX IF NOT EXISTS content_collaboration_operations_actor_idx
  ON content_collaboration_operations(content_id, actor_id, created_at DESC);

-- Compact idempotency tombstones survive replay-window pruning. They are reset
-- only when a whole-document save establishes a new collaboration checkpoint.
CREATE TABLE IF NOT EXISTS content_collaboration_operation_keys (
  content_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  op_id uuid NOT NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  operation_hash text NOT NULL CHECK (length(operation_hash)=64 AND operation_hash ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_id, op_id)
);

-- Workflow evidence already had a checked action vocabulary. Add the semantic
-- collaboration event explicitly rather than writing undocumented action names.
ALTER TABLE workflow_events
  DROP CONSTRAINT IF EXISTS workflow_events_action_check;

ALTER TABLE workflow_events
  ADD CONSTRAINT workflow_events_action_check
  CHECK (action IN (
    'draft_saved',
    'submitted_for_review',
    'approved',
    'rejected',
    'scheduled',
    'published',
    'unpublished',
    'archived',
    'restored',
    'collaboration_operation'
  ));
