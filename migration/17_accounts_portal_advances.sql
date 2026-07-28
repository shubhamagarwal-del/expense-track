-- ============================================================
-- Migration 17 — Accounts Portal advances mirror
-- ============================================================
-- Stores advances received from the external Accounts Portal
-- (accounts-2026.vercel.app) via webhook + reconciliation pull.
--
-- Read-only mirror: Accounts Portal is source of truth. We never
-- write to it. Employees' balances here are informational — the
-- existing employee_advances table (manual, tied to cycle payments)
-- is independent and keeps working as before.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.accounts_portal_advances (
  id                  bigserial   PRIMARY KEY,
  advance_id          text        UNIQUE NOT NULL,  -- idempotency key from Accounts Portal
  event               text        NOT NULL CHECK (event IN ('given','refunded')),
  employee_number     text,                          -- SSS_xxxx — primary match key
  employee_name       text,
  recipient_id        text,                          -- Accounts Portal internal id
  amount              numeric(14,2) NOT NULL,
  advance_date        date,
  narration           text,
  bank_reference      text,
  bank                text,
  outstanding_after   numeric(14,2),                 -- employee's total outstanding after this row
  matched_employee_id uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  received_at         timestamptz  DEFAULT now(),
  raw_payload         jsonb                          -- keep the original for debugging / future fields
);

CREATE INDEX IF NOT EXISTS idx_apa_emp_no       ON public.accounts_portal_advances(employee_number);
CREATE INDEX IF NOT EXISTS idx_apa_matched      ON public.accounts_portal_advances(matched_employee_id);
CREATE INDEX IF NOT EXISTS idx_apa_advance_date ON public.accounts_portal_advances(advance_date DESC);

-- ── Row Level Security ─────────────────────────────────────
ALTER TABLE public.accounts_portal_advances ENABLE ROW LEVEL SECURITY;

-- Employees can read their own rows; admins/HR/audit/super_admin go through service_role (bypasses RLS)
CREATE POLICY "Employees see own portal advances"
  ON public.accounts_portal_advances FOR SELECT
  USING (auth.uid() = matched_employee_id);
