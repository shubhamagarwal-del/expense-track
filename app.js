/* ============================================================
   app.js — Shared Supabase client + utilities
   ============================================================ */

// ── DEPARTMENTS ───────────────────────────────────────
const DEPARTMENTS = [
  'Account', 'Compliance', 'Export Improvements', 'Finance', 'HR',
  'Lease', 'Legal', 'Liaison', 'Logistics', 'O&M',
  'Procurement', 'Project', 'Purchase', 'Sales', 'Tender', 'TL',
];

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
      // Use text-first so a plain-text Vercel error never throws SyntaxError
      const cfgText = await res.text();
      try { _cfgCache = JSON.parse(cfgText); } catch {
        throw new Error('Invalid config response from server. Please refresh and try again.');
      }
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
  setTimeout(() => toast.remove(), type === 'error' ? 7000 : 4500);
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

/** Format an ISO timestamp as "29 Apr 2026, 3:30 PM" in local time. */
function formatDateTime(iso) {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

/** Return a styled status badge HTML string. */
function statusBadge(status) {
  const step = (color, bg, label, icon, active) =>
    `<span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;padding:2px 5px;border-radius:4px;${bg ? 'background:'+bg+';' : ''}${active ? 'font-weight:600' : ''}">
      <span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0${active ? ';animation:statusPulse 1.5s ease-in-out infinite' : ''}"></span>
      <span style="color:${color}">${icon}${label}</span>
    </span>`;
  const conn = `<span style="color:#d1d5db;font-size:10px">▸</span>`;
  const flow = (...p) => `<span style="display:inline-flex;align-items:center;gap:1px;vertical-align:middle;flex-wrap:wrap">${p.join(conn)}</span>`;

  const done   = l => step('#059669', '#f0fdf4', l, '✓', false);
  const active = l => step('#2563eb', '#eff6ff', l, '●', true);
  const wait   = l => step('#9ca3af', '', l, '', false);
  const flag   = l => step('#d97706', '#fefce8', l, '⚑', true);
  const rej    = l => step('#dc2626', '#fef2f2', l, '✗', false);
  const approvedTag = `<span class="status-badge badge-approved" style="white-space:nowrap">✓ Approved</span>`;

  if (status === 'pending')       return flow(active('You'), wait('Manager'), wait('HR'), wait('Audit'));
  if (status === 'l1_approved')   return flow(done('You'), done('Manager'), active('HR'), wait('Audit'));
  if (status === 'hr_approved')   return flow(done('You'), done('Manager'), done('HR'), active('Audit'));
  if (status === 'audit_cleared') return flow(done('You'), done('Manager'), done('HR'), done('Audit')) + ' ' + approvedTag;
  if (status === 'audit_review')  return flow(done('You'), done('Manager'), done('HR'), rej('Audit → HR'));
  if (status === 'audit_query')   return flow(done('You'), done('Manager'), done('HR'), rej('Audit'));
  if (status === 'l1_rejected')   return flow(done('You'), rej('Manager'), wait('HR'), wait('Audit'));
  if (status === 'rejected')      return flow(done('You'), rej('Rejected'), wait('HR'), wait('Audit'));
  if (status === 'approved')      return approvedTag;
  if (status === 'deleted')       return `<span class="status-badge" style="background:#fee2e2;color:#991b1b;white-space:nowrap">🗑️ Deleted</span>`;
  if (status === 'superseded')    return `<span class="status-badge" style="background:#f1f5f9;color:#475569;white-space:nowrap">↻ Old Version (Replaced)</span>`;
  return `<span class="status-badge badge-pending">${status}</span>`;
}

/** Return a visual approval pipeline stepper with role icons and status dots. */
function approvalStepper(e) {
  const stat = e.status;
  const isFinal = stat === 'approved' || stat === 'audit_cleared' || stat === 'rejected' || stat === 'l1_rejected' || stat === 'audit_query' || stat === 'deleted' || stat === 'superseded';
  const roles = [
    { key: 'you',     label: 'You',     icon: '🧑', done: true },
    { key: 'manager', label: 'Manager', icon: '👔', done: stat !== 'pending' && stat !== 'l1_rejected' && stat !== 'rejected',
      active: stat === 'pending' },
    { key: 'hr',      label: 'HR',      icon: '🛡️', done: ['hr_approved','audit_cleared','audit_review','audit_query'].includes(stat),
      active: stat === 'l1_approved' },
    { key: 'audit',   label: 'Audit',   icon: '🔍', done: stat === 'audit_cleared',
      active: stat === 'hr_approved' || stat === 'audit_review' },
  ];
  const isRejected = stat === 'rejected' || stat === 'l1_rejected';
  const isQueried  = stat === 'audit_query'; // shown visually like a rejection, at the Audit step

  const dot = (color, pulse) =>
    `<span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0;${pulse ? 'animation:statusPulse 1.5s ease-in-out infinite;box-shadow:0 0 0 3px rgba(37,99,235,0.2)' : ''}"></span>`;

  const segments = roles.map((r, i) => {
    const isRejectedHere = (isRejected && i === 1) || (isQueried && i === 3);
    const isActive = r.active && !isRejected && !isQueried;
    const isDone = r.done && !isRejected && !isRejectedHere;
    const color = isRejectedHere ? '#dc2626' : isDone ? '#059669' : isActive ? '#2563eb' : '#d1d5db';
    const bg = isRejectedHere ? '#fef2f2' : isDone ? '#f0fdf4' : isActive ? '#eff6ff' : '';
    const labelColor = isRejectedHere ? '#dc2626' : isActive ? '#2563eb' : isDone ? '#059669' : '#9ca3af';
    const labelWeight = isActive ? '600' : '400';
    const icon = isRejectedHere ? '✗ ' : isDone ? '✓ ' : isActive ? '● ' : '○ ';
    return `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;${bg ? 'background:'+bg+';' : ''}font-size:11px;font-weight:${labelWeight};color:${labelColor}">
      ${dot(color, isActive)}
      <span>${icon}${r.label}</span>
    </span>`;
  });

  const conn = `<span style="color:#d1d5db;font-size:9px;margin:0 1px">▸</span>`;
  const pipelineInner = segments.join(conn);

  let suffix = '';
  if (isRejected) {
    const rejectedAt = stat === 'l1_rejected' ? 'Manager' : '';
    suffix = `<span style="margin-left:4px;font-size:11px;color:#dc2626;font-weight:600;background:#fef2f2;padding:1px 6px;border-radius:4px">✗ Rejected${rejectedAt ? ' by '+rejectedAt : ''}</span>`;
  } else if (isQueried) {
    suffix = `<span style="margin-left:4px;font-size:11px;color:#dc2626;font-weight:600;background:#fef2f2;padding:1px 6px;border-radius:4px">✗ Rejected by Audit — fix &amp; resubmit</span>`;
  } else if (stat === 'approved' || stat === 'audit_cleared') {
    suffix = `<span style="margin-left:4px;font-size:11px;color:#059669;font-weight:600;background:#f0fdf4;padding:1px 6px;border-radius:4px">✓ Fully Approved</span>`;
  }

  const clickableAttr = !isFinal ? 'cursor:pointer;background:#f8faff;border:1px dashed #bfdbfe;border-radius:8px;padding:4px 8px;margin:-4px -8px;transition:all .15s' : '';
  return `<span class="approval-stepper" data-id="${e.id}" data-status="${stat}" style="display:inline-flex;align-items:center;gap:1px;flex-wrap:wrap;${clickableAttr}" title="${!isFinal ? 'Tap to review or approve this expense' : ''}">${pipelineInner}${!isFinal ? '<span style="font-size:10px;color:#2563eb;font-weight:600;margin-left:6px">👆 Tap</span>' : ''}</span>${suffix}`;
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
 * Populate the sidebar's user block and reveal the role-gated nav
 * links (Add Expense / Create User / Manage Users). These links are
 * hidden by default in the markup to avoid a flash of the wrong links
 * while the profile is still loading; this function shows only the
 * ones the current role is allowed to see.
 */
function populateSidebar(profile) {
  const initial = (profile.email?.[0] ?? '?').toUpperCase();
  const el = id => document.getElementById(id);

  if (el('sb-avatar')) el('sb-avatar').textContent = initial;
  if (el('sb-email')) el('sb-email').textContent = profile.email;
  if (el('sb-role')) el('sb-role').textContent = profile.role;

  const role = profile.role;

  // Employees can add expenses (not admin/hr/audit/super_admin)
  if (!['admin', 'super_admin', 'hr', 'audit'].includes(role)) {
    if (el('sb-add-link')) el('sb-add-link').style.display = '';
  }

  // Create User: super_admin and hr only
  if (role === 'super_admin' || role === 'hr') {
    if (el('sb-create-user-link')) el('sb-create-user-link').style.display = '';
  }

  // Manage Users: admin, hr, super_admin
  if (['admin', 'hr', 'super_admin'].includes(role)) {
    if (el('sb-manage-users-link')) el('sb-manage-users-link').style.display = '';
  }

  // Payment Register: admin, hr, audit, super_admin
  if (['admin', 'hr', 'audit', 'super_admin'].includes(role)) {
    if (el('sb-payment-register-link')) el('sb-payment-register-link').style.display = '';
  }

  // Advances: audit, super_admin only
  if (['audit', 'super_admin'].includes(role)) {
    if (el('sb-advances-link')) el('sb-advances-link').style.display = '';
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

    const text = await res.text();
    if (!text || !text.trimStart().startsWith('[')) {
      try { sessionStorage.removeItem('_lmdata'); } catch {}
      return null;
    }

    let rows;
    try { rows = JSON.parse(text); } catch {
      try { sessionStorage.removeItem('_lmdata'); } catch {}
      return null;
    }

    if (!Array.isArray(rows) || rows.length === 0) return null;

    // Convert flat rows → { department: [{ code, name, phone }] }
    // API now returns data from users table (role='admin') — single source of truth.
    const map = {};
    rows.forEach(m => {
      if (!map[m.department]) map[m.department] = [];
      map[m.department].push({
        code:  m.emp_code,
        name:  m.manager_name,
        phone: m.contact_number,
      });
    });

    if (Object.keys(map).length === 0) return null;

    _lmCache = map;
    try { sessionStorage.setItem('_lmdata', JSON.stringify(map)); } catch {}
    return map;
  } catch {
    return null;
  }
}

// ── DATA FETCHING ─────────────────────────────────────────

// ── Expenses cache ────────────────────────────────────────
// Caches fetchExpenses results (per query-params) in sessionStorage so the
// data is downloaded ONCE per tab session. Moving between pages
// (dashboard ↔ payment register ↔ back) reuses it instantly — no refetch.
// The cache is only refreshed when:
//   • the user reloads the page (F5 / pull-to-refresh) — see reload check below
//   • data changes (create/approve/delete) — invalidateExpensesCache()
// sessionStorage is per-tab and cleared when the tab closes, so the cache
// naturally lasts exactly one browsing session. A long TTL is just a safety
// net against a missed invalidation; it does NOT cause routine refetches.
const EXP_CACHE_TTL = 12 * 60 * 60_000; // 12h safety net (session-scoped in practice)
function _expCacheKey(opts) { return '_expc_' + JSON.stringify(opts || {}); }
function _readExpCache(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > EXP_CACHE_TTL) { sessionStorage.removeItem(key); return null; }
    return data;
  } catch { return null; }
}
function _writeExpCache(key, data) {
  try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); }
  catch { /* quota exceeded — skip caching this payload */ }
}
/** Clear every cached expense fetch. Call after any create/approve/delete. */
function invalidateExpensesCache() {
  try {
    Object.keys(sessionStorage)
      .filter(k => k.startsWith('_expc_'))
      .forEach(k => sessionStorage.removeItem(k));
  } catch {}
}
window.invalidateExpensesCache = invalidateExpensesCache;

