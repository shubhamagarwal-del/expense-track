import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { identifier } = req.body;
  if (!identifier || !identifier.trim())
    return res.status(400).json({ error: 'Identifier is required' });

  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const id = identifier.trim();

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('email')
    .or(`email.ilike.${id},emp_no.ilike.${id},phone.eq.${id}`)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return res.status(404).json({ error: 'No account found. Try your email address.' });
  }

  return res.status(200).json({ email: data.email });
}
