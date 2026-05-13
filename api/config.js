export default function handler(req, res) {
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key)
    return res.status(500).json({ error: 'Supabase config not set in environment' });

  return res.json({ url, key });
}
