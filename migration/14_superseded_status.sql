-- ================================================================
-- ExpenseTrack — Superseded Status (preserve resubmit history)
-- Run this in: Supabase > SQL Editor > Run
-- ================================================================
-- Previously, "Fix and resubmit" (on a rejected/l1_rejected/audit_query
-- expense) hard-deleted the old row and inserted a fresh pending one —
-- the original submission, the rejection reason, and the audit_note were
-- permanently lost with no trace. Now the old row is kept, marked
-- status='superseded', so Audit/HR/the employee can still see what was
-- originally submitted and why it was sent back.

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_status_check;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_status_check
  CHECK (status IN (
    'pending','l1_approved','l1_rejected','approved','rejected',
    'hr_approved','audit_review','audit_cleared','audit_query','deleted','superseded'
  ));
