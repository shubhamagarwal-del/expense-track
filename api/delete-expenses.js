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

  const { ids, date_start, date_end } = req.body;

  // Pass 1 — delete by specific UUIDs (user's own pending only)
  if (Array.isArray(ids) && ids.length > 0) {
    await supabaseAdmin.from('expenses').delete()
      .in('id', ids)
      .eq('user_id', user.id)
      .eq('status', 'pending');
  }

  // Pass 2 — date-range sweep for any orphan pending rows that day
  if (date_start && date_end) {
    await supabaseAdmin.from('expenses').delete()
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .gte('created_at', date_start)
      .lte('created_at', date_end);
  }

  return res.status(200).json({ success: true });
}
