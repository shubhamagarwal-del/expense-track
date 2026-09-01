-- ============================================================
-- GRN (Goods Receipt Note) — employee submission + the same
-- Manager(L1) → HR → Audit review chain expenses already use.
-- Run this in the Supabase SQL Editor.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.grn_entries (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id       uuid        REFERENCES public.companies(id),
  site_code        text,
  site_name        text,
  received_date    date        NOT NULL,
  po_number        text,
  vendor_name      text        NOT NULL,
  items            jsonb       NOT NULL, -- [{ "item": "...", "qty": "..." }, ...] — one invoice can cover several items
  receipt_url      text,
  status           text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','l1_approved','l1_rejected','hr_approved','audit_cleared','rejected')),
  created_at       timestamptz DEFAULT now(),
  -- L1 (Manager) review
  l1_by            uuid,
  l1_by_name       text,
  l1_at            timestamptz,
  l1_remark        text,
  -- HR review
  hr_by            uuid,
  hr_by_name       text,
  hr_at            timestamptz,
  hr_remark        text,
  -- Audit review
  audit_by         uuid,
  audit_by_name    text,
  audit_at         timestamptz,
  audit_remark     text,
  -- Shared
  rejection_reason text
);

CREATE INDEX IF NOT EXISTS idx_grn_user   ON public.grn_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_grn_status ON public.grn_entries(status);

ALTER TABLE public.grn_entries ENABLE ROW LEVEL SECURITY;

-- Employees see their own GRNs; Manager/HR/Audit/Super Admin see all
-- (department/company scoping for the Manager role is applied client-side
-- and server-side, same as expenses — this policy just grants read access).
CREATE POLICY "Users see own or reviewable grn entries"
  ON public.grn_entries FOR SELECT
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('admin','hr','audit','super_admin')
    )
  );

CREATE POLICY "Users insert own grn entries"
  ON public.grn_entries FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Approvals/rejections go through /api/approve-expense (service-role key,
-- bypasses RLS) — no client-side UPDATE policy needed.
