import { createClient } from '@supabase/supabase-js';

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
    if (['rejected', 'l1_rejected', 'deleted', 'audit_review', 'audit_query', 'superseded'].includes(e.status)) continue;
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
