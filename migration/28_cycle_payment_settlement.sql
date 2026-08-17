-- ============================================================
-- Migration 28 — Settlement breakdown on cycle payments
-- ============================================================
-- The Accounts Portal now returns, per reimbursed claim, HOW a cycle was
-- settled: how much was adjusted against an advance, how much was paid in
-- cash, and how much is still remaining (plus the per-event references).
-- We store that here so ExpenseTrack — and each employee — can see exactly
-- how their cycle settled, instead of a flat "paid" amount.
--
--   advance_adjusted + cash_paid + remaining = the cycle's approved total.
--   settlement (jsonb) keeps the full object incl. adjustments[] (advance
--   reference / wallet / date, cash bank UTR, advance_id).
-- ============================================================

ALTER TABLE public.cycle_payments
  ADD COLUMN IF NOT EXISTS advance_adjusted  numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_paid         numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remaining         numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS settlement_status text,
  ADD COLUMN IF NOT EXISTS settlement        jsonb;
