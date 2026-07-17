-- ================================================================
-- ExpenseTrack — Employee Advances
-- Run this in: Supabase > SQL Editor > Run
-- ================================================================
-- Tracks advance payments given to employees outside the normal
-- expense-approve-then-pay cycle. Outstanding advances are subtracted
-- from an employee's computed "Due" amount everywhere it's shown, so
-- they don't get paid twice for the same money.

CREATE TABLE IF NOT EXISTS public.employee_advances (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  amount             numeric     NOT NULL CHECK (amount > 0),
  given_at           date        NOT NULL DEFAULT CURRENT_DATE,
  given_by           uuid        REFERENCES public.users(id),
  given_by_name      text,
  note               text,
  status             text        NOT NULL DEFAULT 'outstanding' CHECK (status IN ('outstanding','recovered')),
  recovered_at       timestamptz,
  recovered_by       uuid        REFERENCES public.users(id),
  recovered_by_name  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employee_advances_user ON public.employee_advances(user_id);
CREATE INDEX IF NOT EXISTS idx_employee_advances_status ON public.employee_advances(status);

ALTER TABLE public.employee_advances ENABLE ROW LEVEL SECURITY;

-- Audit / Super Admin write via service role key from the API; employees
-- read their own outstanding total via the same API (also service role).
-- No client-side policy needed.
