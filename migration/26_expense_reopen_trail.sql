-- 26: Audit re-review (reopen) trail
-- Records who sent an audit-cleared expense back into review, and when.
-- Set by /api/approve-expense on the `reopen_audit` action; the dashboard
-- shows "Re-reviewed by <name>" next to such an entry.
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS reopened_by      uuid,
  ADD COLUMN IF NOT EXISTS reopened_by_name text,
  ADD COLUMN IF NOT EXISTS reopened_at      timestamptz;
