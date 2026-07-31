// React Location Request — market-inspired design matching the check-in page
// (dark header, big round SEND button, one-tap flow: tap → camera → auto-send).
// LIVE via Supabase Realtime on the employee's own push_checks (migration 22).
import React, { useEffect, useRef, useState } from 'react';

/* global SITE_DATA, db */
const getSites = () => (typeof SITE_DATA !== 'undefined' ? SITE_DATA : []);
const getDb = () => (typeof db !== 'undefined' ? db : window.db);

const buzz = (ms = 120) => { try { navigator.vibrate?.(ms); } catch { } };

const Sidebar = () => (
  <>
    <div className="sidebar-overlay" id="sidebar-overlay" onClick={() => window.closeSidebar()}></div>
    <nav className="sidebar" id="sidebar">
      <div className="sidebar-logo">
        <div className="logo-icon"><img src="/icon-192.png" alt="ExpenseTrack" /></div>
        <span className="logo-text">ExpenseTrack</span>
      </div>
      <div className="sidebar-nav">
        <p className="sidebar-nav-label">Menu</p>
        <a href="dashboard.html" className="sidebar-link">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
          Dashboard
        </a>
        <a href="add-expense.html" className="sidebar-link" id="sb-add-link" style={{ display: 'none' }}>
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
          Add Expense
        </a>
        <a href="checkin-react.html" className="sidebar-link" id="sb-checkin-link" style={{ display: 'none' }}>
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
          Site Check-in
        </a>
        <a href="location-request-react.html" className="sidebar-link active" id="sb-location-request-link">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
          Location Request
          <span id="lr-badge" style={{ display: 'none', marginLeft: 'auto', background: '#dc2626', color: '#fff', borderRadius: 999, minWidth: 18, height: 18, fontSize: '.68rem', fontWeight: 800, alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}></span>
        </a>
        <a href="profile.html" className="sidebar-link">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
          My Profile
        </a>
        <a href="#" onClick={(e) => { e.preventDefault(); window.logout(); }} className="sidebar-link">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
          Sign Out
        </a>
      </div>
    </nav>
  </>
);

export default function App() {
  const [profile, setProfile] = useState(null);
  const [reqs, setReqs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [camReady, setCamReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [now, setNow] = useState(new Date());
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => {
    (async () => {
      const user = await window.requireAuth();
      if (!user) return;
      const prof = await window.getUserProfile();
      if (!prof) { window.showMessage('Could not load profile.', 'error'); return; }
      setProfile(prof);
      loadRequests();
      try { const reg = await navigator.serviceWorker?.ready; (await reg?.getNotifications())?.forEach((n) => n.close()); } catch { }
    })();
  }, []);

  useEffect(() => { if (profile && window.populateSidebar) window.populateSidebar(profile); }, [profile]);
  useEffect(() => { const iv = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(iv); }, []);

  // LIVE: a new HR request (or status change) appears instantly via Realtime.
  useEffect(() => {
    if (!profile) return;
    const ch = getDb().channel('locreq-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'push_checks', filter: `user_id=eq.${profile.id}` }, () => loadRequests(true))
      .subscribe();
    const refresh = () => { if (document.visibilityState === 'visible') loadRequests(true); };
    const iv = setInterval(refresh, 60000);
    document.addEventListener('visibilitychange', refresh);
    return () => { getDb().removeChannel(ch); clearInterval(iv); document.removeEventListener('visibilitychange', refresh); };
  }, [profile]);

  async function loadRequests(silent = false) {
    if (!silent) setLoading(true);
    try {
      const token = (await getDb().auth.getSession()).data.session?.access_token;
      const res = await fetch('/api/receipt-url?my_requests=1', { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json();
      setReqs(res.ok ? (body.requests || []) : []);
    } catch { }
    finally { if (!silent) setLoading(false); }
  }

  // ── one-tap flow: round button → camera → capture → auto send ──
  async function startSend() {
    openCamera();
  }
  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) return window.showMessage("Live camera isn't supported on this device/browser.", 'error');
    try {
      // Front camera by default (selfie — proves the employee themselves is present).
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'user' } }, audio: false });
      streamRef.current = stream;
      setCamOn(true); setCamReady(false); setResult(null);
      setTimeout(() => { if (videoRef.current) videoRef.current.srcObject = stream; }, 0);
    } catch { window.showMessage("Camera didn't open — allow camera permission.", 'error'); }
  }
  function stopCamera() { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; setCamOn(false); setCamReady(false); }
  async function capturePhoto() {
    const v = videoRef.current;
    // The stream can take a beat to deliver its first frame — wait for it
    // instead of failing immediately (fixes "camera isn't ready" on tap).
    let tries = 0;
    while (v && !v.videoWidth && tries < 30) { await new Promise((res) => setTimeout(res, 100)); tries++; }
    if (!v || !v.videoWidth) return window.showMessage("Camera isn't ready yet — wait a second and try again.", 'error');
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    c.toBlob((blob) => {
      if (!blob) return window.showMessage('Photo capture failed — try again.', 'error');
      buzz(60);
      stopCamera();
      submitLocation(new File([blob], `verify_${Date.now()}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.9);
  }

  function resolveUsualSite() {
    const mine = (profile?.site_name || '').trim().toLowerCase();
    return mine ? getSites().find((s) => s.name.toLowerCase() === mine) : null;
  }

  async function submitLocation(file) {
    if (!navigator.geolocation) return window.showMessage("GPS isn't supported on this device.", 'error');
    setBusy('Getting GPS…'); setResult(null);
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      try {
        const token = (await getDb().auth.getSession()).data.session?.access_token;
        setBusy('Uploading photo…');
        const photo_url = await window.uploadReceipt(file, profile.id);
        if (!photo_url) throw new Error('Photo upload failed — check your network and try again.');
        setBusy('Sending…');
        const site = resolveUsualSite() || { code: 'VERIFY', name: 'Location Verify' };
        const res = await fetch('/api/receipt-url', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ checkin: { site_code: site.code, site_name: site.name, latitude, longitude, accuracy, photo_url, source: 'notification' } }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Failed');
        setResult({ ok: true, text: `${body.location_name || 'Your current location'} recorded. Thank you.` });
        buzz([80, 60, 80]);
        setTimeout(() => loadRequests(true), 1200);
      } catch (err) { setResult({ ok: false, text: err.message }); }
      finally { setBusy(''); }
    }, (err) => {
      setBusy('');
      setResult({ ok: false, text: err.code === 1 ? 'GPS permission needed (allow location in the browser).' : "Couldn't get GPS location — try in the open." });
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  const r = reqs[0];
  const mins = r ? Math.max(0, Math.round((now - new Date(r.sent_at)) / 60000)) : 0;
  const left = r ? Math.max(0, (r.window_min || 30) - mins) : 0;
  const ready = !!r && !busy && !camOn;

  return (
    <div className="app-layout">
      <Sidebar />
      <div className="app-main" style={{ background: '#f1f5f9' }}>
        {/* Dark header */}
        <div style={{ background: '#0f172a', padding: '0 0 1.15rem' }}>
          <header className="topbar" style={{ background: 'transparent', borderBottom: 'none' }}>
            <button className="topbar-menu" onClick={() => window.toggleSidebar()} aria-label="Open menu" style={{ color: '#94a3b8' }}>
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <span className="topbar-title" style={{ color: '#e2e8f0' }}>Location request</span>
            <div className="topbar-right"></div>
          </header>
          <div style={{ textAlign: 'center' }}>
            {r ? (
              <>
                <div style={{ color: '#fbbf24', fontSize: '1.6rem', fontWeight: 800, lineHeight: 1 }}>🔔 HR needs your location</div>
                <div style={{ fontSize: '.78rem', color: '#94a3b8', marginTop: 6 }}>
                  Requested {mins} min ago · {left > 0 ? <span style={{ color: '#fbbf24', fontWeight: 800 }}>{left} min left</span> : <span style={{ color: '#f87171', fontWeight: 800 }}>window passed — respond now (marked late)</span>}
                </div>
              </>
            ) : (
              <>
                <div style={{ color: '#4ade80', fontSize: '1.6rem', fontWeight: 800, lineHeight: 1 }}>✅ All clear</div>
                <div style={{ fontSize: '.78rem', color: '#94a3b8', marginTop: 6 }}>No pending requests — new ones appear here live.</div>
              </>
            )}
          </div>
        </div>

        <main className="page-content" style={{ maxWidth: 520, margin: '0 auto', paddingTop: '.9rem' }}>
          {loading ? (
            <div className="loading-state"><div className="spinner"></div><span>Loading…</span></div>
          ) : (
            <>
              {/* Camera (one-tap flow) */}
              {camOn && (
                <div style={{ position: 'relative', marginBottom: '.9rem' }}>
                  <video ref={videoRef} playsInline autoPlay muted onLoadedMetadata={() => setCamReady(true)}
                    style={{ width: '100%', height: 320, objectFit: 'cover', borderRadius: 16, background: '#000', display: 'block', transform: 'scaleX(-1)' }} />
                  {!camReady && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div className="loading-state" style={{ background: 'rgba(15,23,42,.55)', borderRadius: 12, color: '#fff' }}><div className="spinner"></div><span>Starting camera…</span></div>
                    </div>
                  )}
                  <button onClick={capturePhoto} aria-label="Take photo" disabled={!camReady}
                    style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', width: 64, height: 64, borderRadius: '50%', background: '#fff', border: '4px solid rgba(255,255,255,.45)', boxShadow: '0 2px 10px rgba(0,0,0,.35)', cursor: camReady ? 'pointer' : 'wait', opacity: camReady ? 1 : .5 }} />
                  <button onClick={stopCamera} aria-label="Close camera"
                    style={{ position: 'absolute', top: 10, right: 10, width: 34, height: 34, borderRadius: '50%', background: 'rgba(15,23,42,.7)', color: '#fff', border: 'none', fontWeight: 800, cursor: 'pointer' }}>✕</button>
                  <div style={{ position: 'absolute', top: 12, left: 12, background: 'rgba(15,23,42,.7)', color: '#fff', borderRadius: 8, padding: '3px 10px', fontSize: '.7rem', fontWeight: 700 }}>Photo captures → auto send</div>
                </div>
              )}

              {/* Round send button (only when a request is pending) */}
              {r && !camOn && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '.6rem 0 .5rem' }}>
                    <div style={{ position: 'relative', width: 150, height: 150 }}>
                      {ready && <div className="punch-ring" style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(37,99,235,.25)' }} />}
                      {ready && <div className="punch-ring r2" style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(37,99,235,.18)' }} />}
                      <button onClick={startSend} disabled={!!busy}
                        style={{ position: 'absolute', inset: 12, borderRadius: '50%', border: 'none', cursor: busy ? 'wait' : 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, color: '#fff', background: busy ? 'linear-gradient(135deg,#0ea5e9,#0369a1)' : 'linear-gradient(135deg,#3b82f6,#1d4ed8)', boxShadow: '0 12px 28px rgba(29,78,216,.4)' }}>
                        <span style={{ fontSize: '1.5rem', lineHeight: 1 }}>{busy ? '⏳' : '📍'}</span>
                        <span style={{ fontWeight: 800, fontSize: busy ? '.72rem' : '.9rem', letterSpacing: '.04em', padding: '0 .5rem', textAlign: 'center' }}>{busy || 'SEND LOCATION'}</span>
                        {!busy && <span style={{ fontSize: '.62rem', color: 'rgba(255,255,255,.75)', fontWeight: 600 }}>photo + GPS</span>}
                      </button>
                    </div>
                  </div>
                  <div style={{ textAlign: 'center', fontSize: '.72rem', color: '#94a3b8', marginBottom: '.9rem' }}>Tap → camera → photo → auto send</div>
                </>
              )}

              {/* Empty state card */}
              {!r && !camOn && !result && (
                <div style={{ background: '#fff', borderRadius: 16, padding: '1.6rem 1.25rem', textAlign: 'center', color: '#64748b', boxShadow: '0 4px 14px rgba(15,23,42,.06)' }}>
                  <div style={{ width: 54, height: 54, borderRadius: '50%', background: '#f0fdf4', border: '1.5px solid #bbf7d0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem', margin: '0 auto .6rem' }}>✅</div>
                  <div style={{ fontWeight: 800, color: '#0f172a' }}>No pending requests</div>
                  <div style={{ fontSize: '.82rem', marginTop: '.25rem' }}>This page updates live when HR sends one.</div>
                </div>
              )}

              {/* Result */}
              {result && (
                <div style={{ marginBottom: '.9rem' }}>
                  {result.ok ? (
                    <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 14, padding: '1rem', color: '#166534', boxShadow: '0 8px 24px rgba(15,23,42,.06)' }}>
                      <div style={{ fontSize: '1rem', fontWeight: 800 }}>✅ Location sent to HR</div>
                      <div style={{ fontSize: '.83rem', marginTop: '.2rem' }}>{result.text}</div>
                    </div>
                  ) : (
                    <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 14, padding: '.9rem 1rem', color: '#991b1b', fontSize: '.85rem', fontWeight: 600 }}>{result.text}</div>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
