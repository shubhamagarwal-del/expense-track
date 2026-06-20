/**
 * GET /api/line-managers
 * Returns managers built from users table (role = 'admin').
 * Using service role key bypasses RLS — safe because this is read-only public info.
 */
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    const { data, error } = await supabase
      .from('users')
      .select('name, emp_no, department, phone')
      .eq('role', 'admin')
      .order('department')
      .order('name');

    if (error) return res.status(500).json({ error: error.message });

    // Convert to the same flat array format the client already expects:
    // [{ department, manager_name, emp_code, contact_number }]
    const rows = (data ?? [])
      .filter(u => u.department?.trim())
      .map(u => ({
        department:     u.department.trim(),
        manager_name:   u.name    || '',
        emp_code:       u.emp_no  || '',
        contact_number: u.phone   || '',
      }));

    res.setHeader('Cache-Control', 'no-store');
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: String(err.message ?? err) });
  }
}
