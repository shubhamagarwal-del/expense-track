-- ============================================================
-- Migration 18 — Accounts Portal pushed-claims tracking
-- ============================================================
-- Records each expense-report claim pushed FROM ExpenseTrack TO the
-- Accounts Portal (accounts-2026.vercel.app) via the one-click Push.
-- Lets the UI show "Pushed ✓ / Already pushed" status per cycle and
-- keeps the portal-returned claim_id for reference.
--
-- The Accounts Portal is idempotent by (employee + month + cycle), so
-- this table mirrors that key. Push itself stays server-side (the
-- x-api-key never reaches the browser).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.accounts_portal_claims (
  id                bigserial   PRIMARY KEY,
  user_id           uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  employee_number   text,
  employee_name     text,
  month_year        text        NOT NULL,   -- "July 2026"
  cycle_text        text        NOT NULL,   -- "1st - 15th" | "16th - End"
  claim_id          text,                    -- Accounts Portal's claim uuid (null if 409/failed)
  status            text        NOT NULL DEFAULT 'pushed',  -- pushed | already_exists | failed
  lines             integer,
  submitted_total   numeric(14,2),
  approved_total    numeric(14,2),
  pushed_by         uuid,
  pushed_by_name    text,
  pushed_at         timestamptz DEFAULT now(),
  response          jsonb,                   -- full portal response for debugging
  UNIQUE (user_id, month_year, cycle_text)
);

CREATE INDEX IF NOT EXISTS idx_apc_user  ON public.accounts_portal_claims(user_id);
CREATE INDEX IF NOT EXISTS idx_apc_cycle ON public.accounts_portal_claims(month_year, cycle_text);

-- Admin-side roles read/write via service_role (bypasses RLS). Employees don't touch this.
ALTER TABLE public.accounts_portal_claims ENABLE ROW LEVEL SECURITY;
