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

  const { userId, name, emp_no, phone, site_name, department, role, company_id } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

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
