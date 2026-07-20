import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: profile, error: profErr } = await supabaseAdmin
    .from('users').select('role, name, department').eq('id', user.id).single();
  if (profErr || !profile)
    return res.status(403).json({ error: 'Profile not found' });

  const ALLOWED_ROLES = ['admin', 'super_admin', 'hr', 'audit'];
  if (!ALLOWED_ROLES.includes(profile.role))
    return res.status(403).json({ error: 'Not authorised to approve expenses' });

  // ── BULK mode: { expense_ids: [...] } ───────────────────────
  if (Array.isArray(req.body?.expense_ids)) {
    const { expense_ids } = req.body;
    if (expense_ids.length === 0)
      return res.status(400).json({ error: 'expense_ids array is empty' });

    const startTime = Date.now();
    const now = new Date().toISOString();

    // Fetch only the rows we need
    const { data: expenses, error: fetchErr } = await supabaseAdmin
      .from('expenses')
      .select('id, status, user_id, users!expenses_user_id_fkey(department)')
      .in('id', expense_ids);
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });

    // Filter to eligible IDs
    let eligibleIds = [];
    if (profile.role === 'admin') {
      const myDept = (profile.department || '').toLowerCase().trim();
      eligibleIds = expenses
        .filter(e => {
          if (e.status !== 'pending') return false;
          if (myDept) {
            const expDept = (e.users?.department || '').toLowerCase().trim();
            if (expDept && expDept !== myDept) return false;
          }
          return true;
        })
        .map(e => e.id);
    } else if (profile.role === 'hr') {
      eligibleIds = expenses
        .filter(e => e.status === 'l1_approved' || e.status === 'audit_review')
        .map(e => e.id);
    } else if (profile.role === 'audit') {
      eligibleIds = expenses
        .filter(e => e.status === 'hr_approved' || e.status === 'approved')
        .map(e => e.id);
    } else {
      // super_admin: can bulk-approve pending, l1_approved, or hr_approved
      eligibleIds = expenses
        .filter(e => ['pending', 'l1_approved', 'hr_approved'].includes(e.status))
        .map(e => e.id);
    }

    if (eligibleIds.length === 0)
      return res.status(200).json({ approved: 0, skipped: expense_ids.length, elapsed_ms: Date.now() - startTime, message: 'No eligible expenses found' });

    if (profile.role === 'admin') {
      // ── L1 Admin: single update for all pending rows ──────────
      const { error: updateErr } = await supabaseAdmin
        .from('expenses')
        .update({
          l1_status:  'approved',
          l1_by:      user.id,
          l1_by_name: profile.name,
          l1_at:      now,
          l1_remark:  'Bulk cycle approval',
          status:     'l1_approved',
        })
        .in('id', eligibleIds);
      if (updateErr) return res.status(500).json({ error: updateErr.message });

    } else if (profile.role === 'hr') {
      // ── HR: l1_approved / audit_review → hr_approved ─────────
      const { error: updateErr } = await supabaseAdmin
        .from('expenses')
        .update({
          hr_by:      user.id,
          hr_by_name: profile.name,
          hr_at:      now,
          audit_note: null,
          status:     'hr_approved',
        })
        .in('id', eligibleIds);
      if (updateErr) return res.status(500).json({ error: updateErr.message });

    } else if (profile.role === 'audit') {
      // ── Audit: hr_approved → audit_cleared (bulk clear only; flagging
      // a review always requires a per-expense reason, so it isn't a bulk action) ─
      const { error: updateErr } = await supabaseAdmin
        .from('expenses')
        .update({
          audit_by:      user.id,
          audit_by_name: profile.name,
          audit_at:      now,
          audit_note:    null,
          status:        'audit_cleared',
        })
        .in('id', eligibleIds);
      if (updateErr) return res.status(500).json({ error: updateErr.message });

    } else {
      // ── Super Admin: override — move everything to hr_approved ─
      const { error: updateErr } = await supabaseAdmin
        .from('expenses')
        .update({
          l2_status:  'approved',
          l2_by:      user.id,
          l2_by_name: profile.name,
          l2_at:      now,
          l2_remark:  'Bulk override (Super Admin)',
          status:     'hr_approved',
        })
        .in('id', eligibleIds);
      if (updateErr) return res.status(500).json({ error: updateErr.message });
    }

    const elapsed_ms = Date.now() - startTime;
    const skipped = expense_ids.length - eligibleIds.length;
    console.log(`[bulk-approve] approved=${eligibleIds.length} skipped=${skipped} elapsed=${elapsed_ms}ms user=${user.id}`);

    return res.status(200).json({
      approved: eligibleIds.length,
      skipped,
      elapsed_ms,
      message: `${eligibleIds.length} expense${eligibleIds.length !== 1 ? 's' : ''} approved successfully`,
    });
  }

  // ── SINGLE mode: { expense_id, action, remark, audit_note } ──
  const { expense_id, action, approved_amount, remark, audit_note, category } = req.body;
  const validActions = ['approved', 'rejected', 'hr_approved', 'audit_cleared', 'audit_review', 'audit_query', 'update_category'];
  if (!expense_id || !validActions.includes(action))
    return res.status(400).json({ error: 'Invalid request body' });

  // ── Category correction (Audit only) — a metadata fix, not a status transition ──
  if (action === 'update_category') {
    if (profile.role !== 'audit')
      return res.status(403).json({ error: 'Only Audit can change an expense category' });
    const VALID_CATEGORIES = ['Travel', 'Food', 'Hotel Room Rent', 'Printing & Stationery', 'Petrol / Diesel', 'Courier / Parcel', 'Parking'];
    if (!VALID_CATEGORIES.includes(category))
      return res.status(400).json({ error: 'Invalid category' });
    const { error: catErr } = await supabaseAdmin
      .from('expenses').update({ category }).eq('id', expense_id);
    if (catErr) return res.status(500).json({ error: catErr.message });
    return res.status(200).json({ message: 'Category updated', category });
  }

  if (action === 'rejected' && !remark?.trim())
    return res.status(400).json({ error: 'A reason is required for rejection' });
  if ((action === 'audit_review' || action === 'audit_query') && !audit_note?.trim())
    return res.status(400).json({ error: 'A reason is required when flagging for review' });

  const { data: expense, error: expErr } = await supabaseAdmin
    .from('expenses').select('*, users!expenses_user_id_fkey(department)').eq('id', expense_id).single();
  if (expErr || !expense) return res.status(404).json({ error: 'Expense not found' });

  // Department guard: Line Manager can only act on their own department
  if (profile.role === 'admin') {
    const myDept  = (profile.department  || '').toLowerCase().trim();
    const expDept = (expense.users?.department || '').toLowerCase().trim();
    if (myDept && expDept && myDept !== expDept) {
      return res.status(403).json({
        error: `You can only approve expenses from the ${profile.department} department`
      });
    }
  }

  const now = new Date().toISOString();
  let update = {};

  if (profile.role === 'admin') {
    // ── Level 1 (Admin/Manager) ────────────────────────────────
    if (expense.status !== 'pending')
      return res.status(400).json({ error: 'Expense is not pending L1 approval' });

    update = {
      l1_status:   action === 'approved' ? 'approved' : 'rejected',
      l1_by:       user.id,
      l1_by_name:  profile.name,
      l1_at:       now,
      l1_remark:   remark?.trim() || null,
      status:      action === 'approved' ? 'l1_approved' : 'l1_rejected',
    };
    if (action === 'rejected') update.rejection_reason = remark.trim();

  } else if (profile.role === 'hr') {
    // ── HR: l1_approved / audit_review → hr_approved or rejected
    if (!['l1_approved', 'audit_review'].includes(expense.status))
      return res.status(400).json({ error: 'Expense is not ready for HR approval' });

    update = {
      hr_by:      user.id,
      hr_by_name: profile.name,
      hr_at:      now,
      hr_remark:  remark?.trim() || null,
      audit_note: null,
      status:     action === 'approved' ? 'hr_approved' : 'rejected',
    };
    if (action === 'rejected') update.rejection_reason = remark.trim();

  } else if (profile.role === 'audit') {
    // ── Audit: hr_approved / approved (legacy bulk-approved, never went through
    // the hr_approved stage) → audit_cleared, audit_review (flag back to HR),
    // or audit_query (flag back to the Employee to fix and resubmit) ─────
    if (!['hr_approved', 'approved'].includes(expense.status))
      return res.status(400).json({ error: 'Expense is not ready for audit review' });

    update = {
      audit_by:      user.id,
      audit_by_name: profile.name,
      audit_at:      now,
      status:        action,
      audit_note:    (action === 'audit_review' || action === 'audit_query') ? audit_note.trim() : null,
    };

  } else {
    // ── Super Admin: override at any stage ─────────────────────
    const okStatuses = ['pending', 'l1_approved', 'hr_approved', 'audit_review', 'audit_query', 'l1_rejected', 'rejected'];
    if (!okStatuses.includes(expense.status))
      return res.status(400).json({ error: 'Cannot override this expense status' });

    if (expense.status === 'pending') {
      update.l1_status  = 'approved';
      update.l1_by      = user.id;
      update.l1_by_name = profile.name;
      update.l1_at      = now;
      update.l1_remark  = 'Auto-approved (Super Admin override)';
    }

    update = {
      ...update,
      l2_status:   action === 'approved' ? 'approved' : 'rejected',
      l2_by:       user.id,
      l2_by_name:  profile.name,
      l2_at:       now,
      l2_remark:   remark?.trim() || null,
      status:      action === 'approved' ? 'hr_approved' : 'rejected',
    };
    if (action === 'rejected') update.rejection_reason = remark.trim();
  }

  // Optional amount override (only on approval)
  if (action === 'approved' && approved_amount != null && !isNaN(approved_amount)) {
    const parsed = parseFloat(approved_amount);
    if (parsed !== expense.amount) update.approved_amount = parsed;
  }

  const { error: updateErr } = await supabaseAdmin
    .from('expenses').update(update).eq('id', expense_id);
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  return res.status(200).json({ message: 'Success', status: update.status });
}
