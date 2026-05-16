/**
 * One-time migration: seed line_managers + update users roles
 * Run: node migrate-managers.mjs
 */
import { createClient } from '@supabase/supabase-js';

// Reads from .env automatically (or set env vars before running)
import { readFileSync } from 'fs';
try {
  const env = readFileSync(new URL('.env', import.meta.url), 'utf8');
  env.split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
} catch {}

const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
  throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env or env vars');

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// ── Manager data ───────────────────────────────────────────────
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
  { emp_code: 'SSS_0050', department: 'Legal',                        manager_name: 'Ritika Sharma (Arun Sir)',              contact_number: '9821585878' },
  { emp_code: 'SSS_0053', department: 'Procurement',                  manager_name: 'Shubham Maheshwari',                   contact_number: '7014635743' },
  { emp_code: 'SSS_0206', department: 'Procurement',                  manager_name: 'Rohit Sharma',                         contact_number: '9983804321' },
  { emp_code: 'SSS_0137', department: 'Transmission Line',            manager_name: 'Ramgopal Sharma',                      contact_number: '9461251687' },
  { emp_code: 'SSS_0197', department: 'Logistics & Supply Chain',     manager_name: 'Ashok Jat',                            contact_number: '7728871812' },
  { emp_code: 'SSS_0189', department: 'Internal Audit & A/C Payable', manager_name: 'Anita',                                contact_number: '8058940971' },
  { emp_code: 'SSS_0309', department: 'Sales',                        manager_name: 'Prashant Kumar Singh (Durgesh Sir)',   contact_number: '6391116991' },
];

async function run() {
  console.log('━━━ ExpenseTrack Manager Migration ━━━\n');

  // ── Step 1: Upsert line_managers table ──────────────────────
  console.log('Step 1: Upserting line_managers table…');
  const { error: lmErr } = await db
    .from('line_managers')
    .upsert(MANAGERS, { onConflict: 'emp_code' });

  if (lmErr) {
    console.warn('  ⚠  line_managers upsert failed (table may not exist yet):', lmErr.message);
    console.warn('     → Run supabase-line-managers.sql in SQL Editor first to create the table.\n');
  } else {
    console.log(`  ✓  ${MANAGERS.length} records upserted into line_managers`);
  }

  // ── Step 2: Update users table ──────────────────────────────
  console.log('\nStep 2: Updating users table (department + role = manager)…');
  let successCount = 0;
  let skipCount    = 0;
  let failCount    = 0;

  for (const m of MANAGERS) {
    const { data, error } = await db
      .from('users')
      .update({ department: m.department, role: 'admin' })
      .eq('emp_no', m.emp_code)
      .select('emp_no, name, department, role');

    if (error) {
      if (error.message.includes('check constraint')) {
        console.error(`  ✗  ${m.emp_code} — role check constraint still blocks 'manager'. Run the SQL fix first.`);
      } else {
        console.error(`  ✗  ${m.emp_code} — ${error.message}`);
      }
      failCount++;
    } else if (!data || data.length === 0) {
      console.log(`  –  ${m.emp_code} (${m.manager_name}) — not found in users table, skipped`);
      skipCount++;
    } else {
      console.log(`  ✓  ${m.emp_code} — ${data[0].name ?? m.manager_name} → dept: "${data[0].department}", role: "${data[0].role}"`);
      successCount++;
    }
  }

  console.log(`\n  Updated: ${successCount}  |  Not found: ${skipCount}  |  Failed: ${failCount}  |  Total: ${MANAGERS.length}`);

  // ── Step 3: Verify ──────────────────────────────────────────
  console.log('\nStep 3: Verification — fetching updated records…');
  const empCodes = MANAGERS.map(m => m.emp_code);
  const { data: verified, error: vErr } = await db
    .from('users')
    .select('emp_no, name, department, role')
    .in('emp_no', empCodes)
    .order('emp_no');

  if (vErr) {
    console.warn('  ⚠  Could not verify:', vErr.message);
  } else {
    console.log('\n  emp_no      name                              department                       role');
    console.log('  ' + '─'.repeat(95));
    for (const u of verified ?? []) {
      const en   = (u.emp_no    ?? '').padEnd(12);
      const name = (u.name      ?? '').padEnd(34);
      const dept = (u.department ?? '').padEnd(33);
      const role = (u.role      ?? '');
      console.log(`  ${en}${name}${dept}${role}`);
    }
  }

  console.log('\n━━━ Done ━━━');
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
