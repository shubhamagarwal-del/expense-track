-- ============================================================
-- Travel Desk role + Pre-booked Travel registry.
-- Travel Desk logs a ticket (train/flight) it books centrally for an
-- employee on a given date; the employee is then blocked from also
-- submitting a Travel expense claim for that same date.
-- Run this in the Supabase SQL Editor.
-- ============================================================

-- The original CHECK constraint only listed employee/engineer/admin/
-- super_admin — hr/audit were added to the live DB by hand at some point
-- without a matching migration. Rebuild it here with the full real list
-- plus travel_desk, so it actually reflects what the app uses.
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check
  CHECK (role IN ('employee','engineer','admin','super_admin','hr','audit','travel_desk'));

-- Travel Desk needs to read the employee list (name/emp_no) to pick who a
-- ticket is for — same broad-read need admin/hr/audit/super_admin already
-- have for this table (however that's currently granted; this just adds
-- travel_desk to it without touching the existing policy).
CREATE POLICY "Travel desk reads all users"
  ON public.users FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role = 'travel_desk'
    )
  );

CREATE TABLE IF NOT EXISTS public.prebooked_travel (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  travel_date   date        NOT NULL,
  route         text        NOT NULL,
  mode          text        NOT NULL CHECK (mode IN ('train','flight','bus','other')),
  ticket_ref    text,
  added_by      uuid        REFERENCES public.users(id),
  added_by_name text,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prebooked_travel_user_date ON public.prebooked_travel(user_id, travel_date);

ALTER TABLE public.prebooked_travel ENABLE ROW LEVEL SECURITY;

-- Employees need to read their own rows client-side to self-block a
-- duplicate claim at submission time. Travel Desk + reviewer roles read/write everything.
CREATE POLICY "Users see own or manage prebooked travel"
  ON public.prebooked_travel FOR SELECT
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('travel_desk','admin','hr','audit','super_admin')
    )
  );

CREATE POLICY "Travel desk and reviewers insert prebooked travel"
  ON public.prebooked_travel FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('travel_desk','admin','hr','audit','super_admin')
    )
  );

CREATE POLICY "Travel desk and reviewers delete prebooked travel"
  ON public.prebooked_travel FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role IN ('travel_desk','admin','hr','audit','super_admin')
    )
  );
