-- Preserve Stripe's paused subscription state in the membership domain.
-- Webhook snapshots can arrive out of order, so handlers reconcile the current
-- subscription from Stripe rather than comparing second-resolution event.created.
ALTER TABLE paid_memberships
  DROP CONSTRAINT IF EXISTS paid_memberships_status_check;

ALTER TABLE paid_memberships
  ADD CONSTRAINT paid_memberships_status_check
  CHECK (status IN ('pending','active','past_due','cancelled','expired','paused'));
