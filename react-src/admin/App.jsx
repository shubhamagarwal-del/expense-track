// React port of the HR/admin Site Check-ins view (attendance-checkins.html).
// Same connection pattern as the employee page: uses app.js globals
// (requireAuth, getUserProfile, db, populateSidebar, viewReceipt, showMessage)
// and the same API endpoints — functionality and data are identical.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from '../Sidebar.jsx';

/* global db, XLSX */
const getDb = () => (typeof db !== 'undefined' ? db : window.db);
const getXLSX = () => (typeof XLSX !== 'undefined' ? XLSX : window.XLSX);

const OFF_LABEL = { A: 'Absent', L: 'Leave', CO: 'Comp-off', SUN: 'Sunday', SAT: 'Saturday', H: 'Holiday', 'Paternity Leave': 'Paternity Leave' };
const STATUS_LABEL = { P: 'Present', HD: 'Half Day', A: 'Absent', L: 'Leave', CO: 'Comp-off', H: 'Holiday', SAT: 'Saturday', SUN: 'Sunday', 'Paternity Leave': 'Paternity Leave' };
const STATUS_PICK = ['P', 'HD', 'A', 'L', 'CO', 'H'];
const SLOTS = [
  { key: 'morning', icon: '🌅', label: 'Morning' },
  { key: 'afternoon', icon: '☀️', label: 'Afternoon' },
  { key: 'evening', icon: '🌆', label: 'Evening' },
];
const slotOf = (iso) => {
  const h = new Date(new Date(iso).getTime() + 5.5 * 3600 * 1000).getUTCHours();
  return h < 12 ? 'morning' : h < 16 ? 'afternoon' : 'evening';
};
const attConflict = (r) => (r.att_status && OFF_LABEL[r.att_status] ? OFF_LABEL[r.att_status] : null);

