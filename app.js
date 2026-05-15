/* ============================================================
   app.js — Shared Supabase client + utilities
   ============================================================ */

// ── DEPARTMENTS ───────────────────────────────────────
const DEPARTMENTS = ['O&M', 'Project', 'Procurement', 'Account', 'HR', 'Purchase', 'Finance', 'Sales', 'Logistics'];

// ── CONFIG ────────────────────────────────────────────────
// Credentials are loaded from the server (.env). Config is cached in
// sessionStorage so each page only pays the fetch cost once per browser session.
let db; // initialized after config loads (see initSupabase below)
let _cfgCache = null;

async function initSupabase() {
  if (db) return db;
  if (!_cfgCache) {
    const stored = sessionStorage.getItem('_sbcfg');
    if (stored) {
      try { _cfgCache = JSON.parse(stored); } catch { _cfgCache = null; }
    }
    if (!_cfgCache) {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error('Could not load Supabase config from server');
      _cfgCache = await res.json();
      try { sessionStorage.setItem('_sbcfg', JSON.stringify(_cfgCache)); } catch { }
    }
  }
  const { url, key } = _cfgCache;
  db = window.supabase.createClient(url, key, {
    realtime: { params: { eventsPerSecond: 5 } }
  });
  return db;
}

// ── AUTH ──────────────────────────────────────────────────

/** Verify session; redirect to login if missing. Returns user or null. */
async function requireAuth() {
  await initSupabase();
  const { data: { session } } = await db.auth.getSession();
  if (!session) { window.location.href = 'index.html'; return null; }
  return session.user;
}

// In-memory profile cache — cleared when the page unloads (tab closes / navigates)
let _profileCache = null;

/** Fetch the logged-in user's row from the `users` table. Cached per page load. */
async function getUserProfile() {
  if (_profileCache) return _profileCache;
  await initSupabase();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  const { data, error } = await db
    .from('users').select('*').eq('id', user.id).single();
  if (error) { console.error('getUserProfile:', error.message); return null; }
  _profileCache = data;
  return data;
}

/**
 * If profile has must_change_password = true, show a blocking modal
 * so the user sets a new password before doing anything else.
 */
function enforcePasswordChange(profile) {
  if (!profile?.must_change_password) return;

  const overlay = document.createElement('div');
  overlay.id = '_pwd-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:1rem';
  overlay.innerHTML = `
    <div style="background:var(--bg-card,#fff);border-radius:16px;padding:2rem;width:100%;max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,.25)">
      <h2 style="margin:0 0 .5rem;font-size:1.2rem">Set Your Password</h2>
      <p style="margin:0 0 1.25rem;font-size:.85rem;color:var(--text-muted,#666)">
        You are using a default password. Please set a new password to continue.
      </p>
      <div class="form-group" style="margin-bottom:.75rem">
        <label class="form-label">New Password <span style="font-size:.75rem;color:var(--text-muted)">(min 6 chars)</span></label>
        <input id="_pwd-new" type="password" class="form-input" placeholder="Enter new password" minlength="6" />
      </div>
      <div class="form-group" style="margin-bottom:1.25rem">
        <label class="form-label">Confirm Password</label>
        <input id="_pwd-confirm" type="password" class="form-input" placeholder="Re-enter new password" />
      </div>
      <button id="_pwd-btn" class="btn btn-primary" style="width:100%" onclick="submitNewPassword('${profile.id}')">Save Password</button>
      <p id="_pwd-err" style="margin:.75rem 0 0;font-size:.82rem;color:#e53e3e;display:none"></p>
    </div>`;
  document.body.appendChild(overlay);
}

async function submitNewPassword(userId) {
  const newPwd = document.getElementById('_pwd-new').value;
  const confirm = document.getElementById('_pwd-confirm').value;
  const errEl = document.getElementById('_pwd-err');
  const btn = document.getElementById('_pwd-btn');

  errEl.style.display = 'none';
  if (newPwd.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.style.display = 'block'; return; }
  if (newPwd !== confirm) { errEl.textContent = 'Passwords do not match.'; errEl.style.display = 'block'; return; }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  const { error } = await db.auth.updateUser({ password: newPwd });
  if (error) {
    errEl.textContent = error.message;
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Save Password';
    return;
  }

  await db.from('users').update({ must_change_password: false }).eq('id', userId);
  document.getElementById('_pwd-overlay').remove();
  showMessage('Password updated successfully!', 'success');
}

/** Sign out and return to login. */
async function logout() {
  await initSupabase();
  await db.auth.signOut();
  window.location.href = 'index.html';
}

// ── UTILS ─────────────────────────────────────────────────

/** Returns a debounced version of fn that fires after `ms` ms of inactivity. */
function debounce(fn, ms = 250) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

// ── UI HELPERS ────────────────────────────────────────────

