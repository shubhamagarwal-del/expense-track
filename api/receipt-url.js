import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

// Mirrors DUE_EXCLUDED_STATUSES in app.js (browser side) — server-side runtime can't
// share that file directly, so keep this list in sync manually if it ever changes.
const DUE_EXCLUDED_STATUSES = ['rejected', 'l1_rejected', 'deleted', 'audit_review', 'audit_query', 'superseded'];

// Configure Web Push (VAPID) once, lazily — returns false if keys aren't set.
let _vapidReady = null;
function vapidReady() {
  if (_vapidReady !== null) return _vapidReady;
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) { _vapidReady = false; return false; }
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@stockwell.example', pub, priv);
    _vapidReady = true;
  } catch { _vapidReady = false; }
  return _vapidReady;
}
// Send one push; on 404/410 (gone) deactivate the subscription. Best-effort.
async function sendPush(db, sub, payload) {
  if (!vapidReady()) return false;
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return true;
  } catch (err) {
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      await db.from('push_subscriptions').update({ active: false }).eq('endpoint', sub.endpoint);
    }
    return false;
  }
}

/**
 * Combines several related, low-traffic endpoints into one serverless function
 * (Vercel Hobby plan caps deployments at 12 functions):
 *
 *   POST { path }                 → original behavior: signed receipt URL
 *   POST { expense_id }           → records that the current admin viewed a receipt
 *   POST { payment_pdf_base64 }   → super_admin: import a bank NEFT/DCR report,
 *                                   match by account no, FIFO-allocate to pending
 *                                   cycles, return a summary (writes cycle_payments)
 *   POST { sync_accounts: true }  → super_admin/audit: pull reimbursed claims from the
 *                                   accounts-2026 project's read-only API (writes
 *                                   cycle_payments using their exact month + cycle)
 *   GET  ?ids=id1,id2,…           → receipt-view audit lookup for current admin
 *   GET  ?payments=1              → all cycle_payments rows (admin) for Paid/Pending
 *   GET  ?cron_sync=accounts      → Vercel Cron only (Authorization: Bearer CRON_SECRET),
 *                                   runs the same accounts-2026 sync on a schedule
 */
