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

  const { data: profile } = await supabaseAdmin
    .from('users').select('role').eq('id', user.id).single();

  if (!profile || (profile.role !== 'admin' && profile.role !== 'super_admin'))
    return res.status(403).json({ error: 'Forbidden' });

  const { _action, userId, name, emp_no, phone, site_name, department, role, company_id } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  // ── DELETE user (super_admin only) ────────────────────────
  if (_action === 'delete') {
    if (profile.role !== 'super_admin')
      return res.status(403).json({ error: 'Only Super Admin can delete users' });
    if (userId === user.id)
      return res.status(400).json({ error: 'You cannot delete your own account' });

    // Remove from public.users first (avoids FK issues), then from auth
    await supabaseAdmin.from('users').delete().eq('id', userId);
    const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.status(200).json({ message: 'User deleted successfully' });
  }

  const update = {};
  if (name       !== undefined) update.name       = name.trim();
  if (emp_no     !== undefined) update.emp_no     = emp_no.trim();
  if (phone      !== undefined) update.phone      = phone.trim();
  if (site_name  !== undefined) update.site_name  = site_name.trim();
  if (department !== undefined) update.department = department.trim();

  // Only super_admin can change company assignment
  if (company_id !== undefined) {
    if (profile.role !== 'super_admin')
      return res.status(403).json({ error: 'Only Super Admin can change company assignment' });
    update.company_id = company_id;
  }

  // Only super_admin can change roles; also prevent self-role change
  if (role !== undefined) {
    if (profile.role !== 'super_admin')
      return res.status(403).json({ error: 'Only Super Admin can change roles' });
    if (userId === user.id)
      return res.status(400).json({ error: 'You cannot change your own role' });
    update.role = role;
  }

  if (Object.keys(update).length === 0)
    return res.status(400).json({ error: 'No fields to update' });

  const { error } = await supabaseAdmin
    .from('users').update(update).eq('id', userId);

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ message: 'User updated successfully' });
}
