import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET')
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
    .from('users').select('role, company_id').eq('id', user.id).single();

  if (!profile || (profile.role !== 'admin' && profile.role !== 'super_admin')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  let q = supabaseAdmin
    .from('users')
    .select('id, email, name, emp_no, phone, role, site_name, department, company_id, bank_holder, bank_name, bank_ifsc, bank_account')
    .order('name', { ascending: true });

  // Non-super_admin can only see users in their own company
  if (profile.role !== 'super_admin' && profile.company_id) {
    q = q.eq('company_id', profile.company_id);
  }

  const { data: users, error } = await q;

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ users });
}