export default async function handler(req, res) {
  // ── Cron-triggered auto-sync (no logged-in user; Vercel sends Bearer CRON_SECRET) ──
  if (req.method === 'GET' && req.query?.cron_sync === 'accounts') {
    const cronAuth = req.headers.authorization;
    if (!process.env.CRON_SECRET || cronAuth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized cron request' });
    }
    const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    return await syncAccounts2026(res, supabaseAdmin);
  }

  // ── Cron-triggered Accounts Portal ADVANCES reconciliation (missed webhooks recovery) ──
  if (req.method === 'GET' && req.query?.cron_sync === 'portal_advances') {
    const cronAuth = req.headers.authorization;
    if (!process.env.CRON_SECRET || cronAuth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized cron request' });
    }
    const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    return await reconcilePortalAdvances(res, supabaseAdmin);
  }

  // ── Accounts Portal webhook (no user token — auth via x-api-key) ────────
  // POST /api/receipt-url?accounts_hook=1
  //   Header:  x-api-key: <ACCOUNTS_PORTAL_API_KEY>
  //   Body:    { advance_id, event, employee_number, amount, ... } per integration spec
  // Must respond 200 within 5s; sender does not retry on failure (reconciliation cron covers gaps).
  if (req.method === 'POST' && req.query?.accounts_hook === '1') {
    const apiKey = req.headers['x-api-key'];
    // Reuse the same Accounts-portal key the reimbursements sync already uses
    // (ACCOUNTS2026_API_KEY, set in prod). ACCOUNTS_PORTAL_API_KEY is an optional override.
    const expectedKey = process.env.ACCOUNTS_PORTAL_API_KEY || process.env.ACCOUNTS2026_API_KEY;
    if (!expectedKey || apiKey !== expectedKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    return await handleAccountsPortalWebhook(req, res, supabaseAdmin);
  }

  // ── Random push check-in tick (external scheduler, e.g. GitHub Action every ~30 min) ──
  // GET /api/receipt-url?push_tick=1  Header: x-api-key: <ACCOUNTS2026_API_KEY>
  // Sends random "verify you're on site" prompts, reminders, and marks misses.
  if (req.method === 'GET' && req.query?.push_tick) {
    const expectedKey = process.env.ACCOUNTS_PORTAL_API_KEY || process.env.ACCOUNTS2026_API_KEY;
    if (!expectedKey || req.headers['x-api-key'] !== expectedKey) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    return await runPushTick(res, supabaseAdmin);
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = authHeader.split(' ')[1];

  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  // ── GET ─────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { data: profile } = await supabaseAdmin.from('users').select('role').eq('id', user.id).single();
    if (!profile) return res.status(403).json({ error: 'Not authorised' });

    // ?checkins=1[&date=YYYY-MM-DD] → site check-ins for HR / Manager / Audit / Super Admin.
    if (req.query?.checkins) {
      if (!['admin', 'hr', 'audit', 'super_admin'].includes(profile.role)) {
        return res.status(403).json({ error: 'Not authorised' });
      }
      const date = req.query.date; // IST day; omit → all recent (capped)
      let q = supabaseAdmin
        .from('attendance_checkins')
        .select('user_id, emp_no, site_code, site_name, latitude, longitude, distance_m, inside_fence, accuracy_m, location_name, photo_url, nearest_site_code, nearest_site_name, nearest_distance_m, site_mismatch, checked_at, check_date')
        .order('checked_at', { ascending: false })
        .limit(2000);
      if (date) q = q.eq('check_date', date);
      const { data: rows, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      // attach employee names/departments
      const ids = [...new Set((rows || []).map(r => r.user_id).filter(Boolean))];
      const nameMap = {};
      if (ids.length) {
        const { data: us } = await supabaseAdmin.from('users').select('id, name, department, emp_no').in('id', ids);
        (us || []).forEach(u => { nameMap[u.id] = u; });
      }
      // Attendance conflict (feature 3): did the employee check in on a day their imported
      // attendance marks as an OFF day (Absent/Leave/etc)? That contradiction is audit-gold.
      // Read-only lookup — we never write Present into employee_attendance (keeps imported data safe).
      const emps = [...new Set((rows || []).map(r => String(r.emp_no || '').trim()).filter(Boolean))];
      const dates = [...new Set((rows || []).map(r => r.check_date).filter(Boolean))];
      const attMap = {};
      if (emps.length && dates.length) {
        const { data: att } = await supabaseAdmin
          .from('employee_attendance')
          .select('emp_no, att_date, status, source_month')
          .in('emp_no', emps).in('att_date', dates);
        (att || []).forEach(a => { attMap[`${String(a.emp_no).trim()}|${a.att_date}`] = { status: a.status, source: a.source_month }; });
      }
      const out = (rows || []).map(r => {
        const a = attMap[`${String(r.emp_no || '').trim()}|${r.check_date}`];
        return {
          ...r,
          name: nameMap[r.user_id]?.name || null,
          department: nameMap[r.user_id]?.department || null,
          att_status: a?.status || null,
          att_source: a?.source || null,
        };
      });
      return res.status(200).json({ checkins: out });
    }

    // ?push_checks=1[&date=YYYY-MM-DD] → random-check stats per employee (sent/responded/missed).
    if (req.query?.push_checks) {
      if (!['admin', 'hr', 'audit', 'super_admin'].includes(profile.role)) {
        return res.status(403).json({ error: 'Not authorised' });
      }
      const date = req.query.date;
      let q = supabaseAdmin.from('push_checks')
        .select('user_id, emp_no, sent_at, status, responded_at, window_min, check_date')
        .order('sent_at', { ascending: false }).limit(3000);
      if (date) q = q.eq('check_date', date);
      const { data: pc, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      const ids = [...new Set((pc || []).map(r => r.user_id).filter(Boolean))];
      const nameMap = {};
      if (ids.length) {
        const { data: us } = await supabaseAdmin.from('users').select('id, name, department').in('id', ids);
        (us || []).forEach(u => { nameMap[u.id] = u; });
      }
      const out = (pc || []).map(r => ({ ...r, name: nameMap[r.user_id]?.name || null, department: nameMap[r.user_id]?.department || null }));
      return res.status(200).json({ push_checks: out });
    }

    // ?audit_checks=1 → all recorded audit-check rows (Audit / Super Admin manual "checked for payment" marker)
    if (req.query?.audit_checks) {
      if (!['audit', 'super_admin'].includes(profile.role)) {
        return res.status(403).json({ error: 'Not authorised' });
      }
      const { data, error } = await supabaseAdmin
        .from('expense_audit_checks')
        .select('expense_id, checked_by_name, checked_at');
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ checks: data || [] });
    }

    // ?portal_advances=1 → mirror of Accounts Portal advances (read-only).
    // Admins/HR/Audit/Super Admin get all; an employee only gets their own matched rows.
    if (req.query?.portal_advances) {
      let q = supabaseAdmin
        .from('accounts_portal_advances')
        .select('id, advance_id, event, employee_number, employee_name, amount, advance_date, narration, bank_reference, bank, outstanding_after, matched_employee_id, received_at')
        .order('advance_date', { ascending: false })
        .order('received_at', { ascending: false });
      if (!['admin','hr','audit','super_admin'].includes(profile.role)) q = q.eq('matched_employee_id', user.id);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ portal_advances: data || [] });
    }

    // ?portal_claims=1 → claims already pushed to Accounts Portal (for per-cycle "Pushed" status).
    if (req.query?.portal_claims) {
      if (!['admin','hr','audit','super_admin'].includes(profile.role)) {
        return res.status(403).json({ error: 'Not authorised' });
      }
      const { data, error } = await supabaseAdmin
        .from('accounts_portal_claims')
        .select('user_id, month_year, cycle_text, claim_id, status, lines, approved_total, pushed_at, pushed_by_name');
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ portal_claims: data || [] });
    }

    // ?attendance_off=1 → all off-day (chhutti) attendance rows, for expense-vs-attendance flagging.
    // Audit / Super Admin only. Returns emp_no + date + status; the client flags any expense on a match.
    if (req.query?.attendance_off) {
      if (!['audit', 'super_admin'].includes(profile.role)) {
        return res.status(403).json({ error: 'Not authorised' });
      }
      const { data, error } = await supabaseAdmin
        .from('employee_attendance')
        .select('emp_no, att_date, status, location')
        .in('status', ['A', 'L', 'CO', 'SUN', 'SAT', 'H', 'Paternity Leave']); // off-days only — excludes check-in 'P'
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ attendance_off: data || [] });
    }

    // ?advances=1 → employee advance ledger (for Advance/Due display).
    // Audit/Super Admin get everyone's; an employee only ever gets their own.
    // Each row also gets `recovered_amount`/`remaining` computed from its recovery log,
    // since one advance can now be recovered across multiple partial payments.
    if (req.query?.advances) {
      const ALLOWED_ADVANCE_ROLES = ['audit', 'super_admin'];
      let q = supabaseAdmin
        .from('employee_advances')
        .select('id, user_id, amount, given_at, given_by_name, note, status, recovered_at, recovered_by_name')
        .order('given_at', { ascending: false });
      if (!ALLOWED_ADVANCE_ROLES.includes(profile.role)) q = q.eq('user_id', user.id);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      const advances = data || [];
      const ids = advances.map(a => a.id);
      const recoveriesByAdvance = {};
      if (ids.length) {
        const { data: recs } = await supabaseAdmin
          .from('employee_advance_recoveries')
          .select('id, advance_id, amount, recovered_at, recovered_by_name')
          .in('advance_id', ids)
          .order('recovered_at', { ascending: false });
        (recs || []).forEach(r => {
          (recoveriesByAdvance[r.advance_id] ||= []).push(r);
        });
      }
      const withRemaining = advances.map(a => {
        const recoveries = recoveriesByAdvance[a.id] || [];
        const recoveredAmount = recoveries.reduce((s, r) => s + Number(r.amount || 0), 0);
        return { ...a, recovered_amount: recoveredAmount, remaining: Math.max(0, Number(a.amount || 0) - recoveredAmount), recoveries };
      });
      return res.status(200).json({ advances: withRemaining });
    }

    // ?payments=1 → recorded cycle payments (for Paid/Pending display).
    // Admin-side roles get everyone's; an employee only ever gets their own.
    if (req.query?.payments) {
      const ALLOWED_VIEW_ROLES = ['admin', 'super_admin', 'hr', 'audit'];
      let q = supabaseAdmin
        .from('cycle_payments')
        .select('user_id, month_year, cycle_num, amount_paid, utr_number, bene_name, payment_date');
      if (!ALLOWED_VIEW_ROLES.includes(profile.role)) q = q.eq('user_id', user.id);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ payments: data || [] });
    }

    const ALLOWED_VIEW_ROLES = ['admin', 'super_admin', 'hr', 'audit'];
    if (!ALLOWED_VIEW_ROLES.includes(profile.role)) {
      return res.status(403).json({ error: 'Not authorised' });
    }

    // ?ids=… → receipt-view audit lookup
    const ids = String(req.query?.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(200).json({ views: {} });
    const { data, error } = await supabaseAdmin
      .from('expense_views')
      .select('expense_id, viewed_at')
      .eq('user_id', user.id)
      .in('expense_id', ids);
    if (error) return res.status(500).json({ error: error.message });
    const views = {};
    (data || []).forEach(r => { views[r.expense_id] = r.viewed_at; });
    return res.status(200).json({ views });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── POST { payment_pdf_base64 } → import bank payment report ────
    if (req.body?.payment_pdf_base64) {
      const { data: profile } = await supabaseAdmin.from('users').select('role, name').eq('id', user.id).single();
      if (!profile || profile.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only a Super Admin can import payments' });
      }
      return await importPayments(req, res, supabaseAdmin, user, profile);
    }

    // ── POST { sync_accounts: true } → pull reimbursed claims from accounts-2026 ──
    if (req.body?.sync_accounts) {
      const { data: profile } = await supabaseAdmin.from('users').select('role').eq('id', user.id).single();
      if (!profile || !['super_admin', 'audit'].includes(profile.role)) {
        return res.status(403).json({ error: 'Only a Super Admin or Audit can sync from accounts-2026' });
      }
      return await syncAccounts2026(res, supabaseAdmin);
    }

    // ── POST { sync_portal_advances: true } → manual reconciliation trigger for Accounts Portal advances ──
    if (req.body?.sync_portal_advances) {
      const { data: profile } = await supabaseAdmin.from('users').select('role').eq('id', user.id).single();
      if (!profile || !['super_admin', 'audit', 'hr'].includes(profile.role)) {
        return res.status(403).json({ error: 'Only Super Admin, Audit, or HR can sync portal advances' });
      }
      return await reconcilePortalAdvances(res, supabaseAdmin);
    }

    // ── POST { checkin: { site_name, latitude, longitude, accuracy } } → record a site check-in ──
    // Any signed-in employee checks in for themselves. Server is authoritative: it looks up the
    // site's fence and computes distance/inside — the client's own claim is never trusted.
    if (req.body?.checkin) {
      const { site_code, site_name, latitude, longitude, accuracy, photo_url } = req.body.checkin;
      if (!site_code || latitude == null || longitude == null) {
        return res.status(400).json({ error: 'site_code, latitude, longitude are required' });
      }
      // Fence is optional — a site may not have coordinates yet. Look it up; if none,
      // still record the check-in (GPS only, no pass/fail) so nothing is lost.
      const { data: site } = await supabaseAdmin
        .from('site_locations')
        .select('latitude, longitude, radius_m')
        .eq('site_code', site_code).maybeSingle();

      let distance_m = null, inside_fence = null, radius_m = site?.radius_m ?? null, has_fence = false;
      if (site && site.latitude != null && site.longitude != null) {
        has_fence = true;
        distance_m = Math.round(haversineMetres(latitude, longitude, site.latitude, site.longitude));
        inside_fence = distance_m <= (site.radius_m || 200);
      }

      // Nearest-site auto-detect: which known (fenced) site is the GPS actually closest to?
      // If that isn't the site the employee selected (and they're not inside the selected fence),
      // flag a mismatch so HR/audit can check ("claimed X, but stood next to Y").
      let nearest_site_code = null, nearest_site_name = null, nearest_distance_m = null, site_mismatch = false;
      const { data: allSites } = await supabaseAdmin
        .from('site_locations')
        .select('site_code, site_name, latitude, longitude')
        .eq('active', true);
      (allSites || []).forEach(s => {
        if (s.latitude == null || s.longitude == null) return;
        const d = Math.round(haversineMetres(latitude, longitude, s.latitude, s.longitude));
        if (nearest_distance_m == null || d < nearest_distance_m) {
          nearest_distance_m = d; nearest_site_code = s.site_code; nearest_site_name = s.site_name;
        }
      });
      if (nearest_site_code && nearest_site_code !== site_code && inside_fence !== true) {
        site_mismatch = true;
      }

      const { data: prof } = await supabaseAdmin.from('users').select('emp_no').eq('id', user.id).single();
      const location_name = await reverseGeocodePlace(latitude, longitude); // best-effort; null on failure
      const { data: inserted, error } = await supabaseAdmin.from('attendance_checkins').insert({
        user_id: user.id, emp_no: prof?.emp_no || null, site_code, site_name: site_name || null,
        latitude, longitude, distance_m, inside_fence,
        accuracy_m: accuracy != null ? Math.round(accuracy) : null,
        location_name, photo_url: photo_url || null,
        nearest_site_code, nearest_site_name, nearest_distance_m, site_mismatch,
      }).select('id').single();
      if (error) return res.status(500).json({ error: error.message });

      // If a random push-check is pending for this employee today, this check-in answers it.
      if (prof?.emp_no) {
        const istDate = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
        await supabaseAdmin.from('push_checks')
          .update({ status: 'responded', responded_at: new Date().toISOString(), checkin_id: inserted?.id || null })
          .eq('emp_no', String(prof.emp_no).trim()).eq('check_date', istDate).eq('status', 'pending');
      }

      // Feed daily attendance from this check-in: auto Present / Half Day based on how many
      // of the 3 slots the employee has done today. Never overwrites an imported off-day or
      // an HR manual override (see autoMarkAttendance). Best-effort — never fails the check-in.
      let attendance_status = null;
      if (prof?.emp_no) {
        const istDate = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
        try { attendance_status = (await autoMarkAttendance(supabaseAdmin, String(prof.emp_no).trim(), istDate)).status; } catch { /* non-fatal */ }
      }

      return res.status(200).json({
        ok: true, has_fence, distance_m, inside_fence, radius_m, location_name,
        nearest_site_code, nearest_site_name, nearest_distance_m, site_mismatch, attendance_status,
      });
    }

    // ── POST { subscribe_push: { endpoint, keys:{p256dh, auth} } } → save this browser's push subscription ──
    if (req.body?.subscribe_push) {
      const sub = req.body.subscribe_push;
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
        return res.status(400).json({ error: 'Invalid subscription' });
      }
      const { data: prof } = await supabaseAdmin.from('users').select('emp_no').eq('id', user.id).single();
      const { error } = await supabaseAdmin.from('push_subscriptions').upsert({
        user_id: user.id, emp_no: prof?.emp_no || null,
        endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth,
        user_agent: (req.headers['user-agent'] || '').slice(0, 300), active: true,
      }, { onConflict: 'endpoint' });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    // ── POST { set_attendance: { emp_no, att_date, status } } → HR/Admin manual attendance override ──
    // Sets a day's status to anything (Present/Half Day/Absent/Leave/...). Marked source 'manual'
    // so it sticks: later check-ins won't auto-change it (autoMarkAttendance only touches 'checkin').
    if (req.body?.set_attendance) {
      const { data: profile } = await supabaseAdmin.from('users').select('role').eq('id', user.id).single();
      if (!profile || !['admin', 'hr', 'audit', 'super_admin'].includes(profile.role)) {
        return res.status(403).json({ error: 'Not authorised' });
      }
      const { emp_no, att_date, status } = req.body.set_attendance;
      const ALLOWED = ['P', 'HD', 'A', 'L', 'CO', 'H', 'SAT', 'SUN', 'Paternity Leave'];
      if (!emp_no || !att_date || !ALLOWED.includes(status)) {
        return res.status(400).json({ error: 'emp_no, att_date and a valid status are required' });
      }
      const { error } = await supabaseAdmin.from('employee_attendance').upsert(
        { emp_no: String(emp_no).trim(), att_date, status, source_month: 'manual' },
        { onConflict: 'emp_no,att_date' }
      );
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, emp_no: String(emp_no).trim(), att_date, status });
    }

    // ── POST { upload_attendance: { source_month, rows:[{emp_no,att_date,status}] } } → replace a month's off-day attendance ──
    if (req.body?.upload_attendance) {
      const { data: profile } = await supabaseAdmin.from('users').select('role').eq('id', user.id).single();
      if (!profile || !['super_admin', 'audit', 'hr'].includes(profile.role)) {
        return res.status(403).json({ error: 'Only Super Admin, Audit, or HR can upload attendance' });
      }
      const { source_month, rows } = req.body.upload_attendance;
      if (!source_month || !Array.isArray(rows)) {
        return res.status(400).json({ error: 'source_month and rows[] are required' });
      }
      // Replace this month's rows so re-upload is clean
      const { error: delErr } = await supabaseAdmin.from('employee_attendance').delete().eq('source_month', source_month);
      if (delErr) return res.status(500).json({ error: delErr.message });
      const clean = rows
        .filter(r => r && r.emp_no && r.att_date && r.status)
        .map(r => ({ emp_no: String(r.emp_no).trim(), att_date: r.att_date, status: String(r.status).trim(), location: r.location ? String(r.location).trim() : null, source_month }));
      let inserted = 0;
      for (let i = 0; i < clean.length; i += 500) {
        const { error } = await supabaseAdmin
          .from('employee_attendance')
          .upsert(clean.slice(i, i + 500), { onConflict: 'emp_no,att_date' });
        if (error) return res.status(500).json({ error: error.message });
        inserted += Math.min(500, clean.length - i);
      }
      return res.status(200).json({ ok: true, source_month, imported: inserted });
    }

    // ── POST { push_claim: {...} } → push an audit-cleared cycle report (Excel + PDF) to Accounts Portal ──
    if (req.body?.push_claim) {
      const { data: profile } = await supabaseAdmin.from('users').select('role, name').eq('id', user.id).single();
      if (!profile || !['super_admin', 'audit'].includes(profile.role)) {
        return res.status(403).json({ error: 'Only Super Admin or Audit can push claims' });
      }
      return await pushClaimToPortal(req, res, supabaseAdmin, user, profile);
    }

    // ── POST { audit_check_ids: [...], checked: true|false } → Audit's manual "checked for payment" marker ──
    if (Array.isArray(req.body?.audit_check_ids)) {
      const { data: profile } = await supabaseAdmin.from('users').select('role, name').eq('id', user.id).single();
      if (!profile || !['audit', 'super_admin'].includes(profile.role)) {
        return res.status(403).json({ error: 'Not authorised' });
      }
      const { audit_check_ids: ids, checked } = req.body;
      if (!ids.length) return res.status(400).json({ error: 'audit_check_ids array is required' });

      if (checked) {
        const rows = ids.map(id => ({
          expense_id: id,
          checked_by: user.id,
          checked_by_name: profile.name,
          checked_at: new Date().toISOString(),
        }));
        const { error } = await supabaseAdmin
          .from('expense_audit_checks')
          .upsert(rows, { onConflict: 'expense_id' });
        if (error) return res.status(500).json({ error: error.message });
      } else {
        const { error } = await supabaseAdmin
          .from('expense_audit_checks')
          .delete()
          .in('expense_id', ids);
        if (error) return res.status(500).json({ error: error.message });
      }
      return res.status(200).json({ message: 'OK', count: ids.length });
    }

    // ── POST { add_advance: { user_id, amount, given_at, note } } → record a new advance (Audit, Super Admin) ──
    if (req.body?.add_advance) {
      const { data: profile } = await supabaseAdmin.from('users').select('role, name').eq('id', user.id).single();
      if (!profile || !['audit', 'super_admin'].includes(profile.role)) {
        return res.status(403).json({ error: 'Only Audit or Super Admin can add an advance' });
      }
      const { user_id, amount, given_at, note } = req.body.add_advance;
      const amt = Number(amount);
      if (!user_id || !amt || amt <= 0) return res.status(400).json({ error: 'A valid user_id and amount are required' });

      const { error } = await supabaseAdmin.from('employee_advances').insert({
        user_id,
        amount: amt,
        given_at: given_at || new Date().toISOString().slice(0, 10),
        given_by: user.id,
        given_by_name: profile.name,
        note: note?.trim() || null,
      });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: 'Advance recorded' });
    }

    // ── POST { advance_recover: { advance_id, amount? } } → log a recovery against an advance
    // (Audit, Super Admin). Omit `amount` to recover the full outstanding balance in one go;
    // pass a smaller amount to net off only part of it (e.g. one payment cycle didn't cover
    // the whole advance) — the remainder stays outstanding for a future recovery. ──
    if (req.body?.advance_recover) {
      const { data: profile } = await supabaseAdmin.from('users').select('role, name').eq('id', user.id).single();
      if (!profile || !['audit', 'super_admin'].includes(profile.role)) {
        return res.status(403).json({ error: 'Only Audit or Super Admin can recover an advance' });
      }
      const { advance_id, amount } = req.body.advance_recover;
      if (!advance_id) return res.status(400).json({ error: 'advance_id is required' });

      const { data: advance, error: advErr } = await supabaseAdmin
        .from('employee_advances').select('id, amount').eq('id', advance_id).single();
      if (advErr || !advance) return res.status(404).json({ error: 'Advance not found' });

      const { data: recs } = await supabaseAdmin
        .from('employee_advance_recoveries').select('amount').eq('advance_id', advance_id);
      const alreadyRecovered = (recs || []).reduce((s, r) => s + Number(r.amount || 0), 0);
      const remaining = Number(advance.amount || 0) - alreadyRecovered;
      if (remaining <= 0.005) return res.status(400).json({ error: 'This advance is already fully recovered' });

      const amt = amount != null ? Number(amount) : remaining;
      if (!amt || amt <= 0 || amt > remaining + 0.005) {
        return res.status(400).json({ error: 'Amount must be between 0 and the outstanding balance' });
      }

      const { error: insErr } = await supabaseAdmin.from('employee_advance_recoveries').insert({
        advance_id, amount: amt, recovered_by: user.id, recovered_by_name: profile.name,
      });
      if (insErr) return res.status(500).json({ error: insErr.message });

      if (amt >= remaining - 0.005) {
        await supabaseAdmin.from('employee_advances').update({
          status: 'recovered',
          recovered_at: new Date().toISOString(),
          recovered_by: user.id,
          recovered_by_name: profile.name,
        }).eq('id', advance_id);
      }
      return res.status(200).json({ message: 'Advance recovery recorded', remaining: Math.max(0, remaining - amt) });
    }

    // ── POST { undo_advance_recovery: recoveryId } → delete a logged recovery
    // (e.g. a payment sheet was exported/netted but the bank transfer never actually
    // went through). Reopens the advance as outstanding if it had been marked recovered. ──
    if (req.body?.undo_advance_recovery) {
      const { data: profile } = await supabaseAdmin.from('users').select('role').eq('id', user.id).single();
      if (!profile || !['audit', 'super_admin'].includes(profile.role)) {
        return res.status(403).json({ error: 'Only Audit or Super Admin can undo an advance recovery' });
      }
      const recoveryId = req.body.undo_advance_recovery;
      const { data: recovery, error: recErr } = await supabaseAdmin
        .from('employee_advance_recoveries').select('id, advance_id').eq('id', recoveryId).single();
      if (recErr || !recovery) return res.status(404).json({ error: 'Recovery entry not found' });

      const { error: delErr } = await supabaseAdmin
        .from('employee_advance_recoveries').delete().eq('id', recoveryId);
      if (delErr) return res.status(500).json({ error: delErr.message });

      await supabaseAdmin.from('employee_advances').update({
        status: 'outstanding', recovered_at: null, recovered_by: null, recovered_by_name: null,
      }).eq('id', recovery.advance_id).eq('status', 'recovered');

      return res.status(200).json({ message: 'Recovery undone' });
    }

    // ── POST { expense_id, admin_comment } → add/edit an admin comment without
    // changing status (admin, super_admin, hr, audit) ──
    if (req.body?.expense_id && req.body?.admin_comment !== undefined) {
      const { data: profile } = await supabaseAdmin.from('users').select('role').eq('id', user.id).single();
      if (!profile || !['admin', 'super_admin', 'hr', 'audit'].includes(profile.role)) {
        return res.status(403).json({ error: 'Not authorised' });
      }
      const { error } = await supabaseAdmin
        .from('expenses').update({ rejection_reason: req.body.admin_comment }).eq('id', req.body.expense_id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: 'Comment saved' });
    }

    // ── POST { expense_id, receipt_url } → attach/replace a receipt (super_admin, hr) ──
    if (req.body?.expense_id && req.body?.receipt_url) {
      const { data: profile } = await supabaseAdmin.from('users').select('role').eq('id', user.id).single();
      if (!profile || !['super_admin', 'hr'].includes(profile.role)) {
        return res.status(403).json({ error: 'Not authorised to edit receipts' });
      }
      const { error } = await supabaseAdmin
        .from('expenses').update({ receipt_url: req.body.receipt_url }).eq('id', req.body.expense_id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: 'Receipt updated' });
    }

    // ── POST { expense_id } → record a receipt view (admin-side roles) ──
    if (req.body?.expense_id) {
      const { data: profile } = await supabaseAdmin.from('users').select('role').eq('id', user.id).single();
      if (!profile || !['admin', 'super_admin', 'hr', 'audit'].includes(profile.role)) {
        return res.status(403).json({ error: 'Not authorised' });
      }
      const now = new Date().toISOString();
      const { data, error } = await supabaseAdmin
        .from('expense_views')
        .upsert({ expense_id: req.body.expense_id, user_id: user.id, viewed_at: now }, { onConflict: 'expense_id,user_id' })
        .select('viewed_at')
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ viewed_at: data?.viewed_at || now });
    }

    // ── POST { path } → signed receipt URL ─────────────────────────
    const { path } = req.body;
    if (!path) return res.status(400).json({ error: 'Missing path' });
    const { data, error } = await supabaseAdmin.storage.from('receipts').createSignedUrl(path, 3600);
    if (error) return res.status(500).json({ error: error.message });
    if (!data?.signedUrl) return res.status(500).json({ error: 'Could not generate signed URL' });
    return res.status(200).json({ url: data.signedUrl });
  } catch (err) {
    return res.status(500).json({ error: String(err.message ?? err) });
  }
}

