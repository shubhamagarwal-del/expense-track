import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const token = authHeader.split(' ')[1];

  try {
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

    const { path } = req.body;
    if (!path) return res.status(400).json({ error: 'Missing path' });

    // Signed URL valid for 1 hour
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
