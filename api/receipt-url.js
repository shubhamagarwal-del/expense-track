import { createClient } from '@supabase/supabase-js';

/**
 * Combines two related, low-traffic endpoints into one serverless function
 * (Vercel Hobby plan caps deployments at 12 functions):
 *
 *   POST { path }                → original behavior: signed receipt URL
 *   POST { expense_id }          → records that the current admin viewed
 *                                  this expense's receipt (audit log)
 *   GET  ?ids=id1,id2,…          → returns { views: { <expense_id>: <viewed_at> } }
 *                                  for the current admin
 */
export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = authHeader.split(' ')[1];

  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  // ── GET ?ids=... → receipt-view audit lookup (admin only) ──────
  if (req.method === 'GET') {
    const { data: profile } = await supabaseAdmin.from('users').select('role').eq('id', user.id).single();
    if (!profile || (profile.role !== 'admin' && profile.role !== 'super_admin')) {
      return res.status(403).json({ error: 'Not authorised' });
    }
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

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── POST { expense_id } → record a receipt view (admin only) ──
    if (req.body?.expense_id) {
      const { data: profile } = await supabaseAdmin.from('users').select('role').eq('id', user.id).single();
      if (!profile || (profile.role !== 'admin' && profile.role !== 'super_admin')) {
        return res.status(403).json({ error: 'Not authorised' });
      }
      const now = new Date().toISOString();
      const { data, error } = await supabaseAdmin
        .from('expense_views')
        .upsert(
          { expense_id: req.body.expense_id, user_id: user.id, viewed_at: now },
          { onConflict: 'expense_id,user_id' }
        )
        .select('viewed_at')
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ viewed_at: data?.viewed_at || now });
    }

    // ── POST { path } → original behavior: signed receipt URL ─────
    const { path } = req.body;
    if (!path) return res.status(400).json({ error: 'Missing path' });

    const { data, error } = await supabaseAdmin.storage
      .from('receipts')
      .createSignedUrl(path, 3600);

    if (error) return res.status(500).json({ error: error.message });
    if (!data?.signedUrl) return res.status(500).json({ error: 'Could not generate signed URL' });

    return res.status(200).json({ url: data.signedUrl });
  } catch (err) {
    return res.status(500).json({ error: String(err.message ?? err) });
  }
}
