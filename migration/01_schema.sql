-- ============================================================
-- ExpenseTrack — Complete Schema
-- Run this in the NEW Supabase project's SQL Editor
-- ============================================================

-- ── companies ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.companies (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  code       text        UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- ── users ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
  id           uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        text        NOT NULL,
  role         text        NOT NULL DEFAULT 'employee'
                           CHECK (role IN ('employee','engineer','admin','super_admin')),
  name         text,
  emp_no       text,
  phone        text,
  site_name    text,
  department   text,
  company_id   uuid        REFERENCES public.companies(id),
  bank_holder  text,
  bank_name    text,
  bank_ifsc    text,
  bank_account text,
  created_at   timestamptz DEFAULT now()
);

-- ── expenses ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.expenses (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id       uuid        REFERENCES public.companies(id),
  amount           numeric     NOT NULL,
  approved_amount  numeric,
  category         text        NOT NULL,
  description      text,
  status           text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','l1_approved','l1_rejected','approved','rejected')),
  receipt_url      text,
  created_at       timestamptz DEFAULT now(),
  -- L1 (Manager) approval fields
  l1_status        text,
  l1_by            uuid,
  l1_by_name       text,
  l1_at            timestamptz,
  l1_remark        text,
  -- L2 (Super Admin) approval fields
  l2_status        text,
  l2_by            uuid,
  l2_by_name       text,
  l2_at            timestamptz,
  l2_remark        text,
  -- Shared
  rejection_reason text
);

-- ── Row Level Security ─────────────────────────────────────
ALTER TABLE public.users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

-- Users: everyone can read their own row; service_role bypasses RLS
CREATE POLICY "Users can read own row"
  ON public.users FOR SELECT
  USING (auth.uid() = id);

-- Admins need to read all users (done via service_role key from Node API — no extra policy needed)

-- Expenses: employees see their own; admins and super_admins need service_role (already bypasses)
CREATE POLICY "Users see own expenses"
  ON public.expenses FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own expenses"
  ON public.expenses FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own pending expenses"
  ON public.expenses FOR UPDATE
  USING (auth.uid() = user_id AND status = 'pending');

-- Companies: readable by all authenticated users (list is not sensitive)
CREATE POLICY "Authenticated users can read companies"
  ON public.companies FOR SELECT
  TO authenticated
  USING (true);

-- ── Storage bucket ─────────────────────────────────────────
-- Run from the Supabase Dashboard > Storage > New Bucket
-- Name: receipts, Public: true
-- OR uncomment and run the SQL below if your Supabase version supports it:

INSERT INTO storage.buckets (id, name, public)
VALUES ('receipts', 'receipts', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Authenticated users can upload receipts"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'receipts');

CREATE POLICY "Public can read receipts"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'receipts');

CREATE POLICY "Users can delete own receipts"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'receipts' AND auth.uid()::text = (storage.foldername(name))[1]);