// ── Helpers ────────────────────────────────────────────────────────

const clean   = s => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
const cleanId = s => clean(s).replace(/\s+/g, '');                 // join split account/utr cells
const normAcct = s => cleanId(s).replace(/^0+/, '');               // ignore leading zeros for matching

/** Parse the bank report PDF into clean transaction rows. */
async function parsePaymentPdf(base64) {
  const { PDFParse } = await import('pdf-parse');
  const buf = Buffer.from(base64, 'base64');
  const parser = new PDFParse({ data: buf });
  let result;
  try { result = await parser.getTable(); }
  finally { await parser.destroy().catch(() => {}); }

  const rows = [];
  for (const page of result.pages || []) {
    for (const tbl of page.tables || []) {
      if (!tbl.length) continue;
      const header = tbl[0].map(c => clean(c).toLowerCase());
      const iBene = header.findIndex(h => h.includes('bene name'));
      const iAcct = header.findIndex(h => h.includes('bene account'));
      const iAmt  = header.findIndex(h => h.includes('payment amount')) >= 0
        ? header.findIndex(h => h.includes('payment amount'))
        : header.findIndex(h => h.includes('amount'));
      const iStat = header.findIndex(h => h.includes('status'));
      const iUtr  = header.findIndex(h => h.includes('utr'));
      if (iAcct < 0 || iAmt < 0 || iUtr < 0) continue; // not the transactions table
      for (let r = 1; r < tbl.length; r++) {
        const row = tbl[r];
        const amount = parseFloat(clean(row[iAmt]).replace(/,/g, ''));
        rows.push({
          bene:   clean(row[iBene]),
          acct:   cleanId(row[iAcct]),
          amount: isNaN(amount) ? 0 : amount,
          status: clean(row[iStat]),
          utr:    cleanId(row[iUtr]),
        });
      }
    }
  }
  return rows;
}

