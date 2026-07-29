-- ============================================================
-- Migration 19 — Employee attendance (for expense-vs-attendance flagging)
-- ============================================================
-- Stores the "off / chhutti" days per employee (from the monthly HR
-- attendance sheet). An expense whose date falls on one of these rows
-- gets flagged in the Audit view — the employee wasn't working that day.
--
-- Only OFF-day rows are stored (Absent, Leave, Comp-off, Sun/Sat, Holiday,
-- Paternity). A working/present day simply has no row here. Re-uploading a
-- month replaces that month's rows (delete by source_month, then insert).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.employee_attendance (
  id            bigserial   PRIMARY KEY,
  emp_no        text        NOT NULL,      -- SSS_xxxx, matched to users.emp_no
  att_date      date        NOT NULL,      -- the off day
  status        text        NOT NULL,      -- raw code: A | L | CO | SUN | SAT | H | Paternity Leave
  location      text,                      -- SITE | Office | Discom | Warehouse (from the sheet's LOCATION col)
  source_month  text        NOT NULL,      -- "April 2026" (for re-upload replacement)
  uploaded_at   timestamptz DEFAULT now(),
  UNIQUE (emp_no, att_date)
);

CREATE INDEX IF NOT EXISTS idx_att_emp_date ON public.employee_attendance(emp_no, att_date);
CREATE INDEX IF NOT EXISTS idx_att_month    ON public.employee_attendance(source_month);

ALTER TABLE public.employee_attendance ENABLE ROW LEVEL SECURITY;
-- Admin-side roles read via the service_role key (bypasses RLS); no client policy needed.
