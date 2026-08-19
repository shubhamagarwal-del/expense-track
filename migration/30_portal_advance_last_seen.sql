-- ═══════════════════════════════════════════════════════════════════
-- Migration 30 — self-healing Accounts-Portal advance mirror
--
-- WHY
-- `accounts_portal_advances` is our local mirror of the Accounts Portal's
-- advance ledger (we mirror it because the portal API is slow/flaky, so pages
-- must not read it live). The mirror could drift ABOVE the portal in two ways:
--
--   1. Duplicates — an older sync keyed rows by the portal's own entry id while
--      the current one keys them by a deterministic `ACCT-…` id, so the same
--      advance got inserted twice under two different ids.
--   2. Phantoms — the portal reversed/corrected an advance, but our sync only
--      ever added/updated rows and never noticed the disappearance.
--
-- Both were cleaned up manually once (30 rows, backed up to
-- _backup_adv_cleanup_*.json). This migration is what stops it recurring.
--
-- HOW
-- Each reconcile run stamps `last_seen_at` on every entry the portal currently
-- returns. The read path (`?portal_advances=1`) then serves, per employee, only
-- the rows carrying that employee's newest stamp. An entry the portal has
-- dropped simply stops being re-stamped and falls out of every view — without
-- deleting anything, so the row stays auditable and the change is reversible.
--
-- Backward-safe: existing rows start NULL, and an employee with no stamped rows
-- is passed through unfiltered, so nothing changes until the first stamped sync.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE accounts_portal_advances
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

COMMENT ON COLUMN accounts_portal_advances.last_seen_at IS
  'Stamp of the last reconcile run in which the Accounts Portal still reported this entry. Rows not carrying their employee''s newest stamp are treated as retired (portal reversed them) and are filtered out on read.';

-- Read path filters per employee by this stamp.
CREATE INDEX IF NOT EXISTS idx_portal_adv_last_seen
  ON accounts_portal_advances (employee_number, last_seen_at DESC);
