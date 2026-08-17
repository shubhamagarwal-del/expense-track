-- ============================================================
-- Migration 27 — Off-day expense justification
-- ============================================================
-- When an employee files an expense for a day they were marked
-- ABSENT on the face machine, submission is blocked UNLESS they
-- confirm a reason (e.g. "next-day travel — left at night for the
-- next day's site"). That one-click reason is stored here so Audit
-- can see the justification on the expense.
--
-- NULL  = normal expense (not on an absent day, or no attendance yet).
-- text  = employee's absent-day justification.
-- ============================================================

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS off_day_reason text;
