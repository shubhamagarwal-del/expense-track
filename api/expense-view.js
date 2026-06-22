import { createClient } from '@supabase/supabase-js';

/**
 * Receipt view audit endpoint.
 *
 *   POST { expense_id }      → upserts a view record for the current admin,
 *                              returns { viewed_at }.
 *   GET  ?ids=id1,id2,…      → returns { views: { <expense_id>: <viewed_at>, … } }
 *                              for the current admin (only the expenses they've
 *                              already seen are included).
 */
export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = authHeader.split(' ')[1];

  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  // Only admins / super_admins can record or query views
  const { data: profile } = await supabaseAdmin
    .from('users').select('role').eq('id', user.id).single();
  if (!profile || (profile.role !== 'admin' && profile.role !== 'super_admin')) {
    return res.status(403).json({ error: 'Not authorised' });
  }

  if (req.method === 'POST') {
    const { expense_id } = req.body || {};
    if (!expense_id) return res.status(400).json({ error: 'Missing expense_id' });

    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('expense_views')
      .upsert(
        { expense_id, user_id: user.id, viewed_at: now },
        { onConflict: 'expense_id,user_id' }
      )
      .select('viewed_at')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ viewed_at: data?.viewed_at || now });
  }

  if (req.method === 'GET') {
    const idsParam = req.query?.ids || '';
    const ids = String(idsParam).split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(200).json({ views: {} });

    const { data, error } = await supabaseAdmin
      .from('expense_views')
      .select('expense_id, viewed_at')
      .eq('user_id', user.id)
      .in('expense_id', ids);

    if (error) return res.status(500).json({ error: error.message });

    const views = {};
    (data || []).forEach(r => { views[r.expense_id] = r.viewed_at; });
    return res.status(200).json({ views });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
