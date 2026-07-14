import { createClient } from '@supabase/supabase-js';

/**
 * Audit "checked for payment" marker — independent of approval-workflow status.
 *   GET  → all recorded audit-check rows (expense_id, checked_by_name, checked_at)
 *   POST { expense_ids: [...], checked: true|false } → bulk mark/unmark
 */
export default async function handler(req, res) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: profile } = await supabaseAdmin
    .from('users').select('role, name').eq('id', user.id).single();
  if (!profile || !['audit', 'super_admin'].includes(profile.role)) {
    return res.status(403).json({ error: 'Not authorised' });
  }

  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('expense_audit_checks')
      .select('expense_id, checked_by_name, checked_at');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ checks: data || [] });
  }

  if (req.method === 'POST') {
    const { expense_ids, checked } = req.body || {};
    if (!Array.isArray(expense_ids) || !expense_ids.length)
      return res.status(400).json({ error: 'expense_ids array is required' });

    if (checked) {
      const rows = expense_ids.map(id => ({
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
        .in('expense_id', expense_ids);
      if (error) return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ message: 'OK', count: expense_ids.length });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
