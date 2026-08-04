-- ============================================================
-- Migration 24 — Check-in anti-spoof signals (VPN/proxy + GPS integrity)
-- ============================================================
-- Every site check-in and location-response is scored server-side for
-- tamper signals, so HR can spot faked attendance:
--   • VPN / proxy / Tor / datacenter IP  (via proxycheck.io)
--   • GPS-vs-IP location mismatch          (only when the IP is CLEAN — a
--     residential IP far from the claimed GPS is a strong fake-GPS tell;
--     skipped for VPN IPs, whose geo is meaningless)
--   • Impossible travel                    (two check-ins too far apart in
--     too little time)
-- Detection is fail-open: if the IP lookup is unavailable the check-in still
-- records (never block attendance on an outage). All columns are nullable so
-- existing rows are untouched.
-- ============================================================

ALTER TABLE public.attendance_checkins
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS ip_proxy   boolean,          -- proxycheck "proxy: yes"
  ADD COLUMN IF NOT EXISTS ip_type    text,             -- VPN | TOR | Proxy | Business | Wireless | Residential | ...
  ADD COLUMN IF NOT EXISTS ip_risk    smallint,         -- 0-100
  ADD COLUMN IF NOT EXISTS ip_city    text,
  ADD COLUMN IF NOT EXISTS ip_country text,             -- ISO code
  ADD COLUMN IF NOT EXISTS ip_gps_km  integer,          -- km between IP-geo and GPS (null if not computable / VPN)
  ADD COLUMN IF NOT EXISTS spoof_flags text[],           -- {vpn, ip_far, impossible_travel, poor_gps}
  ADD COLUMN IF NOT EXISTS blocked    boolean;          -- true = a hard-blocked VPN attempt (attendance NOT credited)

-- Fast filter for HR's "Suspicious" view.
CREATE INDEX IF NOT EXISTS idx_checkins_spoof
  ON public.attendance_checkins USING gin (spoof_flags);
