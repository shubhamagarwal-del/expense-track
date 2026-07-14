-- ================================================================
-- ExpenseTrack — Soft Delete for Expenses
-- Run this in: Supabase > SQL Editor > Run
-- ================================================================
-- Deleting an expense (by admin/manager/hr/audit/super_admin) no longer
-- hard-removes the row — it's marked status='deleted' with who/when/why,
-- so the employee can still see it happened and why, instead of the
-- expense silently vanishing from their history.

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS deleted_at      timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by      uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS deleted_by_name text,
  ADD COLUMN IF NOT EXISTS deleted_reason  text;

-- Allow the new 'deleted' status value (the status CHECK constraint was
-- expanded over time beyond the original 01_schema.sql list — this adds
-- 'deleted' on top of every status value the app currently uses).
ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_status_check;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_status_check
  CHECK (status IN (
    'pending','l1_approved','l1_rejected','approved','rejected',
    'hr_approved','audit_review','audit_cleared','deleted'
  ));