// A genuine page reload (F5 / hard refresh / pull-to-refresh) means the user
// wants fresh data — so drop the cache on reload. Plain navigation between
// pages (clicking a sidebar link, back/forward) keeps the cache → instant.
try {
  const _nav = performance.getEntriesByType('navigation')[0];
  if (_nav && _nav.type === 'reload') invalidateExpensesCache();
} catch {}

// Auto-clear the cache whenever a data-changing API call succeeds, so a
// cached list can never go stale after an approval, deletion, or user edit.
(() => {
  const _origFetch = window.fetch.bind(window);
  const MUTATING = ['/api/approve-expense', '/api/delete-expenses', '/api/create-user', '/api/update-user'];
  window.fetch = async (input, init) => {
    const res = await _origFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = ((init && init.method) || (typeof input === 'object' && input && input.method) || 'GET').toUpperCase();
      if (res.ok && method === 'POST' && MUTATING.some(p => url.includes(p))) invalidateExpensesCache();
    } catch {}
    return res;
  };
})();

/**
 * Fetch expenses. RLS on the server automatically scopes the result —
 * employees only get their own rows, admins get every row. Results are
 * cached per query-params (see cache helpers above).
 * @param {{ from?: string, to?: string, userId?: string }} opts
 */
async function fetchExpenses({ from, to, userId, companyId, limit } = {}) {
  const cacheKey = _expCacheKey({ from, to, userId, companyId, limit });
  const cached = _readExpCache(cacheKey);
  if (cached) return cached;

  await initSupabase();
  let q = db
    .from('expenses')
    .select('*, users!expenses_user_id_fkey(id,email,name,role,department,site_name,emp_no,phone,bank_holder,bank_name,bank_ifsc,bank_account)')
    .order('created_at', { ascending: false });

  // Only apply a row cap when explicitly requested.
  // Super Admin calls omit `limit` so Supabase returns up to max_rows (set 100 000 in dashboard).
  if (limit) q = q.limit(limit);

  if (userId)    q = q.eq('user_id', userId);
  if (companyId) q = q.eq('company_id', companyId);
  if (from)      q = q.gte('created_at', from);
  if (to)        q = q.lte('created_at', to + 'T23:59:59');

  const { data, error } = await q;
  if (error) throw error;
  _writeExpCache(cacheKey, data);
  return data;
}

