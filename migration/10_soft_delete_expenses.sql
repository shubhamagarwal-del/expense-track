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
