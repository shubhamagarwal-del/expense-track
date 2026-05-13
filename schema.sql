-- ================================================================
-- ExpenseTrack – Multi-Level Approval & Bank Details Migration
-- Run this entire script in: Supabase > SQL Editor > Run
-- ================================================================

-- 1. Bank details columns on the users table
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS bank_holder  TEXT,
  ADD COLUMN IF NOT EXISTS bank_name    TEXT,
  ADD COLUMN IF NOT EXISTS bank_ifsc    TEXT,
  ADD COLUMN IF NOT EXISTS bank_account TEXT;

-- 2. Multi-level approval columns on the expenses table
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS approved_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS l1_status       TEXT    DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS l1_by           UUID,
  ADD COLUMN IF NOT EXISTS l1_by_name      TEXT,
  ADD COLUMN IF NOT EXISTS l1_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS l1_remark       TEXT,
  ADD COLUMN IF NOT EXISTS l2_status       TEXT    DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS l2_by           UUID,
  ADD COLUMN IF NOT EXISTS l2_by_name      TEXT,
  ADD COLUMN IF NOT EXISTS l2_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS l2_remark       TEXT;

-- 3. Allow employees to update their own bank details
-- (Skip if you already have a permissive RLS policy on users)
CREATE POLICY IF NOT EXISTS "Users can update own bank details"
  ON public.users
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);
