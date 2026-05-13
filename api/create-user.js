import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vercel may pass body as raw string — parse it if needed
  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch { req.body = {}; }
  }
  req.body = req.body || {};

  // Expect Bearer token from the admin calling this API
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.split(' ')[1];
  
  // URL and Keys should be in environment variables on the server
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({ error: 'Server configuration missing Supabase credentials' });
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

  // Verify the requestor is an admin
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Fetch requestor's profile to check role
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profileError || !profile || (profile.role !== 'admin' && profile.role !== 'super_admin')) {
    return res.status(403).json({ error: 'Forbidden: Only administrators can create users' });
  }

  const { role, name, emp_no, phone, site_name, department, company_id } = req.body;

  if (!phone || !role) {
    return res.status(400).json({ error: `Missing phone or role — received: phone=${JSON.stringify(phone)}, role=${JSON.stringify(role)}, bodyType=${typeof req.body}` });
  }

  const email = `${phone}@expensetrack.internal`;
  const password = '0987654321';

  // 1. Create the user using Supabase Admin API
  const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  if (createError) {
    return res.status(400).json({ error: `[Supabase] ${createError.message} (email=${email})` });
  }

  // 2. Insert their role and details into the users table
  const { error: insertError } = await supabaseAdmin
    .from('users')
    .insert({
      id: newUser.user.id,
      email,
      role,
      name,
      emp_no,
      phone,
      site_name,
      department,
      company_id: company_id || null,
      must_change_password: true
    });

  if (insertError) {
    return res.status(500).json({ error: 'User created in auth, but failed to assign role: ' + insertError.message });
  }

  return res.status(200).json({ message: 'User created successfully', user: newUser.user });
}