async function importPayments(req, res, db, actingUser, actingProfile) {
  const rows = await parsePaymentPdf(req.body.payment_pdf_base64);
  if (!rows.length) return res.status(400).json({ error: 'No transactions found in the PDF' });

  // Build an account-number → user lookup
  const { data: users, error: uErr } = await db
    .from('users').select('id, name, bank_account').not('bank_account', 'is', null);
  if (uErr) return res.status(500).json({ error: uErr.message });
  const byAcct = new Map();
  for (const u of users) {
    const key = normAcct(u.bank_account);
    if (!key) continue;
    if (!byAcct.has(key)) byAcct.set(key, []);
    byAcct.get(key).push(u);
  }

  // Existing UTRs (re-import guard) and existing payments (already-paid math)
  const { data: existing } = await db
    .from('cycle_payments').select('user_id, month_year, cycle_num, amount_paid, utr_number');
  const existingUtrs = new Set((existing || []).map(p => p.utr_number));
  const paidByKey = {};
  (existing || []).forEach(p => {
    const k = `${p.user_id}|${p.month_year}|${p.cycle_num}`;
    paidByKey[k] = (paidByKey[k] || 0) + Number(p.amount_paid || 0);
  });

  const summary = { total: rows.length, marked: [], skippedFailed: [], duplicates: [], unmatched: [], noPending: [], advancesRecovered: [] };
  const toInsert = [];

  for (const row of rows) {
    if (!/processed|success/i.test(row.status)) { summary.skippedFailed.push({ bene: row.bene, utr: row.utr, status: row.status }); continue; }
    if (row.utr && existingUtrs.has(row.utr)) { summary.duplicates.push({ bene: row.bene, utr: row.utr }); continue; }

    const matches = byAcct.get(normAcct(row.acct)) || [];
    if (matches.length !== 1) { summary.unmatched.push({ bene: row.bene, acct: row.acct, amount: row.amount, reason: matches.length === 0 ? 'no account match' : 'ambiguous account' }); continue; }
    const u = matches[0];

    // Build that user's pending cycles (approved-sheet total minus already paid)
    const cycles = await pendingCyclesForUser(db, u.id, paidByKey);
    const pendingCycles = cycles.filter(c => c.pending > 0.005);
    if (!pendingCycles.length) { summary.noPending.push({ bene: row.bene, name: u.name, amount: row.amount }); continue; }

    // Prefer an exact-amount cycle; else FIFO oldest→newest
    let remaining = row.amount;
    const exact = pendingCycles.find(c => Math.abs(c.pending - row.amount) < 0.5);
    const targets = exact ? [exact] : pendingCycles;
    const allocations = [];
    for (const c of targets) {
      if (remaining <= 0.005) break;
      const give = Math.min(c.pending, remaining);
      remaining -= give;
      c.pending -= give;
      const k = `${u.id}|${c.monthYear}|${c.cycleNum}`;
      paidByKey[k] = (paidByKey[k] || 0) + give;
      allocations.push({ monthYear: c.monthYear, cycleNum: c.cycleNum, amount: Math.round(give * 100) / 100 });
      toInsert.push({
        user_id: u.id, month_year: c.monthYear, cycle_num: c.cycleNum,
        amount_paid: Math.round(give * 100) / 100, utr_number: row.utr,
        bene_name: row.bene, paid_by: actingUser.id,
      });
    }
    if (row.utr) existingUtrs.add(row.utr);
    summary.marked.push({ bene: row.bene, name: u.name, amount: row.amount, utr: row.utr, allocations, leftover: Math.round(remaining * 100) / 100 });

    // This confirmed bank payment left a gap on the cycle(s) it touched — if that
    // matches (part of) an outstanding advance, treat it as netted off and recover it.
    const gap = targets.reduce((s, c) => s + Math.max(0, c.pending), 0);
    if (gap > 0.005) {
      const recovered = await autoRecoverAdvanceGap(db, u.id, gap);
      if (recovered > 0.005) summary.advancesRecovered.push({ name: u.name, amount: Math.round(recovered * 100) / 100 });
    }
  }

  if (toInsert.length) {
    const { error: insErr } = await db
      .from('cycle_payments')
      .upsert(toInsert, { onConflict: 'utr_number,user_id,month_year,cycle_num', ignoreDuplicates: true });
    if (insErr) return res.status(500).json({ error: insErr.message });
  }

  return res.status(200).json(summary);
}

