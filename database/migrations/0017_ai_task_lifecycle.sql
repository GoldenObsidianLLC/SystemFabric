-- Persist metadata-only AI task state for tenant-scoped status visibility.
-- Prompt text, context and model output are deliberately not stored in this table.
CREATE TABLE IF NOT EXISTS ai_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 128),
  task_type text NOT NULL CHECK (task_type IN ('page_draft','content_assist','seo','translate')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','cancelled','blocked')),
  provider text,
  model text,
  input_chars integer NOT NULL DEFAULT 0 CHECK (input_chars >= 0),
  output_chars integer NOT NULL DEFAULT 0 CHECK (output_chars >= 0),
  latency_ms integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,100}$'),
  task_version integer NOT NULL DEFAULT 1 CHECK (task_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'queued' AND started_at IS NULL AND completed_at IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('succeeded','failed','cancelled','blocked') AND completed_at IS NOT NULL)
  ),
  CHECK (status <> 'succeeded' OR error_code IS NULL)
);

CREATE INDEX IF NOT EXISTS ai_tasks_site_actor_created_idx
  ON ai_tasks(site_id, actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_tasks_site_status_updated_idx
  ON ai_tasks(site_id, status, updated_at DESC);
