/**
 * GET /api/line-managers
 * Returns all line manager records from Supabase.
 * Cached for 5 minutes at the edge; sessionStorage caches on client.
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
      .from('line_managers')
      .select('*')
      .order('department')
      .order('manager_name');

    // If table doesn't exist yet (PGRST116 / "relation does not exist"),
    // return an empty array so the client can fall back to hardcoded data.
    if (error) {
      const isTableMissing = error.code === 'PGRST116' ||
        (error.message && error.message.includes('does not exist'));
      if (isTableMissing) {
        res.setHeader('Cache-Control', 'no-store');
        return res.json([]);
      }
      return res.status(500).json({ error: error.message });
    }

    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    return res.json(data ?? []);
  } catch (err) {
    // Catch any unexpected runtime error so Vercel never returns plain-text HTML
    return res.status(500).json({ error: String(err.message ?? err) });
  }
}
