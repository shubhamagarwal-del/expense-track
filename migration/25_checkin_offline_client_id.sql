-- ============================================================
-- Migration 25 — Offline check-in idempotency key
-- ============================================================
-- Offline check-ins are captured on the phone (photo + GPS work without a
-- network — GPS is satellite-based) and queued locally, then auto-synced when
-- connectivity returns. If a sync partially completes and retries, the same
-- check-in could be sent twice. `client_id` is a UUID the client mints once per
-- queued check-in; the server upserts on it so a retry is a no-op instead of a
-- duplicate row.
-- Nullable + partial-unique so existing online check-ins (no client_id) are
-- untouched and multiple NULLs are allowed.
-- ============================================================

ALTER TABLE public.attendance_checkins
  ADD COLUMN IF NOT EXISTS client_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_checkins_client_id
  ON public.attendance_checkins (client_id)
  WHERE client_id IS NOT NULL;