// ── Sites ─────────────────────────────────────────────────
// Single source of truth, shared by add-expense.html and dashboard.html.
const SITE_DATA = [
  {code:'LOC0114',name:"Ajoliya Ka Khera",district:"Chittorgarh"},{code:'LOC0020',name:"Ankhisar-i",district:"Bikaner"},
  {code:'LOC0021',name:"Ankhisar-ii",district:"Bikaner"},{code:'LOC0039',name:"Bachasar-i & Ii",district:"Bikaner"},
  {code:'LOC0015',name:"Badsar",district:"Churu"},{code:'LOC0062',name:"Bamboo",district:"Churu"},
  {code:'LOC0034',name:"Berasar",district:"Bikaner"},{code:'LOC0052',name:"Bhartpur",district:"Bhartpure"},
  {code:'LOC0003',name:"Bidasar",district:"Churu"},{code:'LOC0009',name:"Birmana Tal",district:"Churu"},
  {code:'LOC0002',name:"Budhro Ki Dhani",district:"Bikaner"},{code:'LOC0023',name:"Chitawa",district:"Kuchaman"},
  {code:'LOC0049',name:"Chittod",district:"Chittod"},{code:'LOC0157',name:"Chittorgarh Dairy",district:"Chittorgarh"},
  {code:'LOC0040',name:"Choti Serva",district:"Basdawada"},{code:'LOC0223',name:"CIPET, ASSAM, 80KW (LOA No 414)",district:"ASSAM"},
  {code:'LOC0224',name:"CIPET, BALASORE, 200KW (LOA No 431)",district:"BALASORE"},{code:'LOC0215',name:"CIPET, BANGALORE, 50KW (LOA No 334)",district:"BANGALORE"},
  {code:'LOC0225',name:"CIPET, BHUBANESWAR, 260KW (LOA No 440)",district:"BHUBANESWAR"},{code:'LOC0226',name:"CIPET, BHUBANESWAR, 40KW (LOA No 441)",district:"BHUBANESWAR"},
  {code:'LOC0227',name:"CIPET, BHUBANESWAR, 40KW (LOA No 442)",district:"BHUBANESWAR"},{code:'LOC0220',name:"CIPET, DEHRADUN, 80KW (LOA No 347)",district:"DEHRADUN"},
  {code:'LOC0206',name:"CIPET, HALDIA, 205KW (LOA No 322)",district:"HALDIA"},{code:'LOC0216',name:"CIPET, MYSORE, 110KW (LOA No 335)",district:"MYSORE"},
  {code:'LOC0218',name:"CIPET, SOLAN, 150KW (LOA No 344)",district:"SOLAN"},{code:'LOC0151',name:"CIT Kokrajhar Assam",district:"Kokrajhar"},
  {code:'LOC0211',name:"COFFEE BOARD, BANGALORE, 80KW (LOA No 328)",district:"BANGALORE"},{code:'LOC0217',name:"CWC, BANGALORE, 500KW (LOA No 336)",district:"BANGALORE"},
  {code:'LOC0214',name:"CWC, BANGALORE, 800KW (LOA No 333)",district:"BANGALORE"},{code:'LOC0197',name:"CWC, DELHI, 60KW (LOA 311)",district:"DELHI"},
  {code:'LOC0202',name:"CWC, HABIBPUR, 270 KW (LOA No 308)",district:"HABIBPUR"},{code:'LOC0195',name:"CWC, HABIBPUR, 270KW (LOA No 308)",district:"HABIBPUR"},
  {code:'LOC0200',name:"CWC, NOIDA, 110 KW (LOA No 306)",district:"NOIDA"},{code:'LOC0193',name:"CWC, NOIDA, 110KW (LOA 306)",district:"NOIDA"},
  {code:'LOC0133',name:"Dausar",district:"Didwana-Kuchaman"},{code:'LOC0115',name:"Devliya Kallan",district:"Ajmer"},
  {code:'LOC0208',name:"DGT, HOWRAH, 60KW (LOA No 324)",district:"HOWRAH"},{code:'LOC0032',name:"Dhingsari",district:"Bikaner"},
  {code:'LOC0016',name:"Dhirasar",district:"Churu"},{code:'LOC0141',name:"Dr. Hari Singh Gour Vishwavidyalaya,",district:"Sagar"},
  {code:'LOC0201',name:"EPIP, GB NAGAR, 130 KW (LOA No 307)",district:"GB NAGAR"},{code:'LOC0194',name:"EPIP, GB NAGAR, 130KW (LOA No 307)",district:"GB NAGAR"},
  {code:'LOC0207',name:"FDDI, 24 PARAGANAS, 150KW (LOA No 323)",district:"PARAGANAS"},{code:'LOC0060',name:"Gajroopdesar(2.5 MW)",district:"Bikaner"},
  {code:'LOC0046',name:"Gajroopdesar(4MW)",district:"Bikaner"},{code:'LOC0010',name:"Ghantel",district:"Churu"},
  {code:'LOC0098',name:"Ghatoo",district:"Bikaner"},{code:'LOC0118',name:"Ghewariya",district:"Bhilwara"},
  {code:'LOC0063',name:"Godawanti Tal",district:"Churu"},{code:'LOC0042',name:"Gopasariya-1 (4MW)",district:"Jodhpur"},
  {code:'LOC0103',name:"Gopasariya-2 (2.52MW)",district:"Jodhpur"},{code:'LOC0158',name:"GUVNL Nandesari",district:"Baradara"},
  {code:'LOC0144',name:"GUVNL Vasedi BESS",district:"GUJARAT"},{code:'LOC0035',name:"Himmatsar",district:"Bikaner"},
  {code:'LOC0099',name:"Hiyadesar",district:"Bikaner"},{code:'LOC0205',name:"ICAR, 24 PARAGANAS, 210KW (LOA No 321)",district:"PARAGANAS"},
  {code:'LOC0213',name:"ICAR, BANGALORE, 180KW (LOA No 332)",district:"BANGALORE"},{code:'LOC0198',name:"ICAR, BAREILLY, 120 KW (LOA No 304)",district:"BAREILLY"},
  {code:'LOC0191',name:"ICAR, BAREILLY, 120KW (LOA-304)",district:"BAREILLY"},{code:'LOC0199',name:"ICAR, BAREILLY, 480 KW (LOA No 305)",district:"BAREILLY"},
  {code:'LOC0192',name:"ICAR, BAREILLY, 480KW (LOA-305)",district:"BAREILLY"},{code:'LOC0212',name:"ISI, BANGALORE, 160KW (LOA No 330)",district:"BANGALORE"},
  {code:'LOC0209',name:"ISI, KOLKATA, 345KW (LOA No 325)",district:"KOLKATA"},{code:'LOC0147',name:"ITI (Rajasthan)",district:"JAIPUR"},
  {code:'LOC0054',name:"Jagatpura Rooftop",district:"Jaipur"},{code:'LOC0007',name:"Jamola",district:"Masuda"},
  {code:'LOC0101',name:"Jegla",district:"Bikaner"},{code:'LOC0127',name:"Jetpur",district:"Bikaner"},
  {code:'LOC0132',name:"Jetpura",district:"Didwana-Kuchaman"},{code:'LOC0061',name:"Jhareli II",district:"Bikaner"},
  {code:'LOC0029',name:"Jogniya Ka Bala",district:"Bikaner"},{code:'LOC0154',name:"KAKRA i (B)",district:"Bikaner"},
  {code:'LOC0026',name:"Kakra-i (a)",district:"Bikaner"},{code:'LOC0027',name:"Kakra-ii (a+b)",district:"Bikaner"},
  {code:'LOC0011',name:"Keshloi Tal",district:"Churu"},{code:'LOC0058',name:"Khakholi",district:"Mulasar"},
  {code:'LOC0008',name:"Kherla Nagar",district:"Jodhpur"},{code:'LOC0036',name:"Khunkhuna",district:"Nagour"},
  {code:'LOC0028',name:"Kishnasar",district:"Bikaner"},{code:'LOC0012',name:"Kunpalsar",district:"Bikaner"},
  {code:'LOC0037',name:"Lalasar (4MW)",district:"Bikaner"},{code:'LOC0119',name:"Lalasar-2.52MW",district:"Bikaner"},
  {code:'LOC0221',name:"LBSNAA, DEHRADUN, 350KW (LOA No 348)",district:"DEHRADUN"},{code:'LOC0048',name:"Malpura",district:"Tonk"},
  {code:'LOC0128',name:"Manyana",district:"Bikaner"},{code:'LOC0160',name:"MES Hyderabad AFA",district:"Malkajgiri"},
  {code:'LOC0143',name:"MES MHOW",district:"Indore"},{code:'LOC0065',name:"Mira Road Railway Station",district:"Thane"},
  {code:'LOC0051',name:"Mnit",district:"Jaipur"},{code:'LOC0019',name:"Mukam",district:"Bikaner"},
  {code:'LOC0018',name:"Muknasar",district:"Nagour"},{code:'LOC0004',name:"Nadiya Tal",district:"Churu"},
  {code:'LOC0050',name:"Nagaur Dairy",district:"Nagour"},{code:'LOC0064',name:"Neral Railway Station",district:"Raigad"},
  {code:'LOC0153',name:"NIFT Bhopal",district:"Bhopal"},{code:'LOC0222',name:"NIPER, ASSAM, 400KW (LOA No 406)",district:"ASSAM"},
  {code:'LOC0219',name:"NSTI, DEHRADUN, 60KW (LOA No 346)",district:"DEHRADUN"},{code:'LOC0203',name:"NTH, GHAZIABAD, 100 KW (LOA No 310)",district:"GHAZIABAD"},
  {code:'LOC0196',name:"NTH, GHAZIABAD, 100KW (LOA 310)",district:"GHAZIABAD"},{code:'LOC0210',name:"NTH, KOLKATA, 80KW (LOA No 327)",district:"KOLKATA"},
  {code:'LOC0149',name:"NTPC Faridabad",district:"Faridabad"},{code:'LOC0056',name:"Office",district:"Jaipur"},
  {code:'LOC0059',name:"Pahel & Haspurkalan",district:"Khairtal"},{code:'LOC0038',name:"Pilania Pau",district:"Churu"},
  {code:'LOC0022',name:"Purnada Tall",district:"Bidasar"},{code:'LOC0017',name:"Raimalwara",district:"Jodhpur"},
  {code:'LOC0025',name:"Raisar (1 & 2)",district:"Bikaner"},{code:'LOC0024',name:"Rajaldesar",district:"Churu"},
  {code:'LOC0130',name:"Ramdevra-1 Dungargarh",district:"Bikaner"},{code:'LOC0131',name:"Ramdevra-2 Dungargarh",district:"Bikaner"},
  {code:'LOC0045',name:"Ramdevra-i",district:"Churu"},{code:'LOC0013',name:"Ramdevra-ii",district:"Churu"},
  {code:'LOC0148',name:"Ramgarh Gas Thermal Power Station (RGTPP)",district:"Jaiselmer"},{code:'LOC0047',name:"Raniwada",district:"Jalore"},
  {code:'LOC0006',name:"Ratnania Johra",district:"Churu"},{code:'LOC0145',name:"REMCL Shikhar",district:"Gurugram"},
  {code:'LOC0146',name:"REMCL Srijan",district:"Gurugram"},{code:'LOC0041',name:"Rohisa",district:"Nagour"},
  {code:'LOC0129',name:"Sadu",district:"Churu"},{code:'LOC0014',name:"Sandwa",district:"Churu"},
  {code:'LOC0116',name:"Sarna",district:"Ajmer"},{code:'LOC0043',name:"Satra- 1&2",district:"Churu"},
  {code:'LOC0053',name:"Sau Delhi",district:"Delhi"},{code:'LOC0001',name:"Sindhu",district:"Bikaner"},
  {code:'LOC0104',name:"Somalsar",district:"Bikaner"},{code:'LOC0033',name:"Sowa",district:"Bikaner"},
  {code:'LOC0140',name:"Subhi",district:"Pratapgarh"},{code:'LOC0105',name:"Surawas",district:"Bhilwara"},
  {code:'LOC0030',name:"Surpura-i",district:"Bikaner"},{code:'LOC0031',name:"Surpura-ii",district:"Bikaner"},
  {code:'LOC0142',name:"TENDER",district:"JAIPUR"},{code:'LOC0113',name:"Thaiyat",district:"Jaisalmer"},
  {code:'LOC0005',name:"Udwala",district:"Churu"},{code:'LOC0150',name:"UP METRO",district:"UP"},
  {code:'LOC0055',name:"Vki Warehouse",district:"Jaipur"}
];

