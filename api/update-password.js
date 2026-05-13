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

  if (!profile || (profile.role !== 'admin' && profile.role !== 'super_admin')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { userId, newPassword } = req.body;
  if (!userId || !newPassword)
    return res.status(400).json({ error: 'userId and newPassword are required' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    password: newPassword
  });

  if (error) return res.status(400).json({ error: error.message });

  return res.status(200).json({ message: 'Password updated successfully' });
}
