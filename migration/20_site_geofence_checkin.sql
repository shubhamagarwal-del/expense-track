-- ============================================================
-- Migration 20 — Site geo-fence + attendance check-ins
-- ============================================================
-- Powers the field-staff check-in attendance flow: each site has a
-- center (lat/long) + radius (the geo-fence). An employee opens the
-- check-in page, picks their site, the browser reads GPS, and we record
-- whether they were inside that site's fence. Check-ins roll up into
-- daily attendance (present) which feeds the expense-vs-attendance flag.
-- ============================================================

-- ── Site geo-fence, keyed by the expense-side LOC code ─────
-- The site LIST comes from SITE_DATA (app.js, LOC codes) — the same sites the
-- employee picks when adding an expense. This table only holds the geo-fence
-- (coordinates + radius) for each LOC code. Sites without a row here simply
-- have no fence yet (check-in still records GPS).
CREATE TABLE IF NOT EXISTS public.site_locations (
  id          bigserial   PRIMARY KEY,
  site_code   text        UNIQUE NOT NULL,   -- LOC0020 (matches SITE_DATA.code)
  site_name   text,                          -- "Ankhisar-i" (for reference)
  latitude    double precision,
  longitude   double precision,
  radius_m    integer     NOT NULL DEFAULT 200,  -- geo-fence radius in metres
  active      boolean     DEFAULT true,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_active ON public.site_locations(active);

-- ── Per check-in log ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attendance_checkins (
  id           bigserial   PRIMARY KEY,
  user_id      uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  emp_no       text,
  site_code    text,                         -- LOC code of the site the employee selected
  site_name    text,                         -- its name (for reference)
  latitude     double precision,             -- phone GPS at check-in
  longitude    double precision,
  distance_m   integer,                       -- metres from the selected site's centre
  inside_fence boolean,                        -- distance_m <= that site's radius_m
  accuracy_m   integer,                        -- GPS accuracy the browser reported
  location_name text,                           -- reverse-geocoded place (village/town, district, state)
  photo_url    text,                            -- selfie/site photo taken at check-in (receipts bucket)
  nearest_site_code text,                        -- closest known site to the GPS (auto-detected)
  nearest_site_name text,
  nearest_distance_m integer,                    -- metres to that nearest site's centre
  site_mismatch boolean,                          -- true = GPS is closest to a DIFFERENT site than selected
  checked_at   timestamptz DEFAULT now(),
  check_date   date        DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date  -- IST day, for daily roll-up
);
CREATE INDEX IF NOT EXISTS idx_checkin_emp_date ON public.attendance_checkins(emp_no, check_date);
CREATE INDEX IF NOT EXISTS idx_checkin_user     ON public.attendance_checkins(user_id, check_date);

ALTER TABLE public.site_locations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_checkins ENABLE ROW LEVEL SECURITY;
-- Employees insert their own check-ins (auth.uid() = user_id); admin roles read all via service_role.
CREATE POLICY "Employees insert own check-in"
  ON public.attendance_checkins FOR INSERT
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Employees read own check-ins"
  ON public.attendance_checkins FOR SELECT
  USING (auth.uid() = user_id);
-- Everyone signed in can read the site list (needed to populate the check-in dropdown)
CREATE POLICY "Signed-in can read sites"
  ON public.site_locations FOR SELECT
  USING (auth.role() = 'authenticated');
