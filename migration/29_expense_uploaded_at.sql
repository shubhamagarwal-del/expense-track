-- ============================================================
-- Migration 29 — Real upload timestamp on expenses
-- ============================================================
-- expenses.created_at is deliberately set to the EXPENSE DATE (the day the
-- expense is for), so entries group/sort under their day. That means the
-- "Uploaded" date shown to admins was the expense date, NOT when the employee
-- actually submitted it.
--
-- uploaded_at captures the REAL submission time (DB default now() on insert).
-- Existing rows stay NULL (their true upload time is unrecoverable) → the UI
-- falls back to created_at for them; every NEW upload gets the real time.
--
-- Two statements so ADD COLUMN does NOT backfill existing rows with now():
-- ============================================================

ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS uploaded_at timestamptz;
ALTER TABLE public.expenses ALTER COLUMN uploaded_at SET DEFAULT now();
