/**
 * POST /api/seed-managers
 * Upserts all L1 line manager records into the line_managers table.
 * Safe to call multiple times (idempotent upsert on emp_code).
 * Protected — requires a valid admin/super_admin Bearer token.
 */
import { createClient } from '@supabase/supabase-js';

const MANAGERS = [
  { emp_code: 'SSS_0160', department: 'O&M',                          manager_name: 'Chirag Panchal',                       contact_number: '7732917204' },
  { emp_code: 'SSS_0010', department: 'Lease',                        manager_name: 'Vijay Singh',                          contact_number: '9352523904' },
  { emp_code: 'SSS_0024', department: 'Liaison',                      manager_name: 'Pintu Bairwa (Arun Sir)',               contact_number: '7891054848' },
  { emp_code: 'SSS_0058', department: 'Compliance',                   manager_name: 'Bhukima Kudiwal',                      contact_number: '7062047980' },
  { emp_code: 'SSS_0064', department: 'Accounts',                     manager_name: 'Peyush Kedia',                         contact_number: '8875533830' },
  { emp_code: 'SSS_0020', department: 'Project - Roof Top, Design',   manager_name: 'Ashok Bharia',                         contact_number: '9529408901' },
  { emp_code: 'SSS_0268', department: 'Project',                      manager_name: 'Pawan Raj Koodi',                      contact_number: '9928096564' },
  { emp_code: 'SSS_0060', department: 'Project',                      manager_name: 'Sagar Gurjar',                         contact_number: '9079370762' },
  { emp_code: 'SSS_0113', department: 'HR & Admin',                   manager_name: 'Navneet Singh',                        contact_number: '9929986281' },
  { emp_code: 'SSS_0050', department: 'Legal',                        manager_name: 'Ritika Sharma (Arun Sir)',             contact_number: '9821585878' },
  { emp_code: 'SSS_0053', department: 'Procurement',                  manager_name: 'Shubham Maheshwari',                   contact_number: '7014635743' },
  { emp_code: 'SSS_0206', department: 'Procurement',                  manager_name: 'Rohit Sharma',                         contact_number: '9983804321' },
  { emp_code: 'SSS_0137', department: 'Transmission Line',            manager_name: 'Ramgopal Sharma',                      contact_number: '9461251687' },
  { emp_code: 'SSS_0197', department: 'Logistics & Supply Chain',     manager_name: 'Ashok Jat',                            contact_number: '7728871812' },
  { emp_code: 'SSS_0189', department: 'Internal Audit & A/C Payable', manager_name: 'Anita',                                contact_number: '8058940971' },
  { emp_code: 'SSS_0309', department: 'Sales',                        manager_name: 'Prashant Kumar Singh (Durgesh Sir)',   contact_number: '6391116991' },
];

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  // Verify caller is an authenticated admin/super_admin
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Missing authorization' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(
    authHeader.split(' ')[1]
  );
  if (authError || !user)
    return res.status(401).json({ error: 'Invalid token' });

  // Check role
  const { data: profile } = await supabase
    .from('users').select('role').eq('id', user.id).single();
  if (!profile || !['admin', 'super_admin'].includes(profile.role))
    return res.status(403).json({ error: 'Admins only' });

  // Upsert — emp_code is the unique key
  const { data, error } = await supabase
    .from('line_managers')
    .upsert(MANAGERS, { onConflict: 'emp_code' })
    .select();

  if (error) return res.status(500).json({ error: error.message });

  return res.json({ success: true, upserted: data.length, records: data });
}
