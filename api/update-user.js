import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

    const { data: profile } = await supabaseAdmin
      .from('users').select('role').eq('id', user.id).single();

    if (!profile || (profile.role !== 'admin' && profile.role !== 'super_admin'))
      return res.status(403).json({ error: 'Forbidden' });

    const body = req.body || {};
    const { _action, userId } = body;

    // ── Purge All Expense Data (Super Admin only) ─────────────
    if (_action === 'purge_expenses') {
      if (profile.role !== 'super_admin')
        return res.status(403).json({ error: 'Only Super Admin can purge expense data' });

      // 1. Count rows before deletion (for success report)
      const { count: totalCount } = await supabaseAdmin
        .from('expenses')
        .select('*', { count: 'exact', head: true });

      // 2. Collect receipt_url values so we can clean storage after delete
      const { data: receiptRows } = await supabaseAdmin
        .from('expenses')
        .select('receipt_url')
        .not('receipt_url', 'is', null);

      // 3. Delete ALL rows from expenses table
      const { error: purgeErr } = await supabaseAdmin
        .from('expenses')
        .delete()
        .not('id', 'is', null);

      if (purgeErr) return res.status(500).json({ error: purgeErr.message });

      // 4. Best-effort: clean up receipt files from storage
      let storageDeleted = 0;
      try {
        if (receiptRows && receiptRows.length > 0) {
          // Extract the storage path (everything after /receipts/ and before any query string)
          const paths = [...new Set(
            receiptRows
              .map(r => {
                if (!r.receipt_url) return null;
                const m = r.receipt_url.match(/\/receipts\/(.+?)(\?|$)/);
                return m ? decodeURIComponent(m[1]) : null;
              })
              .filter(Boolean)
          )];

          // Delete in batches of 100 (Supabase storage limit per call)
          for (let i = 0; i < paths.length; i += 100) {
            try {
              const { data: removed } = await supabaseAdmin.storage
                .from('receipts')
                .remove(paths.slice(i, i + 100));
              storageDeleted += (removed?.length ?? 0);
            } catch { /* storage batch failure is non-fatal */ }
          }
        }
      } catch { /* storage cleanup is best-effort — never fail the whole operation */ }

      return res.status(200).json({
        message: 'All expense data purged successfully',
        deleted: totalCount ?? 0,
        storage_files_deleted: storageDeleted,
      });
    }

    // ── Delete User ───────────────────────────────────────────
    if (_action === 'delete') {
      if (profile.role !== 'super_admin')
        return res.status(403).json({ error: 'Only Super Admin can delete users' });
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      if (userId === user.id)
        return res.status(400).json({ error: 'You cannot delete your own account' });

      // 1. Get target user's emp_no for role-mapping cleanup
      const { data: target } = await supabaseAdmin
        .from('users').select('emp_no').eq('id', userId).single();

      // 2. Remove from line_managers (best-effort — silently skip if table missing)
      if (target?.emp_no) {
        try {
          await supabaseAdmin
            .from('line_managers')
            .delete()
            .eq('emp_code', target.emp_no);
        } catch { /* table may not exist yet */ }
      }

      // 3. Nullify user_id on expenses to preserve audit trail
      //    (silently skip if column is NOT NULL — cascade / FK will be handled next)
      try {
        await supabaseAdmin
          .from('expenses')
          .update({ user_id: null })
          .eq('user_id', userId);
      } catch { /* column may not be nullable */ }

      // 4. Delete from public.users (DB record)
      const { error: dbErr } = await supabaseAdmin
        .from('users').delete().eq('id', userId);
      if (dbErr) return res.status(500).json({ error: dbErr.message });

      // 5. Delete from Supabase Auth (removes login access)
      const { error: authDelErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (authDelErr) return res.status(500).json({ error: authDelErr.message });

      return res.status(200).json({ message: 'User deleted successfully' });
    }

    // ── Update User ───────────────────────────────────────────
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const { name, emp_no, phone, site_name, department, role, company_id } = body;
    const update = {};
    if (name       !== undefined) update.name       = name.trim();
    if (emp_no     !== undefined) update.emp_no     = emp_no.trim();
    if (phone      !== undefined) update.phone      = phone.trim();
    if (site_name  !== undefined) update.site_name  = site_name.trim();
    if (department !== undefined) update.department = department.trim();

    // Only super_admin can change company assignment
    if (company_id !== undefined) {
      if (profile.role !== 'super_admin')
        return res.status(403).json({ error: 'Only Super Admin can change company assignment' });
      update.company_id = company_id;
    }

    // Only super_admin can change roles; also prevent self-role change
    if (role !== undefined) {
      if (profile.role !== 'super_admin')
        return res.status(403).json({ error: 'Only Super Admin can change roles' });
      if (userId === user.id)
        return res.status(400).json({ error: 'You cannot change your own role' });
      update.role = role;
    }

    if (Object.keys(update).length === 0)
      return res.status(400).json({ error: 'No fields to update' });

    const { error } = await supabaseAdmin
      .from('users').update(update).eq('id', userId);
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ message: 'User updated successfully' });

  } catch (err) {
    return res.status(500).json({ error: String(err.message ?? err) });
  }
}
