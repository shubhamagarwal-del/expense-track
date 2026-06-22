-- ================================================================
-- ExpenseTrack — Receipt View Audit Log
-- Run this in: Supabase > SQL Editor > Run
-- ================================================================
-- Records which admin opened which expense's receipt and when.
-- Used to enforce "must view receipt before approving" and to
-- show a "Seen at X" tick next to each receipt link.

CREATE TABLE IF NOT EXISTS public.expense_views (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid        NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES public.users(id)    ON DELETE CASCADE,
  viewed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (expense_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_expense_views_expense ON public.expense_views(expense_id);
CREATE INDEX IF NOT EXISTS idx_expense_views_user    ON public.expense_views(user_id);

ALTER TABLE public.expense_views ENABLE ROW LEVEL SECURITY;

-- Admins / super admins write via service role key from the API; no client policy needed.
