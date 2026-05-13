import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: companies, error } = await supabaseAdmin
    .from('companies')
    .select('id, name, code')
    .order('name', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ companies });
}
