-- ============================================================
-- Run this in the OLD Supabase project's SQL Editor
-- (https://yvlagovdcxwmfkefdrnv.supabase.co)
--
-- Run each query SEPARATELY and copy its output.
-- The old project has no companies table and no company_id columns — that's fine.
-- You will create the company manually in the new project after migration.
-- ============================================================


-- ── QUERY 1: Export users ──────────────────────────────────
-- Run this, copy all rows, paste into 03_import_to_new_project.sql
SELECT
  'INSERT INTO public.users (id, email, role, name, emp_no, phone, site_name, department, bank_holder, bank_name, bank_ifsc, bank_account, created_at) VALUES (''' ||
  id || ''', ''' ||
  replace(email, '''', '''''') || ''', ''' ||
  role || ''', ' ||
  CASE WHEN name         IS NULL THEN 'NULL' ELSE '''' || replace(name,         '''', '''''') || '''' END || ', ' ||
  CASE WHEN emp_no       IS NULL THEN 'NULL' ELSE '''' || replace(emp_no,       '''', '''''') || '''' END || ', ' ||
  CASE WHEN phone        IS NULL THEN 'NULL' ELSE '''' || replace(phone,        '''', '''''') || '''' END || ', ' ||
  CASE WHEN site_name    IS NULL THEN 'NULL' ELSE '''' || replace(site_name,    '''', '''''') || '''' END || ', ' ||
  CASE WHEN department   IS NULL THEN 'NULL' ELSE '''' || replace(department,   '''', '''''') || '''' END || ', ' ||
  CASE WHEN bank_holder  IS NULL THEN 'NULL' ELSE '''' || replace(bank_holder,  '''', '''''') || '''' END || ', ' ||
  CASE WHEN bank_name    IS NULL THEN 'NULL' ELSE '''' || replace(bank_name,    '''', '''''') || '''' END || ', ' ||
  CASE WHEN bank_ifsc    IS NULL THEN 'NULL' ELSE '''' || replace(bank_ifsc,    '''', '''''') || '''' END || ', ' ||
  CASE WHEN bank_account IS NULL THEN 'NULL' ELSE '''' || replace(bank_account, '''', '''''') || '''' END || ', ''' ||
  created_at || ''') ON CONFLICT (id) DO UPDATE SET
    role=EXCLUDED.role, name=EXCLUDED.name, emp_no=EXCLUDED.emp_no,
    phone=EXCLUDED.phone, site_name=EXCLUDED.site_name, department=EXCLUDED.department,
    bank_holder=EXCLUDED.bank_holder, bank_name=EXCLUDED.bank_name,
    bank_ifsc=EXCLUDED.bank_ifsc, bank_account=EXCLUDED.bank_account;'
FROM public.users
ORDER BY created_at;


-- ── QUERY 2: Export expenses ───────────────────────────────
-- Run this, copy all rows, paste into 03_import_to_new_project.sql
SELECT
  'INSERT INTO public.expenses (id, user_id, amount, approved_amount, category, description, status, receipt_url, created_at, l1_status, l1_by, l1_by_name, l1_at, l1_remark, l2_status, l2_by, l2_by_name, l2_at, l2_remark, rejection_reason) VALUES (''' ||
  id || ''', ''' ||
  user_id || ''', ' ||
  amount || ', ' ||
  CASE WHEN approved_amount  IS NULL THEN 'NULL' ELSE approved_amount::text END || ', ''' ||
  replace(category, '''', '''''') || ''', ' ||
  CASE WHEN description      IS NULL THEN 'NULL' ELSE '''' || replace(description,      '''', '''''') || '''' END || ', ''' ||
  status || ''', ' ||
  CASE WHEN receipt_url      IS NULL THEN 'NULL' ELSE '''' || replace(receipt_url,      '''', '''''') || '''' END || ', ''' ||
  created_at || ''', ' ||
  CASE WHEN l1_status        IS NULL THEN 'NULL' ELSE '''' || l1_status                               || '''' END || ', ' ||
  CASE WHEN l1_by            IS NULL THEN 'NULL' ELSE '''' || l1_by::text                             || '''' END || ', ' ||
  CASE WHEN l1_by_name       IS NULL THEN 'NULL' ELSE '''' || replace(l1_by_name,       '''', '''''') || '''' END || ', ' ||
  CASE WHEN l1_at            IS NULL THEN 'NULL' ELSE '''' || l1_at                                   || '''' END || ', ' ||
  CASE WHEN l1_remark        IS NULL THEN 'NULL' ELSE '''' || replace(l1_remark,        '''', '''''') || '''' END || ', ' ||
  CASE WHEN l2_status        IS NULL THEN 'NULL' ELSE '''' || l2_status                               || '''' END || ', ' ||
  CASE WHEN l2_by            IS NULL THEN 'NULL' ELSE '''' || l2_by::text                             || '''' END || ', ' ||
  CASE WHEN l2_by_name       IS NULL THEN 'NULL' ELSE '''' || replace(l2_by_name,       '''', '''''') || '''' END || ', ' ||
  CASE WHEN l2_at            IS NULL THEN 'NULL' ELSE '''' || l2_at                                   || '''' END || ', ' ||
  CASE WHEN l2_remark        IS NULL THEN 'NULL' ELSE '''' || replace(l2_remark,        '''', '''''') || '''' END || ', ' ||
  CASE WHEN rejection_reason IS NULL THEN 'NULL' ELSE '''' || replace(rejection_reason, '''', '''''') || '''' END ||
  ') ON CONFLICT (id) DO NOTHING;'
FROM public.expenses
ORDER BY created_at;


-- ── QUERY 3: Auth user list (to fill 04_recreate_auth_users.js) ───
-- Copy this result into the USERS array in 04_recreate_auth_users.js
SELECT
  u.id,
  u.email,
  p.role,
  p.name,
  p.emp_no
FROM auth.users u
JOIN public.users p ON p.id = u.id
ORDER BY u.created_at;
