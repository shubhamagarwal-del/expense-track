-- ============================================================
-- Migration 22 — Realtime updates for check-in pages
-- ============================================================
-- Lets the admin Site Check-ins page and the employee Location Request page
-- update LIVE (Supabase Realtime) when a check-in or request row changes.
-- Realtime respects RLS, so the subscribing user needs SELECT access:
--   • admin roles → all check-ins + all push_checks
--   • employees   → their own push_checks (to see a new HR request instantly)
-- ============================================================

-- Admin roles can read check-ins directly (was API/service-role only)
CREATE POLICY "Admin roles read check-ins"
  ON public.attendance_checkins FOR SELECT
  USING ((SELECT role FROM public.users WHERE id = auth.uid()) IN ('admin','hr','audit','super_admin'));

-- Admin roles can read push checks
CREATE POLICY "Admin roles read push checks"
  ON public.push_checks FOR SELECT
  USING ((SELECT role FROM public.users WHERE id = auth.uid()) IN ('admin','hr','audit','super_admin'));

-- Employees can read their own push checks (new HR request appears instantly)
CREATE POLICY "Employees read own push checks"
  ON public.push_checks FOR SELECT
  USING (user_id = auth.uid());

-- Publish row changes on these tables to Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_checkins;
ALTER PUBLICATION supabase_realtime ADD TABLE public.push_checks;
