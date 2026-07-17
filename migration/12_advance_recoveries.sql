-- ================================================================
-- ExpenseTrack — Partial Advance Recoveries
-- Run this in: Supabase > SQL Editor > Run
-- ================================================================
-- Logs each individual recovery event against an employee_advances row,
-- so one advance can be netted off across multiple payment cycles
-- (e.g. a ₹500 advance recovered as ₹200 this cycle, ₹300 next cycle)
-- instead of only being recoverable in one lump sum. employee_advances.amount
-- stays the original grant amount; "remaining" = amount minus the sum of
-- its recovery rows here.

CREATE TABLE IF NOT EXISTS public.employee_advance_recoveries (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id         uuid        NOT NULL REFERENCES public.employee_advances(id) ON DELETE CASCADE,
  amount             numeric     NOT NULL CHECK (amount > 0),
  recovered_at       timestamptz NOT NULL DEFAULT now(),
  recovered_by       uuid        REFERENCES public.users(id),
  recovered_by_name  text,
  note               text
);

CREATE INDEX IF NOT EXISTS idx_employee_advance_recoveries_advance ON public.employee_advance_recoveries(advance_id);

ALTER TABLE public.employee_advance_recoveries ENABLE ROW LEVEL SECURITY;

-- Audit / Super Admin write via service role key from the API; no client-side policy needed.
