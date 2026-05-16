import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
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

    const body = req.body || {};
    const { _action, userId } = body;

    // ── Delete User ───────────────────────────────────────────
    if (_action === 'delete') {
      if (profile.role !== 'super_admin')
        return res.status(403).json({ error: 'Only Super Admin can delete users' });
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      if (userId === user.id)
        return res.status(400).json({ error: 'You cannot delete your own account' });

      // 1. Get target user's emp_no for role-mapping cleanup
      const { data: target } = await supabaseAdmin
        .from('users').select('emp_no').eq('id', userId).single();

      // 2. Remove from line_managers (best-effort — silently skip if table missing)
      if (target?.emp_no) {
        try {
          await supabaseAdmin
            .from('line_managers')
            .delete()
            .eq('emp_code', target.emp_no);
        } catch { /* table may not exist yet */ }
      }

      // 3. Nullify user_id on expenses to preserve audit trail
      //    (silently skip if column is NOT NULL — cascade / FK will be handled next)
      try {
        await supabaseAdmin
          .from('expenses')
          .update({ user_id: null })
          .eq('user_id', userId);
      } catch { /* column may not be nullable */ }

      // 4. Delete from public.users (DB record)
      const { error: dbErr } = await supabaseAdmin
        .from('users').delete().eq('id', userId);
      if (dbErr) return res.status(500).json({ error: dbErr.message });

      // 5. Delete from Supabase Auth (removes login access)
      const { error: authDelErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (authDelErr) return res.status(500).json({ error: authDelErr.message });

      return res.status(200).json({ message: 'User deleted successfully' });
    }

    // ── Update User ───────────────────────────────────────────
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const { name, emp_no, phone, site_name, department, role, company_id } = body;
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

  } catch (err) {
    return res.status(500).json({ error: String(err.message ?? err) });
  }
}
