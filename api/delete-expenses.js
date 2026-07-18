import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch { req.body = {}; }
  }
  req.body = req.body || {};

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return res.status(401).json({ error: 'Missing authorization' });

  const token = authHeader.split(' ')[1];
  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Verify caller is a real authenticated user
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user)
    return res.status(401).json({ error: 'Invalid token' });

  // ── Admin-side soft delete: { expense_id, reason } ─────────────
  // Marks the row as deleted (with who/when/why) instead of removing it,
  // so the employee still sees it happened and why.
  if (req.body.expense_id) {
    const { data: profile } = await supabaseAdmin
      .from('users').select('role, name').eq('id', user.id).single();
    if (!profile || !['admin', 'super_admin', 'hr', 'audit'].includes(profile.role)) {
      return res.status(403).json({ error: 'Not authorised to delete expenses' });
    }
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to delete an expense' });

    const { error } = await supabaseAdmin.from('expenses').update({
      status: 'deleted',
      deleted_at: new Date().toISOString(),
      deleted_by: user.id,
      deleted_by_name: profile.name,
      deleted_reason: reason,
    }).eq('id', req.body.expense_id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  const { ids, date_start, date_end } = req.body;
  // Pending entries are being replaced by their edited version — no reviewer
  // feedback attached yet, safe to hard-delete. Rejected/l1_rejected/audit_query
  // entries are being resubmitted after reviewer feedback — soft-mark them
  // 'superseded' instead of deleting, so the original submission and the
  // rejection_reason/audit_note stay visible in history instead of vanishing.
  const HARD_DELETE_STATUSES = ['pending'];
  const SOFT_SUPERSEDE_STATUSES = ['rejected', 'l1_rejected', 'audit_query'];
  const now = new Date().toISOString();

  // Pass 1 — by specific UUIDs (user's own rows only)
  if (Array.isArray(ids) && ids.length > 0) {
    await supabaseAdmin.from('expenses').delete()
      .in('id', ids)
      .eq('user_id', user.id)
      .in('status', HARD_DELETE_STATUSES);
    await supabaseAdmin.from('expenses').update({ status: 'superseded', superseded_at: now })
      .in('id', ids)
      .eq('user_id', user.id)
      .in('status', SOFT_SUPERSEDE_STATUSES);
  }

  // Pass 2 — date-range sweep for any orphan rows that day
  if (date_start && date_end) {
    await supabaseAdmin.from('expenses').delete()
      .eq('user_id', user.id)
      .in('status', HARD_DELETE_STATUSES)
      .gte('created_at', date_start)
      .lte('created_at', date_end);
    await supabaseAdmin.from('expenses').update({ status: 'superseded', superseded_at: now })
      .eq('user_id', user.id)
      .in('status', SOFT_SUPERSEDE_STATUSES)
      .gte('created_at', date_start)
      .lte('created_at', date_end);
  }

  return res.status(200).json({ success: true });
}