/**
 * Show a toast notification (top-right on desktop, bottom on mobile).
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 */
function showMessage(message, type = 'info') {
  const old = document.getElementById('_toast');
  if (old) old.remove();

  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.id = '_toast';
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] ?? 'ℹ️'}</span>
    <span class="toast-msg">${message}</span>`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

/** Toggle a button between its normal and loading state. */
function setLoading(btn, loading) {
  if (loading) {
    btn.dataset.text = btn.textContent;
    btn.innerHTML = `<span class="spinner" style="width:16px;height:16px;border-width:2px"></span> Loading…`;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.text || 'Submit';
    btn.disabled = false;
  }
}

// ── FORMATTING ────────────────────────────────────────────

/** Format a number as Indian Rupee (INR). */
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amount);
}

/** Format an ISO date string as "Apr 29, 2026". */
function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

/** Return a styled status badge HTML string. */
function statusBadge(status) {
  if (status === 'l1_approved') {
    return `<div style="display:inline-flex;flex-direction:column;gap:2px;vertical-align:middle">
      <span class="status-badge badge-l1" style="white-space:nowrap">✓ Mgr Approved</span>
      <span style="font-size:.65rem;color:#1e3a8a;opacity:.8;font-weight:700;padding-left:4px">⏳ Admin Pending</span>
    </div>`;
  }
  const labels = {
    pending: 'Pending',
    l1_rejected: 'Rejected (L1)',
    approved: 'Approved',
    rejected: 'Rejected',
  };
  const cls = {
    pending: 'badge-pending',
    l1_rejected: 'badge-rejected',
    approved: 'badge-approved',
    rejected: 'badge-rejected',
  };
  return `<span class="status-badge ${cls[status] ?? 'badge-pending'}">${labels[status] ?? status}</span>`;
}

/**
 * Render a compact 3-step approval stepper for a single expense row.
 * e must have l1_status and l2_status fields (may be undefined on old rows).
 */
function approvalStepper(e) {
  const l1 = e.l1_status || (e.status === 'approved' ? 'approved' : 'pending');
  const l2 = e.l2_status || (e.status === 'approved' ? 'approved' : 'pending');

  const bg = s => s === 'approved' ? '#d1fae5' : s === 'rejected' ? '#fee2e2' : '#f3f4f6';
  const col = s => s === 'approved' ? '#065f46' : s === 'rejected' ? '#dc2626' : '#6b7280';
  const ico = s => s === 'approved' ? '✓' : s === 'rejected' ? '✗' : '·';

  const step = (label, s) =>
    `<span style="background:${bg(s)};color:${col(s)};border-radius:5px;padding:2px 7px;font-size:0.68rem;font-weight:700;white-space:nowrap">${ico(s)} ${label}</span>`;

  return `<div style="display:flex;align-items:center;gap:3px;flex-wrap:wrap">
    ${step('Filed', 'approved')}
    <span style="color:#d1d5db;font-size:0.7rem">›</span>
    ${step('Manager', l1)}
    <span style="color:#d1d5db;font-size:0.7rem">›</span>
    ${step('Admin', l2)}
  </div>`;
}

/** Return a styled category pill HTML string. */
function catPill(category) {
  const cls = category.replace(/\s+/g, '-');
  return `<span class="cat-pill cp-${cls}">${category}</span>`;
}

// ── SIDEBAR ───────────────────────────────────────────────

/** Open the sidebar overlay (mobile). */
function openSidebar() {
  document.getElementById('sidebar')?.classList.add('active');
  document.getElementById('sidebar-overlay')?.classList.add('active');
  document.body.classList.add('sidebar-open');
}

/** Close the sidebar overlay (mobile). */
function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('active');
  document.getElementById('sidebar-overlay')?.classList.remove('active');
  document.body.classList.remove('sidebar-open');
}

/** Toggle sidebar open/closed. */
function toggleSidebar() {
  const s = document.getElementById('sidebar');
  if (s?.classList.contains('active')) closeSidebar();
  else openSidebar();
}

/** Auto-close mobile sidebar when a nav link is tapped. */
document.addEventListener('click', (e) => {
  const link = e.target.closest('.sidebar-link');
  if (link && window.matchMedia('(max-width: 768px)').matches) {
    closeSidebar();
  }
});

/**
 * Populate the sidebar's user block and conditionally hide
 * the "Add Expense" link for admin users.
 */
function populateSidebar(profile) {
  const initial = (profile.email?.[0] ?? '?').toUpperCase();
  const el = id => document.getElementById(id);

  if (el('sb-avatar')) el('sb-avatar').textContent = initial;
  if (el('sb-email')) el('sb-email').textContent = profile.email;
  if (el('sb-role')) el('sb-role').textContent = profile.role;

  // Admins cannot add expenses
  if (profile.role === 'admin' || profile.role === 'super_admin') {
    if (el('sb-add-link')) el('sb-add-link').style.display = 'none';
  }

  // Only super_admin can create new users
  if (profile.role !== 'super_admin') {
    if (el('sb-create-user-link')) el('sb-create-user-link').style.display = 'none';
  }

  // Manage Users visible to admin + super_admin only
  if (profile.role !== 'admin' && profile.role !== 'super_admin') {
    if (el('sb-manage-users-link')) el('sb-manage-users-link').style.display = 'none';
  }
}


/** 
 * Notify user via Email (Placeholder)
 * To enable real emails, connect a service like Resend or SendGrid.
 */
async function notifyUser(email, status, reason = null) {
  console.log(`[Notification] Sending email to ${email}...`);
  console.log(`[Notification] Subject: Your expense claim was ${status}`);
  if (reason) console.log(`[Notification] Reason: ${reason}`);

  // Real implementation example (using a simple webhook or API)
  /*
  await fetch('YOUR_WEBHOOK_URL', {
    method: 'POST',
    body: JSON.stringify({ email, status, reason })
  });
  */
}


// ── LINE MANAGER DATA ─────────────────────────────────────
let _lmCache = null;

/**
 * Fetch line manager data from Supabase via /api/line-managers.
 * Returns a { department: [{code, name, phone}] } map, or null on failure.
 * Result is cached in sessionStorage for the browser session.
 */
async function fetchLineManagers() {
  if (_lmCache) return _lmCache;

  const stored = sessionStorage.getItem('_lmdata');
  if (stored) {
    try { _lmCache = JSON.parse(stored); return _lmCache; } catch {}
  }

  try {
    const res = await fetch('/api/line-managers');
    if (!res.ok) return null;
    const rows = await res.json();

    // Convert flat rows → { department: [{ code, name, phone }] }
    const map = {};
    rows.forEach(m => {
      if (!map[m.department]) map[m.department] = [];
      map[m.department].push({
        code:  m.emp_code,
        name:  m.manager_name,
        phone: m.contact_number,
      });
    });

    _lmCache = map;
    try { sessionStorage.setItem('_lmdata', JSON.stringify(map)); } catch {}
    return map;
  } catch {
    return null;
  }
}

// ── DATA FETCHING ─────────────────────────────────────────

/**
 * Fetch expenses. RLS on the server automatically scopes the result —
 * employees only get their own rows, admins get every row.
 * @param {{ from?: string, to?: string, userId?: string }} opts
 */
async function fetchExpenses({ from, to, userId, companyId, limit = 500 } = {}) {
  await initSupabase();
  let q = db
    .from('expenses')
    .select('*, users(id,email,name,role,department,site_name,emp_no,phone,bank_holder,bank_name,bank_ifsc,bank_account)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (userId) q = q.eq('user_id', userId);
  if (companyId) q = q.eq('company_id', companyId);
  if (from) q = q.gte('created_at', from);
  if (to) q = q.lte('created_at', to + 'T23:59:59');

  const { data, error } = await q;
  if (error) throw error;
  return data;
}

/**
 * Open a receipt URL safely.
 * Extracts the storage path from the stored URL and fetches a short-lived
 * signed URL from the server — works whether the bucket is public or private.
 */
async function viewReceipt(storedUrl) {
  if (!storedUrl) return;

  // Extract the path after "/receipts/" from the stored URL
  const match = storedUrl.match(/\/receipts\/(.+?)(\?|$)/);
  if (!match) { window.open(storedUrl, '_blank'); return; }

  const path = match[1];
  try {
    await initSupabase();
    const { data: { session } } = await db.auth.getSession();
    const token = session?.access_token;

    const res = await fetch('/api/receipt-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path })
    });
    if (res.ok) {
      const { url } = await res.json();
      window.open(url, '_blank');
    } else {
      window.open(storedUrl, '_blank'); // fallback
    }
  } catch {
    window.open(storedUrl, '_blank'); // fallback
  }
}

/**
 * Compress an image File using Canvas before uploading.
 * Max dimension 1200px, JPEG quality 0.75.
 * PDFs are returned as-is.
 */
function compressImage(file) {
  return new Promise((resolve) => {
    if (file.type === 'application/pdf' || !file.type.startsWith('image/')) {
      resolve(file);
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1200;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => resolve(blob ?? file), 'image/jpeg', 0.75);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

/**
 * Upload a receipt file to Supabase Storage and return its public URL.
 * Images are compressed to max 1200px / JPEG 75% before upload.
 * Returns null on failure.
 */
async function uploadReceipt(file, userId) {
  await initSupabase();

  const compressed = await compressImage(file);
  const ext = compressed.type === 'application/pdf' ? 'pdf' : 'jpg';
  const path = `${userId}/${Date.now()}.${ext}`;

  const { error } = await db.storage.from('receipts').upload(path, compressed, {
    contentType: compressed.type
  });
  if (error) { console.error('Upload error:', error.message); return null; }

  const { data } = db.storage.from('receipts').getPublicUrl(path);
  return data.publicUrl;
}

/** Escape HTML to prevent XSS when rendering user-supplied data. */
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