const _SITE_BY_NAME = (() => {
  const m = {};
  for (const s of SITE_DATA) m[s.name.trim().toLowerCase()] = s;
  return m;
})();

/**
 * Return a site label that always includes District + LOC code,
 * e.g. "Ajoliya Ka Khera — Chittorgarh — LOC0114".
 * - If the stored value already carries a LOC code, it's returned unchanged
 *   (older saved expenses already had a code-only label appended).
 * - Otherwise the site is looked up by name and District + code are appended
 *   when a match is found in the official list.
 */
function siteWithCode(siteStr) {
  const s = (siteStr == null ? '' : String(siteStr)).trim();
  if (!s) return '';
  if (/\bLOC\d{3,}/i.test(s)) return s;                 // already has a code
  const site = _SITE_BY_NAME[s.toLowerCase()];
  if (!site) return s;
  return siteFullLabel(site);
}

/** Full "Name — District — Code" label for a SITE_DATA entry (falls back to "Name — Code" if no district). */
function siteFullLabel(site) {
  return site.district ? `${site.name} — ${site.district} — ${site.code}` : `${site.name} — ${site.code}`;
}

/** Parse receipt_url: handles a legacy single URL string and a new JSON array string. */
function parseReceiptUrls(val) {
  if (!val) return [];
  if (typeof val === 'string' && val.trim().startsWith('[')) {
    try { return JSON.parse(val).filter(Boolean); } catch {}
  }
  return [val];
}

