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

  if (profile.role !== 'admin' && profile.role !== 'super_admin')
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
      .select('id, status, user_id, users(department)')
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
    } else {
      eligibleIds = expenses
        .filter(e => e.status === 'pending' || e.status === 'l1_approved')
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

    } else {
      // ── Super Admin: two separate updates to preserve L1 data ─
      // Group 1: already l1_approved → only set L2 fields
      const l1DoneIds = expenses
        .filter(e => e.status === 'l1_approved')
        .map(e => e.id)
        .filter(id => eligibleIds.includes(id));

      // Group 2: still pending → set both L1 (auto) + L2
      const pendingIds = expenses
        .filter(e => e.status === 'pending')
        .map(e => e.id)
        .filter(id => eligibleIds.includes(id));

      const l2Only = {
        l2_status:  'approved',
        l2_by:      user.id,
        l2_by_name: profile.name,
        l2_at:      now,
        l2_remark:  'Bulk cycle approval',
        status:     'approved',
      };

      const l1AndL2 = {
        l1_status:  'approved',
        l1_by:      user.id,
        l1_by_name: profile.name,
        l1_at:      now,
        l1_remark:  'Auto-approved (Super Admin bulk)',
        ...l2Only,
      };

      if (l1DoneIds.length > 0) {
        const { error: e1 } = await supabaseAdmin
          .from('expenses').update(l2Only).in('id', l1DoneIds);
        if (e1) return res.status(500).json({ error: e1.message });
      }

      if (pendingIds.length > 0) {
        const { error: e2 } = await supabaseAdmin
          .from('expenses').update(l1AndL2).in('id', pendingIds);
        if (e2) return res.status(500).json({ error: e2.message });
      }
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

  // ── SINGLE mode: { expense_id, action, remark } ─────────────
  const { expense_id, action, approved_amount, remark } = req.body;
  if (!expense_id || !['approved', 'rejected'].includes(action))
    return res.status(400).json({ error: 'Invalid request body' });
  if (action === 'rejected' && !remark?.trim())
    return res.status(400).json({ error: 'A reason is required for rejection' });

  const { data: expense, error: expErr } = await supabaseAdmin
    .from('expenses').select('*, users(department)').eq('id', expense_id).single();
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
    // ── Level 1 (Manager) ──────────────────────────────────────
    if (expense.status !== 'pending')
      return res.status(400).json({ error: 'Expense is not pending L1 approval' });

    update = {
      l1_status:   action,
      l1_by:       user.id,
      l1_by_name:  profile.name,
      l1_at:       now,
      l1_remark:   remark?.trim() || null,
      status:      action === 'approved' ? 'l1_approved' : 'l1_rejected',
    };
    if (action === 'rejected') update.rejection_reason = remark.trim();

  } else {
    // ── Level 2 (Super Admin – Final) ─────────────────────────
    if (!['pending', 'l1_approved'].includes(expense.status))
      return res.status(400).json({ error: 'Expense is not ready for final approval' });

    // Auto-complete L1 if super_admin acts on a pending expense
    if (expense.status === 'pending') {
      update.l1_status  = 'approved';
      update.l1_by      = user.id;
      update.l1_by_name = profile.name;
      update.l1_at      = now;
      update.l1_remark  = 'Auto-approved (Super Admin)';
    }

    update = {
      ...update,
      l2_status:   action,
      l2_by:       user.id,
      l2_by_name:  profile.name,
      l2_at:       now,
      l2_remark:   remark?.trim() || null,
      status:      action === 'approved' ? 'approved' : 'rejected',
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
