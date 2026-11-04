-- Durable AI queue payloads are encrypted with an externally managed AES-256-GCM key.
-- Task metadata remains in ai_tasks; raw input and output are never stored in plaintext.
CREATE TABLE IF NOT EXISTS ai_task_queue (
  task_id uuid PRIMARY KEY REFERENCES ai_tasks(id) ON DELETE CASCADE,
  payload_nonce bytea,
  payload_ciphertext bytea,
  payload_tag bytea,
  result_nonce bytea,
  result_ciphertext bytea,
  result_tag bytea,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  claim_token uuid,
  lease_expires_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,100}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (payload_nonce IS NULL AND payload_ciphertext IS NULL AND payload_tag IS NULL)
    OR
    (payload_nonce IS NOT NULL AND payload_ciphertext IS NOT NULL AND payload_tag IS NOT NULL
     AND octet_length(payload_nonce) = 12
     AND octet_length(payload_ciphertext) BETWEEN 1 AND 131072
     AND octet_length(payload_tag) = 16)
  ),
  CHECK (
    (result_nonce IS NULL AND result_ciphertext IS NULL AND result_tag IS NULL)
    OR
    (result_nonce IS NOT NULL AND result_ciphertext IS NOT NULL AND result_tag IS NOT NULL
     AND octet_length(result_nonce) = 12
     AND octet_length(result_ciphertext) BETWEEN 1 AND 131072
     AND octet_length(result_tag) = 16)
  ),
  CHECK (
    (locked_by IS NULL AND claim_token IS NULL AND lease_expires_at IS NULL)
    OR
    (locked_by IS NOT NULL AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (result_ciphertext IS NULL OR payload_ciphertext IS NULL)
);

CREATE INDEX IF NOT EXISTS ai_task_queue_available_idx
  ON ai_task_queue(available_at, created_at, task_id)
  WHERE payload_ciphertext IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_task_queue_expired_lease_idx
  ON ai_task_queue(lease_expires_at, task_id)
  WHERE claim_token IS NOT NULL;