/**
 * Pull reimbursed employee claims from the accounts-2026 project's read-only API
 * and record them in cycle_payments. Unlike importPayments (bank PDF + FIFO guess),
 * accounts-2026 already tags each claim with an exact month + cycle, so no guessing
 * is needed — matching is by employee_number only.
 */
async function syncAccounts2026(res, db) {
  const baseUrl = process.env.ACCOUNTS2026_BASE_URL;
  const apiKey = process.env.ACCOUNTS2026_API_KEY;
  if (!baseUrl || !apiKey) {
    return res.status(500).json({ error: 'accounts-2026 integration is not configured (missing env vars)' });
  }

  let claims;
  try {
    const r = await fetch(`${baseUrl}/api/external/employee-reimbursements?status=reimbursed`, {
      headers: { 'x-api-key': apiKey }
    });
    if (r.status === 401) return res.status(502).json({ error: 'accounts-2026 rejected the API key (401)' });
    if (r.status === 503) return res.status(502).json({ error: 'accounts-2026 integration not configured on their side (503)' });
    if (!r.ok) return res.status(502).json({ error: `accounts-2026 returned HTTP ${r.status}` });
    const json = await r.json();
    claims = json?.data || [];
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach accounts-2026: ' + (err.message ?? err) });
  }

  const { data: users } = await db.from('users').select('id, name, emp_no').not('emp_no', 'is', null);
  const byEmpNo = new Map((users || []).map(u => [String(u.emp_no).trim().toLowerCase(), u]));

  const { data: existing } = await db.from('cycle_payments').select('user_id, month_year, cycle_num, amount_paid, utr_number');
  const existingUtrs = new Set((existing || []).map(p => p.utr_number));
  const paidByKey = {};
  (existing || []).forEach(p => {
    const k = `${p.user_id}|${p.month_year}|${p.cycle_num}`;
    paidByKey[k] = (paidByKey[k] || 0) + Number(p.amount_paid || 0);
  });

  const summary = { total: claims.length, synced: [], unmatchedEmployee: [], skippedNotReimbursed: [], duplicates: [], advancesRecovered: [] };
  const toInsert = [];

  for (const claim of claims) {
    if (!claim.reimbursed) { summary.skippedNotReimbursed.push({ claim_id: claim.claim_id, employee: claim.employee_name }); continue; }

    const u = byEmpNo.get(String(claim.employee_number || '').trim().toLowerCase());
    if (!u) { summary.unmatchedEmployee.push({ claim_id: claim.claim_id, employee_number: claim.employee_number, employee: claim.employee_name }); continue; }

    // claim_id is the only field accounts-2026 guarantees unique per claim — payment.reference
    // is just the bank narration and can be identical across different employees/claims when
    // one bank transfer settles several claims at once ("combined" payments).
    const utr = `ACCT2026-${claim.claim_id}`;
    if (existingUtrs.has(utr)) { summary.duplicates.push({ claim_id: claim.claim_id, employee: claim.employee_name }); continue; }

    // accounts-2026's exact cycle string format isn't confirmed yet — this heuristic
    // treats anything mentioning "16"/"second half" as cycle 2, else cycle 1.
    const cycleNum = /16|second/i.test(String(claim.cycle || '')) ? 2 : 1;
    const amount = Number(claim.payment?.amount ?? claim.approved_total ?? 0);

    toInsert.push({
      user_id: u.id, month_year: claim.month || '', cycle_num: cycleNum,
      amount_paid: Math.round(amount * 100) / 100,
      utr_number: utr,
      bene_name: claim.employee_name || u.name,
      paid_by: null,
    });
    existingUtrs.add(utr);
    summary.synced.push({ employee: u.name, employee_number: claim.employee_number, month: claim.month, cycle: cycleNum, amount });

    // If this confirmed payment is less than the cycle's full approved total, the
    // gap likely matches an outstanding advance that was netted off — recover it.
    const cycles = await pendingCyclesForUser(db, u.id, paidByKey);
    const cycle = cycles.find(c => c.monthYear === claim.month && c.cycleNum === cycleNum);
    const k = `${u.id}|${claim.month || ''}|${cycleNum}`;
    paidByKey[k] = (paidByKey[k] || 0) + amount;
    if (cycle) {
      const gap = cycle.pending - amount;
      if (gap > 0.005) {
        const recovered = await autoRecoverAdvanceGap(db, u.id, gap);
        if (recovered > 0.005) summary.advancesRecovered.push({ name: u.name, amount: Math.round(recovered * 100) / 100 });
      }
    }
  }

  if (toInsert.length) {
    const { error: insErr } = await db
      .from('cycle_payments')
      .upsert(toInsert, { onConflict: 'utr_number,user_id,month_year,cycle_num', ignoreDuplicates: true });
    if (insErr) return res.status(500).json({ error: insErr.message });
  }

  return res.status(200).json(summary);
}