/** Open expense receipt(s). Shows a picker modal when there are multiple.
 *  expenseId (optional) — if provided, the view is audited via /api/expense-view
 *  so admins can be required to view a receipt before approving. */
function viewExpenseReceipts(urlOrJson, expenseId) {
  const urls = parseReceiptUrls(urlOrJson);
  if (!urls.length) return;
  if (urls.length === 1) { viewReceipt(urls[0], expenseId); return; }

  let picker = document.getElementById('_rcpt-picker');
  if (picker) picker.remove();
  picker = document.createElement('div');
  picker.id = '_rcpt-picker';
  picker.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:1rem';
  picker.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:1.5rem;width:100%;max-width:320px;box-shadow:0 8px 32px rgba(0,0,0,.25)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
        <h3 style="margin:0;font-size:1rem;font-weight:700">View Receipts</h3>
        <button onclick="document.getElementById('_rcpt-picker').remove()" style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:#6b7280">✕</button>
      </div>
      ${urls.map((u, i) => `<button data-url="${escHtml(u)}" style="display:block;width:100%;text-align:left;padding:.6rem .8rem;margin-bottom:.4rem;border:1px solid #e5e7eb;border-radius:8px;cursor:pointer;background:#f9fafb;font-size:.85rem">📎 Receipt ${i + 1}</button>`).join('')}
    </div>`;
  picker.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-url]');
    if (btn) { viewReceipt(btn.dataset.url, expenseId); picker.remove(); return; }
    if (ev.target === picker) picker.remove();
  });
  document.body.appendChild(picker);
}

/**
 * Open a receipt URL safely, in an on-page modal (no tab navigation).
 * Extracts the storage path from the stored URL and fetches a short-lived
 * signed URL from the server — works whether the bucket is public or private.
 * If expenseId is provided, also records the view (admin audit log).
 */
async function viewReceipt(storedUrl, expenseId) {
  if (!storedUrl) return;

  showReceiptModal(null, true);

  const match = storedUrl.match(/\/receipts\/(.+?)(\?|$)/);
  let finalUrl = storedUrl; // fallback
  if (match) {
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
        const text = await res.text();
        try { const d = JSON.parse(text); if (d.url) finalUrl = d.url; } catch {}
      }
    } catch {}
  }

  showReceiptModal(finalUrl, false);

  // Audit: record that this admin has viewed this expense's receipt
  if (expenseId && typeof window.markExpenseAsViewed === 'function') {
    window.markExpenseAsViewed(expenseId);
  }
}

/** Render (or update) the same-page receipt viewer modal. */
function showReceiptModal(url, loading) {
  let modal = document.getElementById('_rcpt-viewer');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = '_rcpt-viewer';
    modal.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.88);display:flex;align-items:center;justify-content:center;padding:1.25rem';
    modal.addEventListener('click', (ev) => { if (ev.target === modal) modal.remove(); });
    document.addEventListener('keydown', function escClose(ev) {
      if (ev.key === 'Escape') { const m = document.getElementById('_rcpt-viewer'); if (m) m.remove(); document.removeEventListener('keydown', escClose); }
    });
    document.body.appendChild(modal);
  }

  if (loading) {
    modal.innerHTML = `<div style="color:#fff;text-align:center;font-size:.85rem">
      <div style="width:30px;height:30px;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:spin .65s linear infinite;margin:0 auto .75rem"></div>
      Loading receipt…
    </div>`;
    return;
  }

  const isPDF = url.toLowerCase().includes('.pdf');
  modal.innerHTML = `
    <div style="position:relative;display:flex;flex-direction:column;align-items:center;max-width:94vw;max-height:94vh">
      <div style="display:flex;gap:.5rem;margin-bottom:.65rem">
        <a href="${url}" target="_blank" rel="noopener" style="background:#fff;color:#1e293b;padding:.45rem 1rem;border-radius:8px;font-size:.8rem;font-weight:700;text-decoration:none">⤓ Open Original</a>
        <button onclick="document.getElementById('_rcpt-viewer').remove()" style="background:#fff;color:#1e293b;border:none;padding:.45rem 1rem;border-radius:8px;font-size:.8rem;font-weight:700;cursor:pointer">✕ Close</button>
      </div>
      ${isPDF
        ? `<iframe src="${escHtml(url)}" style="width:min(94vw,820px);height:min(82vh,1000px);border:none;border-radius:10px;background:#fff"></iframe>`
        : `<img src="${escHtml(url)}" style="max-width:94vw;max-height:82vh;border-radius:10px;box-shadow:0 12px 48px rgba(0,0,0,.5);background:#fff" />`
      }
    </div>`;
}

/**
 * Recover a broken receipt thumbnail when the public URL fails
 * (private Supabase bucket). Called from img onerror.
 * Fetches a signed URL and retries the img src once.
 */
async function loadSignedThumb(img) {
  const storedUrl = img.dataset.storedUrl;
  // Guard: only try once; if no stored URL, fall through to 📄 icon
  if (!storedUrl || img.dataset.signedAttempted) {
    img.style.display = 'none';
    if (!img.parentElement?.querySelector('.receipt-pdf-icon')) {
      img.insertAdjacentHTML('afterend', '<span class="receipt-pdf-icon" style="font-size:1.8rem">📄</span>');
    }
    return;
  }
  img.dataset.signedAttempted = '1';
  try {
    const match = storedUrl.match(/\/receipts\/(.+?)(\?|$)/);
    if (!match) throw new Error('no-match');
    const path = match[1];
    await initSupabase();
    const { data: { session } } = await db.auth.getSession();
    const res = await fetch('/api/receipt-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session?.access_token },
      body: JSON.stringify({ path })
    });
    if (!res.ok) throw new Error('not-ok');
    const text = await res.text();
    const d = JSON.parse(text);
    if (!d.url) throw new Error('no-url');
    img.style.display = '';
    img.src = d.url; // retry with signed URL
  } catch {
    img.style.display = 'none';
    if (!img.parentElement?.querySelector('.receipt-pdf-icon')) {
      img.insertAdjacentHTML('afterend', '<span class="receipt-pdf-icon" style="font-size:1.8rem">📄</span>');
    }
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
