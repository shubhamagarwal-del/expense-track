-- ============================================================
-- ExpenseTrack — line_managers table
-- Run this once in Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.line_managers (
  id              UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  emp_code        TEXT         UNIQUE NOT NULL,        -- e.g. SSS_0160
  department      TEXT         NOT NULL,               -- must match users.department
  manager_name    TEXT         NOT NULL,
  contact_number  TEXT,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- Index for fast department lookups (used in approval routing)
CREATE INDEX IF NOT EXISTS idx_lm_department ON public.line_managers (department);

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lm_updated_at ON public.line_managers;
CREATE TRIGGER trg_lm_updated_at
  BEFORE UPDATE ON public.line_managers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Row Level Security ────────────────────────────────────────
ALTER TABLE public.line_managers ENABLE ROW LEVEL SECURITY;

-- All authenticated users (employees, admins) can read
CREATE POLICY "Authenticated users can read line_managers"
  ON public.line_managers FOR SELECT
  TO authenticated
  USING (true);

-- Only service role (API endpoints) can insert / update / delete
CREATE POLICY "Service role manages line_managers"
  ON public.line_managers FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── Seed data (16 records) ────────────────────────────────────
INSERT INTO public.line_managers (emp_code, department, manager_name, contact_number) VALUES
  ('SSS_0160', 'O&M',                          'Chirag Panchal',                       '7732917204'),
  ('SSS_0010', 'Lease',                        'Vijay Singh',                          '9352523904'),
  ('SSS_0024', 'Liaison',                      'Pintu Bairwa (Arun Sir)',               '7891054848'),
  ('SSS_0058', 'Compliance',                   'Bhukima Kudiwal',                      '7062047980'),
  ('SSS_0064', 'Accounts',                     'Peyush Kedia',                         '8875533830'),
  ('SSS_0020', 'Project - Roof Top, Design',   'Ashok Bharia',                         '9529408901'),
  ('SSS_0268', 'Project',                      'Pawan Raj Koodi',                      '9928096564'),
  ('SSS_0060', 'Project',                      'Sagar Gurjar',                         '9079370762'),
  ('SSS_0113', 'HR & Admin',                   'Navneet Singh',                        '9929986281'),
  ('SSS_0050', 'Legal',                        'Ritika Sharma (Arun Sir)',             '9821585878'),
  ('SSS_0053', 'Procurement',                  'Shubham Maheshwari',                   '7014635743'),
  ('SSS_0206', 'Procurement',                  'Rohit Sharma',                         '9983804321'),
  ('SSS_0137', 'Transmission Line',            'Ramgopal Sharma',                      '9461251687'),
  ('SSS_0197', 'Logistics & Supply Chain',     'Ashok Jat',                            '7728871812'),
  ('SSS_0189', 'Internal Audit & A/C Payable', 'Anita',                                '8058940971'),
  ('SSS_0309', 'Sales',                        'Prashant Kumar Singh (Durgesh Sir)',   '6391116991')
ON CONFLICT (emp_code) DO UPDATE SET
  department     = EXCLUDED.department,
  manager_name   = EXCLUDED.manager_name,
  contact_number = EXCLUDED.contact_number,
  updated_at     = NOW();

-- Verify
SELECT emp_code, department, manager_name, contact_number FROM public.line_managers ORDER BY department;