/** Compute a user's cycles with approved-sheet total and remaining pending amount. */
async function pendingCyclesForUser(db, userId, paidByKey) {
  const { data: exps } = await db
    .from('expenses').select('amount, approved_amount, status, created_at').eq('user_id', userId);
  const groups = new Map();
  for (const e of exps || []) {
    if (DUE_EXCLUDED_STATUSES.includes(e.status)) continue;
    const d = new Date(e.created_at);
    const monthYear = d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const cycleNum = d.getDate() <= 15 ? 1 : 2;
    const key = `${monthYear}|${cycleNum}`;
    if (!groups.has(key)) groups.set(key, { monthYear, cycleNum, yr: d.getFullYear(), mo: d.getMonth(), total: 0 });
    const amt = e.approved_amount != null ? +e.approved_amount : +e.amount;
    if (!isNaN(amt)) groups.get(key).total += amt;
  }
  const out = [];
  for (const g of groups.values()) {
    const paid = paidByKey[`${userId}|${g.monthYear}|${g.cycleNum}`] || 0;
    out.push({ ...g, paid, pending: g.total - paid });
  }
  out.sort((a, b) => (a.yr - b.yr) || (a.mo - b.mo) || (a.cycleNum - b.cycleNum)); // oldest first
  return out;
}

/**
 * A confirmed bank/accounts payment came in lower than the cycle's full approved
 * total — if that gap matches (part of) an outstanding advance, treat it as the
 * advance having been netted off and auto-recover it. Only called against a
 * CONFIRMED payment (bank PDF import / accounts-2026 sync), never against a mere
 * payment-sheet export, so this only fires once real money has actually moved.
 */
async function autoRecoverAdvanceGap(db, userId, gapAmount) {
  if (!(gapAmount > 0.005)) return 0;
  const { data: advances } = await db
    .from('employee_advances')
    .select('id, amount')
    .eq('user_id', userId)
    .eq('status', 'outstanding')
    .order('given_at', { ascending: true });
  if (!advances || !advances.length) return 0;

  const ids = advances.map(a => a.id);
  const { data: recs } = await db
    .from('employee_advance_recoveries').select('advance_id, amount').in('advance_id', ids);
  const recoveredByAdvance = {};
  (recs || []).forEach(r => {
    recoveredByAdvance[r.advance_id] = (recoveredByAdvance[r.advance_id] || 0) + Number(r.amount || 0);
  });

  let budget = gapAmount;
  for (const adv of advances) {
    if (budget <= 0.005) break;
    const remaining = Number(adv.amount) - (recoveredByAdvance[adv.id] || 0);
    if (remaining <= 0.005) continue;
    const take = Math.min(remaining, budget);
    await db.from('employee_advance_recoveries').insert({
      advance_id: adv.id, amount: take, recovered_by_name: 'Auto (Payment Sync)',
    });
    if (take >= remaining - 0.005) {
      await db.from('employee_advances').update({
        status: 'recovered', recovered_at: new Date().toISOString(), recovered_by_name: 'Auto (Payment Sync)',
      }).eq('id', adv.id);
    }
    budget -= take;
  }
  return gapAmount - budget; // total actually recovered
}

// ═════════════════════════════════════════════════════════════════════
// Accounts Portal ADVANCES integration
// Source of truth: accounts-2026.vercel.app (Stockwell Solar ERP).
// - Webhook  (handleAccountsPortalWebhook) — realtime, per-event, idempotent by advance_id.
// - Reconcile (reconcilePortalAdvances)   — cron pull to recover missed webhooks.
// Both write to public.accounts_portal_advances (migration 17). See EMPLOYEE_ADVANCES_INTEGRATION_PLAN.
// ═════════════════════════════════════════════════════════════════════

async function matchEmployeeIdByEmpNo(db, employee_number) {
  if (!employee_number) return null;
  const trimmed = String(employee_number).trim();
  if (!trimmed) return null;
  const { data } = await db
    .from('users')
    .select('id')
    .ilike('emp_no', trimmed)
    .limit(1)
    .maybeSingle();
  return data?.id || null;
}

function normalizeAdvanceEvent(evt) {
  // Accounts Portal sends "employee_advance.given" / "employee_advance.refunded"
  const s = String(evt || '').toLowerCase();
  if (s.includes('refund')) return 'refunded';
  return 'given';
}

