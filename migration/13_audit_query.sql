-- ================================================================
-- ExpenseTrack — Audit Query (send an expense back to the Employee)
-- Run this in: Supabase > SQL Editor > Run
-- ================================================================
-- Audit already had a way to flag an hr_approved expense back to HR
-- ('audit_review' status, using the existing audit_note column). This adds
-- a second option: flag it straight back to the Employee for correction
-- ('audit_query' status) — the employee edits and resubmits it (same
-- mechanism as a rejected expense), which restarts the full Manager → HR
-- → Audit approval chain.

ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_status_check;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_status_check
  CHECK (status IN (
    'pending','l1_approved','l1_rejected','approved','rejected',
    'hr_approved','audit_review','audit_cleared','audit_query','deleted'
  ));
