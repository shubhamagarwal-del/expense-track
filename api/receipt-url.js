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
 *   POST { sync_accounts: true }  → super_admin: pull reimbursed claims from the
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
    const ALLOWED_VIEW_ROLES = ['admin', 'super_admin', 'hr', 'audit'];
    if (!profile || !ALLOWED_VIEW_ROLES.includes(profile.role)) {
      return res.status(403).json({ error: 'Not authorised' });
    }

    // ?payments=1 → all recorded cycle payments (for Paid/Pending display)
    if (req.query?.payments) {
      const { data, error } = await supabaseAdmin
        .from('cycle_payments')
        .select('user_id, month_year, cycle_num, amount_paid, utr_number, bene_name, payment_date');
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ payments: data || [] });
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
      if (!profile || profile.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only a Super Admin can sync from accounts-2026' });
      }
      return await syncAccounts2026(res, supabaseAdmin);
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

    // ── POST { expense_id } → record a receipt view (admin only) ──
    if (req.body?.expense_id) {
      const { data: profile } = await supabaseAdmin.from('users').select('role').eq('id', user.id).single();
      if (!profile || (profile.role !== 'admin' && profile.role !== 'super_admin')) {
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

  const summary = { total: rows.length, marked: [], skippedFailed: [], duplicates: [], unmatched: [], noPending: [] };
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

  const { data: existing } = await db.from('cycle_payments').select('utr_number');
  const existingUtrs = new Set((existing || []).map(p => p.utr_number));

  const summary = { total: claims.length, synced: [], unmatchedEmployee: [], skippedNotReimbursed: [], duplicates: [] };
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
    if (e.status === 'rejected' || e.status === 'l1_rejected') continue;
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