async function handleAccountsPortalWebhook(req, res, db) {
  const b = req.body || {};
  const {
    event,
    advance_id,
    employee_name,
    employee_number,
    recipient_id,
    amount,
    date: advance_date,
    narration,
    bank_reference,
    bank,
    outstanding_after,
  } = b;

  if (!advance_id || !employee_number || amount == null) {
    return res.status(400).json({ error: 'advance_id, employee_number, amount are required' });
  }

  const normalizedEvent = normalizeAdvanceEvent(event);
  const matched_employee_id = await matchEmployeeIdByEmpNo(db, employee_number);

  const row = {
    advance_id: String(advance_id),
    event: normalizedEvent,
    employee_number: employee_number || null,
    employee_name: employee_name || null,
    recipient_id: recipient_id || null,
    amount: Number(amount) || 0,
    advance_date: advance_date || null,
    narration: narration || null,
    bank_reference: bank_reference || null,
    bank: bank || null,
    outstanding_after: outstanding_after == null ? null : Number(outstanding_after),
    matched_employee_id,
    raw_payload: b,
  };

  // Idempotent: same advance_id → update in place (keeps latest fields, no duplicate row)
  const { error } = await db
    .from('accounts_portal_advances')
    .upsert(row, { onConflict: 'advance_id' });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true, matched: !!matched_employee_id });
}

async function reconcilePortalAdvances(res, db) {
  // Same Accounts portal + key the reimbursements sync already uses (ACCOUNTS2026_*).
  const baseUrl = process.env.ACCOUNTS_PORTAL_BASE_URL || process.env.ACCOUNTS2026_BASE_URL || 'https://accounts-2026.vercel.app';
  const apiKey = process.env.ACCOUNTS_PORTAL_API_KEY || process.env.ACCOUNTS2026_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Accounts portal API key is not set (ACCOUNTS2026_API_KEY)' });
  }

  let payload;
  try {
    const r = await fetch(`${baseUrl}/api/external/employee-advances?only_outstanding=false&include_entries=true`, {
      headers: { 'x-api-key': apiKey }
    });
    if (r.status === 401) return res.status(502).json({ error: 'Accounts portal rejected the API key (401)' });
    if (!r.ok) return res.status(502).json({ error: `Accounts portal returned HTTP ${r.status}` });
    payload = await r.json();
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach accounts portal: ' + (err.message ?? err) });
  }

  const employees = payload?.data || [];
  // Preload our users table once for emp_no matching
  const { data: users } = await db.from('users').select('id, emp_no').not('emp_no', 'is', null);
  const byEmpNo = new Map((users || []).map(u => [String(u.emp_no).trim().toLowerCase(), u.id]));

  // Existing advance_ids we already know about, so we skip pure no-ops
  const { data: existing } = await db.from('accounts_portal_advances').select('advance_id');
  const knownIds = new Set((existing || []).map(r => r.advance_id));

  const rowsToUpsert = [];
  const summary = { employees: employees.length, upserted: 0, unmatched: 0, skipped_existing: 0 };

  for (const emp of employees) {
    const matched_employee_id = byEmpNo.get(String(emp.employee_number || '').trim().toLowerCase()) || null;
    if (!matched_employee_id) summary.unmatched++;

    // Portal returns per-employee aggregate. Line-wise trail is in `entries` when include_entries=true.
    const entries = Array.isArray(emp.entries) ? emp.entries : [];
    for (const e of entries) {
      // Portal doesn't guarantee an entry-level id — synthesise a stable one so the
      // upsert stays idempotent across reconciliations.
      const type = String(e.type || '').toUpperCase();
      if (type !== 'ADVANCE' && type !== 'REFUND') continue; // CLAIM_ADJUST is handled elsewhere
      const eventNorm = type === 'REFUND' ? 'refunded' : 'given';
      const bankRef = e.bank_reference || '';
      const synthId = `ACCT-${emp.recipient_id || emp.employee_number}-${e.date || ''}-${eventNorm}-${Math.round(Number(e.amount || 0) * 100)}-${bankRef}`;

      if (knownIds.has(synthId)) { summary.skipped_existing++; continue; }
      rowsToUpsert.push({
        advance_id: synthId,
        event: eventNorm,
        employee_number: emp.employee_number || null,
        employee_name: emp.employee_name || null,
        recipient_id: emp.recipient_id || null,
        amount: Number(e.amount) || 0,
        advance_date: e.date || null,
        narration: e.narration || null,
        bank_reference: bankRef || null,
        bank: e.bank || null,
        outstanding_after: emp.outstanding == null ? null : Number(emp.outstanding),
        matched_employee_id,
        raw_payload: { source: 'reconcile', employee: emp, entry: e },
      });
      knownIds.add(synthId);
    }
  }

  if (rowsToUpsert.length) {
    const { error } = await db
      .from('accounts_portal_advances')
      .upsert(rowsToUpsert, { onConflict: 'advance_id' });
    if (error) return res.status(500).json({ error: error.message });
    summary.upserted = rowsToUpsert.length;
  }

  return res.status(200).json(summary);
}


// ═════════════════════════════════════════════════════════════════════
// Accounts Portal EXPENSE-PUSH integration (sender side)
// One-click push of an audit-cleared cycle report (Excel + PDF) to the
// Accounts Portal's upload endpoint. See EMPLOYEE_EXPENSES_PUSH_INTEGRATION_PLAN.
// The x-api-key stays server-side; the browser sends base64 Excel/PDF here.
// ═════════════════════════════════════════════════════════════════════
async function pushClaimToPortal(req, res, db, actingUser, actingProfile) {
  const p = req.body?.push_claim || {};
  const {
    excel_b64, pdf_b64, month, cycle, filename_base,
    user_id, employee_number, employee_name,
    lines: cLines, submitted_total, approved_total,
  } = p;

  if (!excel_b64) return res.status(400).json({ error: 'excel_b64 is required' });

  const baseUrl = process.env.ACCOUNTS_PORTAL_BASE_URL || process.env.ACCOUNTS2026_BASE_URL || 'https://accounts-2026.vercel.app';
  const apiKey = process.env.ACCOUNTS_PORTAL_API_KEY || process.env.ACCOUNTS2026_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Accounts portal API key is not set (ACCOUNTS2026_API_KEY)' });

  const base = (filename_base || 'claim').replace(/[^a-z0-9._-]/gi, '_');

  // Build multipart body (Node 18+/Vercel: global FormData + Blob)
  const form = new FormData();
  const excelBuf = Buffer.from(excel_b64, 'base64');
  form.append('excel', new Blob([excelBuf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }), `${base}.xlsx`);
  if (pdf_b64) {
    const pdfBuf = Buffer.from(pdf_b64, 'base64');
    form.append('pdf', new Blob([pdfBuf], { type: 'application/pdf' }), `${base}.pdf`);
  }
  if (month) form.append('month', month);
  if (cycle) form.append('cycle', cycle);

  let portalRes, portalJson;
  try {
    portalRes = await fetch(`${baseUrl}/api/external/employee-expenses/upload`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: form,
    });
    const text = await portalRes.text();
    try { portalJson = JSON.parse(text); } catch { portalJson = { raw: text }; }
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach Accounts portal: ' + (err.message ?? err) });
  }

  const httpStatus = portalRes.status;

  // ── 200: claim created → record locally, return summary ──
  if (httpStatus === 200 && portalJson?.ok) {
    await recordClaim(db, {
      user_id, employee_number, employee_name,
      month_year: month || portalJson.month, cycle_text: cycle || portalJson.cycle,
      claim_id: portalJson.claim_id, status: 'pushed',
      lines: portalJson.lines ?? cLines, submitted_total, approved_total: portalJson.approved_total ?? approved_total,
      pushed_by: actingUser.id, pushed_by_name: actingProfile.name, response: portalJson,
    });
    return res.status(200).json({ ok: true, ...portalJson });
  }

  // ── 409: already pushed → treat as success (idempotent) ──
  if (httpStatus === 409) {
    await recordClaim(db, {
      user_id, employee_number, employee_name,
      month_year: month, cycle_text: cycle,
      claim_id: portalJson?.claim_id || null, status: 'already_exists',
      lines: cLines, submitted_total, approved_total,
      pushed_by: actingUser.id, pushed_by_name: actingProfile.name, response: portalJson,
    });
    return res.status(200).json({ ok: true, already_exists: true, ...portalJson });
  }

  // ── 401/400/422/500: surface the portal's message verbatim ──
  const msg = portalJson?.error || portalJson?.message || portalJson?.raw || `Accounts portal returned HTTP ${httpStatus}`;
  return res.status(httpStatus === 401 ? 502 : httpStatus).json({ error: msg, portal_status: httpStatus, portal: portalJson });
}

