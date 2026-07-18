-- ================================================================
-- ExpenseTrack — Carry Audit's flag reason onto the resubmitted entry
-- Run this in: Supabase > SQL Editor > Run
-- ================================================================
-- When an employee fixes and resubmits an audit_query expense, a fresh
-- pending row is created (the old one is kept as 'superseded'). Without
-- this, Audit had no way to tell — once the new row works its way back
-- to hr_approved — that it was actually a fix for something they'd
-- flagged, or what the original issue even was. This carries that
-- reason forward onto the new row.

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS resubmitted_note text;
