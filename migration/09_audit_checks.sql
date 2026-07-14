-- ================================================================
-- ExpenseTrack — Audit "Checked" Marker
-- Run this in: Supabase > SQL Editor > Run
-- ================================================================
-- Lets the Audit team mark an expense as "reviewed for payment"
-- independent of its approval-workflow status — used to track which
-- expenses they've already looked at while processing payments,
-- separate from the l1/hr/audit approval stages.

CREATE TABLE IF NOT EXISTS public.expense_audit_checks (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id     uuid        NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  checked_by     uuid        NOT NULL REFERENCES public.users(id)    ON DELETE CASCADE,
  checked_by_name text,
  checked_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (expense_id)
);

CREATE INDEX IF NOT EXISTS idx_audit_checks_expense ON public.expense_audit_checks(expense_id);

ALTER TABLE public.expense_audit_checks ENABLE ROW LEVEL SECURITY;

-- Audit / super admin write via service role key from the API; no client policy needed.