async function recordClaim(db, row) {
  try {
    await db.from('accounts_portal_claims')
      .upsert({ ...row, pushed_at: new Date().toISOString() }, { onConflict: 'user_id,month_year,cycle_text' });
  } catch (_) { /* tracking is best-effort; never block the push result on it */ }
}

/** Great-circle distance between two lat/long points, in metres (Haversine). */
function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Reverse-geocode GPS → a short human place name via OpenStreetMap Nominatim (free, no key).
// Best-effort: any failure/timeout returns null so a check-in never breaks on it.
async function reverseGeocodePlace(lat, lon) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1`;
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'ExpenseTrack-Checkin/1.0 (stockwell-expense)', 'Accept-Language': 'en' },
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    const a = j.address || {};
    const place = a.village || a.town || a.city || a.suburb || a.hamlet || a.municipality || a.county || null;
    const district = a.state_district || a.county || null;
    const parts = [place, district && district !== place ? district : null, a.state].filter(Boolean);
    const name = parts.join(', ');
    return name || j.display_name || null;
  } catch { return null; }
}

// Which of the 3 daily slots a timestamp falls in (IST): morning <12, afternoon 12–4, evening ≥4.
function slotOfIST(iso) {
  const ist = new Date(new Date(iso).getTime() + 5.5 * 3600 * 1000);
  const h = ist.getUTCHours();
  return h < 12 ? 'morning' : h < 16 ? 'afternoon' : 'evening';
}

// Auto-set daily attendance from a check-in, safely:
//  • 2+ distinct slots today → Present ('P'); exactly 1 slot → Half Day ('HD').
//  • Never touches an imported off-day or an HR 'manual' override — only inserts a
//    new row (source 'checkin') or updates a prior 'checkin' row as more slots come in.
async function autoMarkAttendance(db, empNo, istDate) {
  const { data: todays } = await db.from('attendance_checkins')
    .select('checked_at').eq('emp_no', empNo).eq('check_date', istDate);
  const slots = new Set((todays || []).map(c => slotOfIST(c.checked_at)));
  const desired = slots.size >= 2 ? 'P' : 'HD';
  const { data: existing } = await db.from('employee_attendance')
    .select('source_month').eq('emp_no', empNo).eq('att_date', istDate).maybeSingle();
  if (!existing) {
    await db.from('employee_attendance').insert({ emp_no: empNo, att_date: istDate, status: desired, location: 'SITE', source_month: 'checkin' });
    return { status: desired, changed: true };
  }
  if (existing.source_month === 'checkin') {
    await db.from('employee_attendance').update({ status: desired }).eq('emp_no', empNo).eq('att_date', istDate);
    return { status: desired, changed: true };
  }
  return { status: null, changed: false }; // imported off-day or manual override — leave it
}

// Random push check-in scheduler. Called by an external cron (~every 30 min). Each tick:
//  1. marks pending checks past their window as 'missed'
//  2. sends a reminder for pending checks past half-window
//  3. randomly sends a fresh check to on-duty employees (subscribed + checked in today),
//     capped per day with a minimum gap, only during IST work hours.
async function runPushTick(res, db) {
  if (!vapidReady()) return res.status(200).json({ ok: true, skipped: 'VAPID not configured' });
  const now = new Date();
  const istNow = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const istHour = istNow.getUTCHours();
  const istDate = istNow.toISOString().slice(0, 10);
  const WINDOW_MIN = 30, MAX_PER_DAY = 3, MIN_GAP_MIN = 90, WORK_START = 9, WORK_END = 18, PROB = 0.35;
  const result = { sent: 0, reminders: 0, missed: 0 };

  // 1. Mark misses
  const missCutoff = new Date(now.getTime() - WINDOW_MIN * 60000).toISOString();
  const { data: overdue } = await db.from('push_checks').select('id').eq('status', 'pending').lt('sent_at', missCutoff);
  if (overdue?.length) {
    await db.from('push_checks').update({ status: 'missed' }).in('id', overdue.map(r => r.id));
    result.missed = overdue.length;
  }

  // 2. Reminders (pending, past half-window, none sent yet)
  const remCutoff = new Date(now.getTime() - (WINDOW_MIN / 2) * 60000).toISOString();
  const { data: pendingRem } = await db.from('push_checks')
    .select('id, user_id').eq('status', 'pending').eq('reminders_sent', 0).lt('sent_at', remCutoff);
  for (const pc of (pendingRem || [])) {
    const { data: subs } = await db.from('push_subscriptions').select('endpoint, p256dh, auth').eq('user_id', pc.user_id).eq('active', true);
    let ok = false;
    for (const s of (subs || [])) { if (await sendPush(db, s, { title: '⏰ Check-in reminder', body: 'Thoda time bacha hai — abhi check-in karo.', url: '/attendance-checkin.html' })) ok = true; }
    if (ok) { await db.from('push_checks').update({ reminders_sent: 1 }).eq('id', pc.id); result.reminders++; }
  }

  // 3. New random checks — only during work hours
  if (istHour >= WORK_START && istHour < WORK_END) {
    const { data: subs } = await db.from('push_subscriptions').select('user_id, emp_no, endpoint, p256dh, auth').eq('active', true);
    const byEmp = {};
    (subs || []).forEach(s => { const k = String(s.emp_no || '').trim(); if (!k) return; (byEmp[k] ||= { user_id: s.user_id, subs: [] }).subs.push(s); });
    const emps = Object.keys(byEmp);
    if (emps.length) {
      const { data: todayCk } = await db.from('attendance_checkins').select('emp_no').eq('check_date', istDate).in('emp_no', emps);
      const onDuty = new Set((todayCk || []).map(r => String(r.emp_no || '').trim()));
      const { data: todaysChecks } = await db.from('push_checks').select('emp_no, sent_at').eq('check_date', istDate).in('emp_no', emps);
      const cnt = {}, last = {};
      (todaysChecks || []).forEach(r => { const k = String(r.emp_no || '').trim(); cnt[k] = (cnt[k] || 0) + 1; if (!last[k] || r.sent_at > last[k]) last[k] = r.sent_at; });
      for (const emp of emps) {
        if (!onDuty.has(emp)) continue;
        if ((cnt[emp] || 0) >= MAX_PER_DAY) continue;
        if (last[emp] && (now - new Date(last[emp])) < MIN_GAP_MIN * 60000) continue;
        if (Math.random() >= PROB) continue;
        const g = byEmp[emp];
        const { data: created } = await db.from('push_checks').insert({ user_id: g.user_id, emp_no: emp, window_min: WINDOW_MIN, status: 'pending' }).select('id').single();
        let ok = false;
        for (const s of g.subs) { if (await sendPush(db, s, { title: '📍 Site check-in', body: 'Abhi check-in karo — live photo + location (site verify).', url: '/attendance-checkin.html' })) ok = true; }
        if (ok) result.sent++;
        else if (created?.id) await db.from('push_checks').delete().eq('id', created.id); // no live sub → undo
      }
    }
  }

  return res.status(200).json({ ok: true, ...result, ist_hour: istHour });
}
