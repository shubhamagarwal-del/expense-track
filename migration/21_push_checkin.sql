-- ============================================================
-- Migration 21 — Random push check-in (Web Push)
-- ============================================================
-- Powers random-time "verify you're still on site" prompts:
--  • push_subscriptions: each employee browser's Web Push subscription
--  • push_checks: each random verification request → responded / missed
-- The server sends via VAPID (web-push). Employees respond by doing a
-- normal site check-in (which links back to the pending push_check).
-- ============================================================

-- ── Browser push subscriptions (one per device the employee enables) ──
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id          bigserial   PRIMARY KEY,
  user_id     uuid        REFERENCES public.users(id) ON DELETE CASCADE,
  emp_no      text,
  endpoint    text        UNIQUE NOT NULL,   -- push service URL (unique per device)
  p256dh      text        NOT NULL,          -- client public key (encryption)
  auth        text        NOT NULL,          -- client auth secret
  user_agent  text,
  active      boolean     DEFAULT true,      -- set false when the push service returns 404/410
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_sub_user ON public.push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_sub_active ON public.push_subscriptions(active);

-- ── Random verification requests ──
CREATE TABLE IF NOT EXISTS public.push_checks (
  id             bigserial   PRIMARY KEY,
  user_id        uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  emp_no         text,
  sent_at        timestamptz DEFAULT now(),
  window_min     integer     DEFAULT 30,        -- minutes the employee has to respond
  status         text        DEFAULT 'pending', -- pending | responded | missed
  responded_at   timestamptz,
  checkin_id     bigint,                          -- attendance_checkins row that answered it
  reminders_sent integer     DEFAULT 0,
  check_date     date        DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date
);
CREATE INDEX IF NOT EXISTS idx_push_check_emp_date ON public.push_checks(emp_no, check_date);
CREATE INDEX IF NOT EXISTS idx_push_check_status   ON public.push_checks(status);

-- Server does all reads/writes with the service-role key (bypasses RLS).
-- Enable RLS with no client policies = clients cannot touch these directly.
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_checks        ENABLE ROW LEVEL SECURITY;
