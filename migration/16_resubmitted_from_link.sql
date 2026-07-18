-- ================================================================
-- ExpenseTrack — Link a resubmitted entry back to the one it replaced
-- Run this in: Supabase > SQL Editor > Run
-- ================================================================
-- resubmitted_note (migration 15) carries the audit's reason forward, but
-- there was still no way to tell, from the UI, which "old, outdated"
-- (superseded) entry a given new entry actually replaced, or vice versa.
-- This adds an explicit link so both sides can show each other.

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS resubmitted_from uuid REFERENCES public.expenses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_resubmitted_from ON public.expenses(resubmitted_from);
