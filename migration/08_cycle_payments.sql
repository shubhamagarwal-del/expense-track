-- ================================================================
-- ExpenseTrack — Cycle Payment Tracking
-- Run this in: Supabase > SQL Editor > Run
-- ================================================================
-- Records actual bank payments made against an employee's pay cycle.
-- Populated by importing the bank's NEFT/DCR confirmation report
-- (one row per processed transaction). Used to show Paid / Pending
-- amounts across the dashboard and to keep future payment sheets
-- limited to the still-unpaid balance.

CREATE TABLE IF NOT EXISTS public.cycle_payments (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  month_year   text        NOT NULL,                 -- e.g. "May 2026"
  cycle_num    smallint    NOT NULL CHECK (cycle_num IN (1, 2)),  -- 1 = 1st–15th, 2 = 16th–end
  amount_paid  numeric     NOT NULL,
  utr_number   text        NOT NULL,                 -- bank transaction reference
  bene_name    text,                                 -- beneficiary name as printed on the report (audit)
  payment_date date        NOT NULL DEFAULT CURRENT_DATE,
  paid_by      uuid        REFERENCES public.users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cycle_payments_user ON public.cycle_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_cycle_payments_utr  ON public.cycle_payments(utr_number);

-- One UTR can be split across at most one (user, month, cycle) line, and the
-- same bank report must never be importable twice. This guards re-imports.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cycle_payments_utr_cycle
  ON public.cycle_payments(utr_number, user_id, month_year, cycle_num);

ALTER TABLE public.cycle_payments ENABLE ROW LEVEL SECURITY;

-- All reads/writes go through the Node API using the service-role key,
-- which bypasses RLS. No client-facing policy is added (same pattern as
-- public.expense_views).