// ── Anti-spoof flag display ──
const FLAG_META = {
  // Confirmed by a second lookup after the first verdict had time to settle.
  vpn: { label: '🛡️ VPN/Proxy', bg: '#fee2e2', col: '#991b1b' },
  // First verdict only. Shown quietly until recheck_vpn either promotes or drops it —
  // a proxy hit on a recycled mobile IP is usually stale reputation data, not a VPN.
  vpn_suspected: { label: '🛡️ VPN? checking', bg: '#f3f4f6', col: '#6b7280' },
  impossible_travel: { label: '⚡ Impossible travel', bg: '#fee2e2', col: '#991b1b' },
  poor_gps: { label: '📡 Weak GPS', bg: '#f3f4f6', col: '#6b7280' },
  // ip_far is deliberately absent: it fired on 417 of 627 check-ins across every
  // employee, because these carriers surface traffic at a distant gateway. Any
  // still stored on old rows simply stop rendering.
};
const rowFlags = (r) => (Array.isArray(r.spoof_flags) ? r.spoof_flags : []);
// "Suspicious" = a real tamper signal (poor_gps alone is just an unreliable fix, not fraud).
const QUIET_FLAGS = new Set(['poor_gps', 'vpn_suspected', 'ip_far']);
const isSuspect = (r) => !!r.blocked || rowFlags(r).some((f) => !QUIET_FLAGS.has(f));
const timeIN = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const th = { textAlign: 'left', padding: '.6rem .8rem', fontWeight: 700 };
const td = { padding: '.55rem .8rem' };
const card = (label, val, col) => (
  <div key={label} style={{ background: 'var(--card-bg,#fff)', border: '1px solid var(--border)', borderRadius: 12, padding: '.75rem 1rem' }}>
    <div style={{ fontSize: '.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{label}</div>
    <div style={{ fontSize: '1.35rem', fontWeight: 800, color: col, marginTop: '.15rem' }}>{val}</div>
  </div>
);

// Sidebar is the shared component imported from ../Sidebar.jsx.

export default function App() {
  const [profile, setProfile] = useState(null);
  const [rows, setRows] = useState([]);
  const [pushChecks, setPushChecks] = useState([]);
  const [date, setDate] = useState(todayStr());
  const [q, setQ] = useState('');
  const [st, setSt] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pingList, setPingList] = useState([]);
  const [subscribed, setSubscribed] = useState(0);
  const [pingVal, setPingVal] = useState('');
  const [pingMsg, setPingMsg] = useState(null); // { ok, text }
  const [geoNames, setGeoNames] = useState({});
  const geoBusy = useRef(false);

  const token = async () => (await getDb().auth.getSession()).data.session?.access_token;

  useEffect(() => {
    (async () => {
      const user = await window.requireAuth();
      if (!user) return;
      const prof = await window.getUserProfile();
      if (!prof) { window.showMessage('Could not load profile.', 'error'); return; }
      if (!['admin', 'hr', 'audit', 'super_admin'].includes(prof.role)) { window.location.href = 'dashboard.html'; return; }
      setProfile(prof);
      loadPingEmployees();
    })();
  }, []);

  useEffect(() => { if (profile && window.populateSidebar) window.populateSidebar(profile); }, [profile]);
  useEffect(() => { if (profile) load(); }, [profile, date]);

  // Settle any suspected-VPN rows in the background, then refresh so the badge that
  // remains is one that survived a second lookup. Runs once per page open; failures
  // are ignored, leaving the rows suspected for the next attempt.
  useEffect(() => {
    if (!profile || !['audit', 'hr', 'super_admin'].includes(profile.role)) return;
    let cancelled = false;
    (async () => {
      try {
        const t = await token();
        const r = await fetch('/api/receipt-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
          body: JSON.stringify({ recheck_vpn: true }),
        });
        const b = await r.json();
        if (!cancelled && r.ok && (b.confirmed || b.cleared)) load(true);
      } catch { /* leave them suspected */ }
    })();
    return () => { cancelled = true; };
  }, [profile]);

  // LIVE updates: Supabase Realtime — the instant a check-in or push-check row
  // changes in the DB, silently refetch so HR sees it without reloading.
  // (Requires migration 22: SELECT policies + realtime publication.)
  useEffect(() => {
    if (!profile) return;
    const ch = getDb().channel('admin-checkins-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_checkins' }, () => load(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'push_checks' }, () => load(true))
      .subscribe();
    return () => { getDb().removeChannel(ch); };
  }, [profile, date]);

  // Fallback: refresh when the tab regains focus + a slow 60s poll (covers any
  // missed realtime event, e.g. after the laptop sleeps).
  useEffect(() => {
    if (!profile) return;
    const refresh = () => { if (document.visibilityState === 'visible') load(true); };
    const iv = setInterval(refresh, 60000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); };
  }, [profile, date]);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(''); }
    try {
      const t = await token();
      const res = await fetch('/api/receipt-url?checkins=1' + (date ? '&date=' + date : ''), { headers: { Authorization: `Bearer ${t}` } });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Load failed');
      setRows(body.checkins || []);
      try {
        const pcRes = await fetch('/api/receipt-url?push_checks=1' + (date ? '&date=' + date : ''), { headers: { Authorization: `Bearer ${t}` } });
        const pcBody = await pcRes.json();
        setPushChecks(pcRes.ok ? (pcBody.push_checks || []) : []);
      } catch { setPushChecks([]); }
    } catch (err) { if (!silent) setError(err.message); /* silent refresh keeps showing last good data */ }
    finally { if (!silent) setLoading(false); }
  }

  async function loadPingEmployees() {
    try {
      const t = await token();
      const res = await fetch('/api/receipt-url?ping_employees=1', { headers: { Authorization: `Bearer ${t}` } });
      const body = await res.json();
      if (!res.ok) return;
      setPingList(body.employees || []);
      setSubscribed(body.subscribed || 0);
    } catch { }
  }

  function resolveEmp(val) {
    const v = (val || '').trim().toLowerCase();
    return pingList.find((e) => `${e.name} — ${e.emp_no}`.toLowerCase() === v)
      || pingList.find((e) => String(e.emp_no).toLowerCase() === v)
      || pingList.find((e) => (e.name || '').toLowerCase() === v)
      || pingList.find((e) => v.includes(String(e.emp_no).toLowerCase()));
  }

  async function pingEmployee() {
    const emp = resolveEmp(pingVal);
    if (!emp) return setPingMsg({ ok: false, text: 'Choose an employee from the list (name or emp no).' });
    setPingMsg({ ok: true, text: 'Sending…' });
    try {
      const t = await token();
      const res = await fetch('/api/receipt-url', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ ping_employee: { user_id: emp.id, emp_no: emp.emp_no } }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed');
      setPingMsg(body.push_enabled
        ? { ok: true, text: `✅ Request sent to ${emp.name} — their phone will ring.` }
        : { ok: true, text: `📝 Recorded for ${emp.name} — notifications aren't ON for them, so no alert rang, but they'll see the request next time they open the app.` });
      setTimeout(load, 1200);
    } catch (err) { setPingMsg({ ok: false, text: 'Failed: ' + err.message }); }
  }

  async function pingAll() {
    if (!confirm('Send a check-in request now to every employee who has notifications enabled?')) return;
    setPingMsg({ ok: true, text: 'Sending…' });
    try {
      const t = await token();
      const res = await fetch('/api/receipt-url', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ ping_all: true }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed');
      setPingMsg({ ok: true, text: `✅ Request sent to ${body.employees} employees.` });
      setTimeout(load, 1200);
    } catch (err) { setPingMsg({ ok: false, text: 'Failed: ' + err.message }); }
  }

  async function setAttendance(emp_no, status) {
    try {
      const t = await token();
      const res = await fetch('/api/receipt-url', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ set_attendance: { emp_no, att_date: date, status } }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Update failed');
      setRows((rs) => rs.map((r) => (String(r.emp_no || '') === emp_no && r.check_date === date ? { ...r, att_status: status, att_source: 'manual' } : r)));
      window.showMessage('Attendance set: ' + (STATUS_LABEL[status] || status), 'success');
    } catch (err) { window.showMessage('Update failed: ' + err.message, 'error'); }
  }

  // ── filtering (same rules as vanilla) ──
  const list = useMemo(() => {
    let l = rows.slice();
    const qq = q.toLowerCase().trim();
    if (qq) l = l.filter((r) => `${r.name || ''} ${r.emp_no || ''} ${r.phone || ''} ${r.site_name || ''} ${r.site_code || ''} ${r.department || ''} ${r.location_name || ''} ${r.nearest_site_name || ''}`.toLowerCase().includes(qq));
    if (st === 'inside') l = l.filter((r) => r.inside_fence === true);
    else if (st === 'outside') l = l.filter((r) => r.inside_fence === false);
    else if (st === 'nofence') l = l.filter((r) => r.inside_fence == null);
    else if (st === 'mismatch') l = l.filter((r) => r.site_mismatch === true);
    else if (st === 'conflict') l = l.filter((r) => attConflict(r));
    else if (st === 'locreq') l = l.filter((r) => r.source === 'notification');
    else if (st === 'suspect') l = l.filter(isSuspect);
    return l;
  }, [rows, q, st]);

  const attRows = useMemo(() => {
    const qq = q.toLowerCase().trim();
    return qq ? rows.filter((r) => `${r.name || ''} ${r.emp_no || ''} ${r.phone || ''} ${r.site_name || ''} ${r.department || ''} ${r.location_name || ''}`.toLowerCase().includes(qq)) : rows;
  }, [rows, q]);

  // ── daily rollup ──
  const rollup = useMemo(() => {
    const byUser = {};
    attRows.forEach((r) => {
      if (r.source === 'notification') return;
      const k = r.user_id || r.emp_no;
      if (!k) return;
      if (!byUser[k]) byUser[k] = { name: r.name, emp_no: r.emp_no, department: r.department, att_status: r.att_status, att_source: r.att_source, slots: {}, suspect: false };
      byUser[k].suspect = byUser[k].suspect || isSuspect(r);
      const s = slotOf(r.checked_at);
      if (!byUser[k].slots[s] || (!byUser[k].slots[s].photo_url && r.photo_url)) {
        byUser[k].slots[s] = { time: timeIN(r.checked_at), photo_url: r.photo_url };
      }
    });
    return Object.values(byUser).sort((a, b) => Object.keys(a.slots).length - Object.keys(b.slots).length || (a.name || '').localeCompare(b.name || ''));
  }, [attRows]);

  const pcByEmp = useMemo(() => {
    const m = {};
    // pushChecks arrives sorted newest-first (server orders by sent_at desc), so the
    // first row seen per employee is their most recent request — used for "last sent by".
    pushChecks.forEach((p) => {
      const k = String(p.emp_no || '').trim(); if (!k) return;
      const t = (m[k] ||= { sent: 0, responded: 0, late: 0, missed: 0, pending: 0, lastSentBy: null });
      t.sent++;
      if (p.status === 'responded') t.responded++;
      else if (p.status === 'late') t.late++;
      else if (p.status === 'missed') t.missed++;
      else if (p.status === 'pending') t.pending++;
      if (t.lastSentBy === null) t.lastSentBy = p.sent_by_name || 'Automatic';
    });
    return m;
  }, [pushChecks]);

  // ── geocode fallback for rows without a stored place name ──
  useEffect(() => {
    (async () => {
      if (geoBusy.current) return;
      const need = list.filter((r) => !r.location_name && r.latitude != null && r.longitude != null);
      if (!need.length) return;
      geoBusy.current = true;
      try {
        const cache = JSON.parse(localStorage.getItem('geo_cache') || '{}');
        for (const r of need) {
          const key = (+r.latitude).toFixed(4) + ',' + (+r.longitude).toFixed(4);
          if (cache[key]) { setGeoNames((g) => ({ ...g, [key]: cache[key] })); continue; }
          try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${r.latitude}&lon=${r.longitude}&zoom=14&addressdetails=1`, { headers: { 'Accept-Language': 'en' } });
            if (res.ok) {
              const j = await res.json(), a = j.address || {};
              const place = a.village || a.town || a.city || a.suburb || a.hamlet || a.municipality || a.county;
              const dist = a.state_district || a.county;
              const name = [place, dist && dist !== place ? dist : null, a.state].filter(Boolean).join(', ') || j.display_name;
              if (name) { cache[key] = name; setGeoNames((g) => ({ ...g, [key]: name })); }
            }
          } catch { }
          await new Promise((res2) => setTimeout(res2, 1100));
        }
        localStorage.setItem('geo_cache', JSON.stringify(cache));
      } finally { geoBusy.current = false; }
    })();
  }, [list]);

  function exportExcel() {
    const xlsx = getXLSX();
    if (!xlsx) return window.showMessage('Excel library not loaded — refresh and retry.', 'error');
    if (!list.length) return window.showMessage('No check-ins to export.', 'error');
    const statusText = (r) => (r.inside_fence === true ? 'Inside' : r.inside_fence === false ? 'Outside' : 'No fence');
    const data = list.map((r) => ({
      'Employee': r.name || '', 'Emp No': r.emp_no || '', 'Phone': r.phone || '', 'Department': r.department || '',
      'Site': r.site_name || '', 'Site Code': r.site_code || '',
      'Slot': { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' }[slotOf(r.checked_at)] || '',
      'Status': statusText(r),
      'Distance (m)': r.distance_m != null ? r.distance_m : '',
      'Site Mismatch': r.site_mismatch ? 'YES' : '',
      'Nearest Site': r.nearest_site_name || '',
      'Nearest (m)': r.nearest_distance_m != null ? r.nearest_distance_m : '',
      'Attendance Conflict': attConflict(r) || '',
      'VPN/Proxy': r.ip_proxy ? 'YES' : '',
      'IP Type': r.ip_type || '',
      'IP City': r.ip_city || '',
      'IP Country': r.ip_country || '',
      'IP↔GPS (km)': r.ip_gps_km != null ? r.ip_gps_km : '',
      'Spoof Flags': [...rowFlags(r), r.blocked ? 'blocked' : null].filter(Boolean).join(', '),
      'IP': r.ip_address || '',
      'Place': r.location_name || '',
      'Latitude': r.latitude != null ? r.latitude : '', 'Longitude': r.longitude != null ? r.longitude : '',
      'Accuracy (m)': r.accuracy_m != null ? r.accuracy_m : '',
      'Photo': r.photo_url || '',
      'Time': new Date(r.checked_at).toLocaleString('en-IN'),
      'Google Maps': r.latitude != null && r.longitude != null ? `https://www.google.com/maps?q=${r.latitude},${r.longitude}` : '',
    }));
    const ws = xlsx.utils.json_to_sheet(data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Check-ins');
    xlsx.writeFile(wb, `site-checkins-${date || 'all'}.xlsx`);
  }

  // ── summary ──
  const emps = new Set(list.map((r) => r.user_id)).size;
  const inside = list.filter((r) => r.inside_fence === true).length;
  const outside = list.filter((r) => r.inside_fence === false).length;
  const mismatch = list.filter((r) => r.site_mismatch === true).length;
  const conflict = list.filter((r) => attConflict(r)).length;
  const locreq = list.filter((r) => r.source === 'notification').length;
  const suspect = list.filter(isSuspect).length;

  const verifyCell = (empNo) => {
    const p = pcByEmp[String(empNo || '').trim()];
    if (!p || !p.sent) return <span style={{ color: 'var(--text-muted)', fontSize: '.72rem' }}>—</span>;
    const col = p.missed ? '#991b1b' : p.late ? '#854d0e' : p.responded === p.sent ? '#166534' : '#6b7280';
    return (
      <span style={{ fontWeight: 700, fontSize: '.75rem', color: col }} title={`Last sent by: ${p.lastSentBy}`}>
        {p.responded}/{p.sent} ✓
        {p.late ? <span style={{ color: '#854d0e' }}> · {p.late} late</span> : null}
        {p.missed ? <span style={{ color: '#991b1b' }}> · {p.missed} missed</span> : null}
        {p.pending ? <span style={{ color: '#6b7280' }}> · {p.pending} pending</span> : null}
      </span>
    );
  };

  const badge = (txt, bg, col) => <span style={{ background: bg, color: col, borderRadius: 5, padding: '1px 7px', fontSize: '.7rem', fontWeight: 700 }}>{txt}</span>;

  return (
    <div className="app-layout">
      <Sidebar active="checkins-react.html" />
      <div className="app-main">
        <header className="topbar">
          <button className="topbar-menu" onClick={() => window.toggleSidebar()} aria-label="Open menu">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <span className="topbar-title">📍 Site Check-ins</span>
          <div className="topbar-right"></div>
        </header>

        <main className="page-content">
          <div style={{ marginBottom: '1rem' }}>
            <h1 style={{ margin: '0 0 .25rem', fontSize: '1.4rem', fontWeight: 800 }}>📍 Site Check-ins</h1>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '.88rem' }}>Who checked in where, when, inside/outside the fence — with GPS location.</p>
          </div>

          {/* Send check-in request */}
          <div style={{ background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 14, padding: '1rem 1.25rem', marginBottom: '1rem' }}>
            <div style={{ fontWeight: 800, fontSize: '.95rem', color: '#3730a3', marginBottom: '.15rem' }}>🔔 Send check-in request</div>
            <div style={{ fontSize: '.78rem', color: '#4338ca', marginBottom: '.7rem' }}>Ask an employee for a live photo + location right now — their phone will ring.</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.6rem', alignItems: 'center' }}>
              <input list="ping-emp-list" value={pingVal} onChange={(e) => setPingVal(e.target.value)} placeholder="Employee name or emp no…" autoComplete="off"
                className="form-input" style={{ height: 38, flex: 1, minWidth: 200 }} />
              <datalist id="ping-emp-list">
                {pingList.map((e) => <option key={e.emp_no} value={`${e.name} — ${e.emp_no}`}>{e.has_push ? '🔔 on' : 'notifications off'}</option>)}
              </datalist>
              <button onClick={pingEmployee} style={{ height: 38, background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 8, padding: '0 1.1rem', fontWeight: 800, fontSize: '.82rem', cursor: 'pointer' }}>🔔 Send</button>
              <button onClick={pingAll} style={{ height: 38, background: '#fff', color: '#4f46e5', border: '1px solid #c7d2fe', borderRadius: 8, padding: '0 1rem', fontWeight: 800, fontSize: '.82rem', cursor: 'pointer' }}>Send to all ({subscribed})</button>
            </div>
            {pingMsg && <div style={{ fontSize: '.8rem', marginTop: '.5rem', color: pingMsg.ok ? '#166534' : '#991b1b', fontWeight: 700 }}>{pingMsg.text}</div>}
          </div>

          {/* Filters */}
          <div style={{ background: 'var(--card-bg,#fff)', border: '1px solid var(--border)', borderRadius: 14, padding: '1rem 1.25rem', marginBottom: '1rem', display: 'flex', flexWrap: 'wrap', gap: '.75rem', alignItems: 'end' }}>
            <div>
              <label style={{ display: 'block', fontSize: '.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '.3rem' }}>Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="form-input" style={{ height: 38 }} />
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label style={{ display: 'block', fontSize: '.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '.3rem' }}>Search (employee / site)</label>
              <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, emp no, or site…" className="form-input" style={{ height: 38 }} />
            </div>
            <div style={{ minWidth: 140 }}>
              <label style={{ display: 'block', fontSize: '.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '.3rem' }}>Status</label>
              <select value={st} onChange={(e) => setSt(e.target.value)} className="form-select" style={{ height: 38 }}>
                <option value="all">All</option>
                <option value="inside">Inside fence</option>
                <option value="outside">Outside fence</option>
                <option value="nofence">No fence</option>
                <option value="mismatch">Site mismatch</option>
                <option value="conflict">Attendance conflict</option>
                <option value="locreq">🔔 Location requests</option>
                <option value="suspect">🚩 Suspicious (VPN / spoof)</option>
              </select>
            </div>
            <div>
              <button onClick={exportExcel} style={{ height: 38, background: '#15803d', color: '#fff', border: 'none', borderRadius: 8, padding: '0 1rem', fontWeight: 700, fontSize: '.82rem', cursor: 'pointer' }}>⤓ Excel</button>
            </div>
          </div>

          {/* Summary */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '.75rem', marginBottom: '1rem' }}>
            {card('Check-ins', list.length, '#4f46e5')}
            {card('Present (employees)', emps, '#0e7490')}
            {card('✅ Inside', inside, '#166534')}
            {card('⚠️ Outside', outside, '#92400e')}
            {card('📍 Site mismatch', mismatch, '#b45309')}
            {card('🔴 Att. conflict', conflict, '#991b1b')}
            {card('🔔 Location requests', locreq, '#4338ca')}
            {card('🚩 Suspicious', suspect, '#dc2626')}
          </div>

          {/* Daily rollup */}
          <div style={{ fontSize: '.8rem', fontWeight: 800, color: 'var(--text-1)', margin: '.25rem 0 .5rem' }}>📋 Daily attendance — 3 check-ins (Morning / Afternoon / Evening)</div>
          <div style={{ background: 'var(--card-bg,#fff)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', marginBottom: '1.25rem' }}>
            {loading ? <div className="loading-state"><div className="spinner"></div><span>Loading…</span></div>
              : rollup.length === 0 ? <div style={{ padding: '1.25rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '.85rem' }}>No check-ins for this day.</div>
              : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.83rem' }}>
                    <thead style={{ background: 'var(--bg-2,#f4f4f5)' }}>
                      <tr>
                        <th style={th}>Employee</th>
                        {SLOTS.map((s) => <th key={s.key} style={{ ...th, textAlign: 'center', padding: '.6rem .5rem' }}>{s.icon} {s.label}</th>)}
                        <th style={{ ...th, textAlign: 'center', padding: '.6rem .5rem' }}>Slots</th>
                        <th style={{ ...th, textAlign: 'center', padding: '.6rem .5rem' }} title="Check-in requests: responded/sent">🔔 Verify</th>
                        <th style={th}>Attendance (editable)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rollup.map((e) => {
                        const n = Object.keys(e.slots).length;
                        const cur = e.att_status || (n >= 2 ? 'P' : 'HD');
                        const opts = STATUS_PICK.includes(cur) ? STATUS_PICK : [cur, ...STATUS_PICK];
                        const slotLabel = n >= 3 ? '🟢 3/3' : n === 2 ? '🟡 2/3' : '🟠 1/3';
                        const slotCss = n >= 3 ? { background: '#dcfce7', color: '#166534' } : n === 2 ? { background: '#fef9c3', color: '#854d0e' } : { background: '#ffedd5', color: '#9a3412' };
                        return (
                          <tr key={e.emp_no || e.name} style={{ borderTop: '1px solid var(--border)' }}>
                            <td style={td}>
                              <div style={{ fontWeight: 600 }}>{e.name || '—'}{e.suspect && <span title="Suspicious check-in (VPN / spoof) — see All check-ins below" style={{ marginLeft: 5, color: '#dc2626', fontWeight: 800 }}>🚩</span>}</div>
                              <div style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>{e.emp_no || ''}{e.department ? ' · ' + e.department : ''}</div>
                            </td>
                            {SLOTS.map((s) => {
                              const sl = e.slots[s.key];
                              return (
                                <td key={s.key} style={{ ...td, textAlign: 'center', padding: '.55rem .5rem' }}>
                                  {!sl ? <span style={{ color: '#cbd5e1', fontWeight: 700 }}>✗</span> : (
                                    <>
                                      <span style={{ color: '#166534', fontWeight: 700, fontSize: '.75rem' }}>✓ {sl.time}</span>
                                      {sl.photo_url && <button onClick={() => window.viewReceipt(sl.photo_url)} title="Photo" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.85rem', padding: 0, marginLeft: 4 }}>📷</button>}
                                    </>
                                  )}
                                </td>
                              );
                            })}
                            <td style={{ ...td, textAlign: 'center', padding: '.55rem .5rem' }}>
                              <span style={{ ...slotCss, borderRadius: 6, padding: '2px 8px', fontSize: '.72rem', fontWeight: 800, whiteSpace: 'nowrap' }}>{slotLabel}</span>
                            </td>
                            <td style={{ ...td, textAlign: 'center', padding: '.55rem .5rem' }}>{verifyCell(e.emp_no)}</td>
                            <td style={td}>
                              <select value={cur} disabled={!e.emp_no} onChange={(ev) => setAttendance(e.emp_no, ev.target.value)}
                                style={{ height: 32, border: '1px solid var(--border)', borderRadius: 7, padding: '0 .4rem', fontFamily: 'inherit', fontSize: '.8rem', fontWeight: 700, background: '#fff', color: 'var(--text-1)', cursor: 'pointer' }}>
                                {opts.map((v) => <option key={v} value={v}>{STATUS_LABEL[v] || v}</option>)}
                              </select>
                              {e.att_source === 'manual' ? <div style={{ fontSize: '.62rem', color: '#7c3aed', fontWeight: 700, marginTop: 2 }}>✏️ Set by HR</div>
                                : e.att_source === 'checkin' ? <div style={{ fontSize: '.62rem', color: 'var(--text-muted)', marginTop: 2 }}>auto (check-in)</div>
                                : e.att_source ? <div style={{ fontSize: '.62rem', color: 'var(--text-muted)', marginTop: 2 }}>imported</div> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </div>

          {/* Detail table */}
          <div style={{ fontSize: '.8rem', fontWeight: 800, color: 'var(--text-1)', margin: '.25rem 0 .5rem' }}>🧾 All check-ins</div>
          <div style={{ background: 'var(--card-bg,#fff)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' }}>
            {loading ? <div className="loading-state"><div className="spinner"></div><span>Loading…</span></div>
              : error ? <div style={{ padding: '1rem', color: '#991b1b', fontSize: '.85rem' }}>Error: {error}</div>
              : list.length === 0 ? <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '.88rem' }}>No check-ins found for this day.</div>
              : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.83rem' }}>
                    <thead style={{ background: 'var(--bg-2,#f4f4f5)' }}>
                      <tr>
                        <th style={th}>Employee</th>
                        <th style={th}>Site</th>
                        <th style={th}>Status</th>
                        <th style={{ ...th, textAlign: 'right' }}>Distance</th>
                        <th style={{ ...th, textAlign: 'center' }}>Photo</th>
                        <th style={th}>Time</th>
                        <th style={th}>Location</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((r, i) => {
                        const conf = attConflict(r);
                        const geoKey = r.latitude != null && r.longitude != null ? (+r.latitude).toFixed(4) + ',' + (+r.longitude).toFixed(4) : null;
                        const place = r.location_name || (geoKey && geoNames[geoKey]) || null;
                        const isLocReq = r.source === 'notification';
                        const isVerify = r.site_code === 'VERIFY';
                        return (
                          <tr key={i} style={{ borderTop: '1px solid var(--border)', borderLeft: isLocReq ? '3px solid #4338ca' : '3px solid transparent', background: isLocReq ? 'rgba(79,70,229,.05)' : undefined }}>
                            <td style={td}>
                              <div style={{ fontWeight: 600 }}>{r.name || '—'}</div>
                              <div style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>{r.emp_no || ''}{r.department ? ' · ' + r.department : ''}</div>
                              {r.phone && (
                                <a href={`tel:${r.phone}`} style={{ fontSize: '.72rem', color: 'var(--primary,#4338ca)', fontWeight: 600, textDecoration: 'none' }}>📞 {r.phone}</a>
                              )}
                            </td>
                            <td style={td}>
                              <div style={{ fontWeight: 600 }}>{r.site_name || '—'}</div>
                              <div style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>{r.site_code || ''}</div>
                              {r.site_mismatch && r.nearest_site_name && !isVerify && (
                                <div style={{ fontSize: '.7rem', color: '#b45309', marginTop: '.15rem' }}>→ near: {r.nearest_site_name}{r.nearest_distance_m != null ? ` (${r.nearest_distance_m}m)` : ''}</div>
                              )}
                            </td>
                            <td style={td}>
                              {/* VERIFY is not a site — it is the placeholder the Location Request
                                  screen submits when it could not resolve one. Judging it against a
                                  fence is meaningless, and "near: <some site 16 km away>" reads like
                                  a problem when nothing is wrong. */}
                              {isVerify ? badge('📍 Location only', '#eef2ff', '#4338ca')
                                : r.inside_fence === true ? badge('✅ Inside', '#dcfce7', '#166534')
                                : r.inside_fence === false ? badge('⚠️ Outside', '#fef3c7', '#92400e')
                                : badge('No fence', '#f3f4f6', '#6b7280')}
                              {isLocReq && <div style={{ marginTop: '.25rem' }}>{badge('🔔 Location Request', '#eef2ff', '#4338ca')}</div>}
                              {r.site_mismatch && !isVerify && <div style={{ marginTop: '.25rem' }}>{badge('📍 Mismatch', '#fef3c7', '#b45309')}</div>}
                              {conf && <div style={{ marginTop: '.25rem' }}>{badge(`🔴 Att: ${conf}`, '#fee2e2', '#991b1b')}</div>}
                              {r.blocked && <div style={{ marginTop: '.25rem' }}>{badge('⛔ Blocked (VPN)', '#7f1d1d', '#fff')}</div>}
                              {rowFlags(r).map((f) => FLAG_META[f]
                                ? <div key={f} style={{ marginTop: '.25rem' }}>{badge(FLAG_META[f].label, FLAG_META[f].bg, FLAG_META[f].col)}</div>
                                : null)}
                              {r.ip_proxy && r.ip_type && <div style={{ fontSize: '.66rem', color: '#991b1b', marginTop: '.2rem', fontWeight: 700 }}>IP: {r.ip_type}{r.ip_city ? ` · ${r.ip_city}` : ''}{r.ip_country ? `, ${r.ip_country}` : ''}</div>}
                            </td>
                            <td style={{ ...td, textAlign: 'right' }}>{r.distance_m != null ? `${r.distance_m} m` : r.nearest_distance_m != null ? `${r.nearest_distance_m} m` : '—'}</td>
                            <td style={{ ...td, textAlign: 'center' }}>
                              {r.photo_url
                                ? <button onClick={() => window.viewReceipt(r.photo_url)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: '.72rem', fontWeight: 700, color: 'var(--primary)' }}>📷 View</button>
                                : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                            </td>
                            <td style={{ ...td, whiteSpace: 'nowrap' }}>{timeIN(r.checked_at)}</td>
                            <td style={{ ...td, minWidth: 170 }}>
                              {r.latitude != null && r.longitude != null ? (
                                <>
                                  {place && <div style={{ fontWeight: 600 }}>📍 {place}</div>}
                                  <a href={`https://www.google.com/maps?q=${r.latitude},${r.longitude}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', fontWeight: 600, fontSize: '.78rem' }}>Map ↗</a>{' '}
                                  <span style={{ color: 'var(--text-muted)', fontSize: '.72rem' }}>{(+r.latitude).toFixed(5)}, {(+r.longitude).toFixed(5)}{r.accuracy_m != null ? ` · ±${r.accuracy_m}m` : ''}</span>
                                </>
                              ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </div>
        </main>
      </div>
    </div>
  );
}
