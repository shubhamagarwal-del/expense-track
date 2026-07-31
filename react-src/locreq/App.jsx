// React Location Request — market-inspired design matching the check-in page
// (dark header, big round SEND button, one-tap flow: tap → camera → auto-send).
// LIVE via Supabase Realtime on the employee's own push_checks (migration 22).
import React, { useEffect, useRef, useState } from 'react';

/* global SITE_DATA, db */
const getSites = () => (typeof SITE_DATA !== 'undefined' ? SITE_DATA : []);
const getDb = () => (typeof db !== 'undefined' ? db : window.db);

const hav = (a, b, c, d) => {
  const R = 6371000, r = (x) => x * Math.PI / 180;
  const dLat = r(c - a), dLon = r(d - b);
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
};

const buzz = (ms = 120) => { try { navigator.vibrate?.(ms); } catch { } };

// getUserMedia failures are opaque by default ("camera didn't open") — surface the
// actual reason so the employee (and we) know whether it's permission, another app
// holding the camera, no camera at all, or an insecure origin.
function cameraErrorMessage(err) {
  const msgs = {
    NotAllowedError: 'Camera permission denied — allow it in your browser/site settings, then reload.',
    PermissionDeniedError: 'Camera permission denied — allow it in your browser/site settings, then reload.',
    NotFoundError: 'No camera found on this device.',
    DevicesNotFoundError: 'No camera found on this device.',
    NotReadableError: 'Camera is in use by another app (or tab) — close it and try again.',
    TrackStartError: 'Camera is in use by another app (or tab) — close it and try again.',
    SecurityError: 'Camera needs a secure (https) connection.',
  };
  return msgs[err?.name] || `Camera didn't open${err?.name ? ` (${err.name})` : ''} — try again.`;
}

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
  const [photoPreview, setPhotoPreview] = useState(null); // { file, url } | null — awaiting Retake/confirm
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [now, setNow] = useState(new Date());
  const [gpsPos, setGpsPos] = useState(null);        // { lat, lon, acc } live
  const [gpsErr, setGpsErr] = useState(false);
  const [siteGeo, setSiteGeo] = useState(null);      // { latitude, longitude, radius_m } | null — usual site's fence
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const userLayerRef = useRef(null);
  const siteLayerRef = useRef(null);

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

  // Fallback readiness check: onLoadedMetadata doesn't fire reliably on every
  // browser/device, so also poll the video element directly. Whichever signal
  // arrives first clears the "Starting camera…" state.
  useEffect(() => {
    if (!camOn) return;
    const iv = setInterval(() => {
      const v = videoRef.current;
      if (v && v.videoWidth > 0) { setCamReady(true); clearInterval(iv); }
    }, 200);
    return () => clearInterval(iv);
  }, [camOn]);

  // Stuck-buffering guard: if no frame ever arrives, say so instead of an
  // infinite spinner — likely another app/tab holding the camera, or a
  // hardware/driver issue.
  useEffect(() => {
    if (!camOn) return;
    const to = setTimeout(() => {
      if (!videoRef.current?.videoWidth) window.showMessage("Camera is taking too long to start — close it (✕) and try again, or check if another app is using it.", 'error');
    }, 8000);
    return () => clearTimeout(to);
  }, [camOn]);

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

  // live GPS (watch — powers the header chip, map dot, and live distance)
  useEffect(() => {
    if (!profile || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => { setGpsPos({ lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy) }); setGpsErr(false); },
      () => setGpsErr(true),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [profile]);

  // Resolve the employee's usual site (if any) and fetch its geo-fence — informational
  // only here, there's no picker: the site to verify against is whatever the profile says.
  useEffect(() => {
    (async () => {
      if (!profile) { setSiteGeo(null); return; }
      const site = resolveUsualSite();
      if (!site) { setSiteGeo(null); return; }
      try {
        const { data } = await getDb().from('site_locations').select('latitude, longitude, radius_m').eq('site_code', site.code).maybeSingle();
        setSiteGeo(data && data.latitude != null ? data : null);
      } catch { setSiteGeo(null); }
    })();
  }, [profile]);

  // ── Leaflet map ──
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current || typeof window.L === 'undefined') return;
    const m = window.L.map(mapDivRef.current, { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false });
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
    m.setView([26.9124, 75.7873], 12);
    mapRef.current = m;
  });
  useEffect(() => {
    const m = mapRef.current;
    if (!m || typeof window.L === 'undefined') return;
    if (userLayerRef.current) { m.removeLayer(userLayerRef.current); userLayerRef.current = null; }
    if (siteLayerRef.current) { m.removeLayer(siteLayerRef.current); siteLayerRef.current = null; }
    const pts = [];
    if (siteGeo) {
      siteLayerRef.current = window.L.circle([siteGeo.latitude, siteGeo.longitude], { radius: siteGeo.radius_m || 200, color: '#22c55e', weight: 2, fillColor: '#22c55e', fillOpacity: 0.15 }).addTo(m);
      pts.push([siteGeo.latitude, siteGeo.longitude]);
    }
    if (gpsPos) {
      userLayerRef.current = window.L.circleMarker([gpsPos.lat, gpsPos.lon], { radius: 7, color: '#fff', weight: 2.5, fillColor: '#2563eb', fillOpacity: 1 }).addTo(m);
      pts.push([gpsPos.lat, gpsPos.lon]);
    }
    if (pts.length === 2) m.fitBounds(pts, { padding: [34, 34], maxZoom: 16 });
    else if (pts.length === 1) m.setView(pts[0], 15);
    setTimeout(() => m.invalidateSize(), 120);
  }, [gpsPos, siteGeo, camOn]);

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
    if (!window.isSecureContext) return window.showMessage('Camera needs a secure (https) connection — open this page via the https link.', 'error');
    if (!navigator.mediaDevices?.getUserMedia) return window.showMessage("Live camera isn't supported on this device/browser.", 'error');
    try {
      let stream;
      try {
        // Front camera by default (selfie — proves the employee themselves is present).
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'user' } }, audio: false });
      } catch (e) {
        if (e?.name === 'OverconstrainedError') stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); // any camera
        else throw e;
      }
      streamRef.current = stream;
      setResult(null); setCamReady(false);
      // The <video> is always mounted (see render), so the ref is already attached —
      // assign the stream immediately, exactly like the vanilla page did, instead of
      // waiting for a React re-render to (re)create the element.
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => { }); // belt-and-braces for autoPlay quirks
      }
      setCamOn(true);
    } catch (err) { window.showMessage(cameraErrorMessage(err), 'error'); }
  }
  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamOn(false); setCamReady(false);
  }
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
      const file = new File([blob], `verify_${Date.now()}.jpg`, { type: 'image/jpeg' });
      setPhotoPreview({ file, url: URL.createObjectURL(blob) }); // show preview → Retake / confirm
    }, 'image/jpeg', 0.9);
  }
  function retakePhoto() {
    if (photoPreview) URL.revokeObjectURL(photoPreview.url);
    setPhotoPreview(null);
    openCamera();
  }
  function confirmPhoto() {
    if (!photoPreview) return;
    submitLocation(photoPreview.file);
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
        if (photoPreview) URL.revokeObjectURL(photoPreview.url);
        setPhotoPreview(null); // success → clear preview, show the result card below
      } catch (err) { setResult({ ok: false, text: err.message }); } // keep the preview so Retake/confirm stay available to retry
      finally { setBusy(''); }
    }, (err) => {
      setBusy('');
      setResult({ ok: false, text: err.code === 1 ? 'GPS permission needed (allow location in the browser).' : "Couldn't get GPS location — try in the open." });
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  const r = reqs[0];
  const mins = r ? Math.max(0, Math.round((now - new Date(r.sent_at)) / 60000)) : 0;
  const left = r ? Math.max(0, (r.window_min || 30) - mins) : 0;
  const ready = !!r && !busy && !camOn && !photoPreview;
  const hm = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  const usualSite = resolveUsualSite();
  const liveDist = gpsPos && siteGeo ? Math.round(hav(gpsPos.lat, gpsPos.lon, siteGeo.latitude, siteGeo.longitude)) : null;
  const liveInside = liveDist != null ? liveDist <= (siteGeo.radius_m || 200) : null;

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
            <div className="topbar-right">
              {gpsPos && <span style={{ fontSize: '.68rem', fontWeight: 800, color: gpsPos.acc <= 100 ? '#4ade80' : '#fbbf24', background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)', borderRadius: 999, padding: '3px 9px' }}>📡 ±{gpsPos.acc}m</span>}
              {gpsErr && !gpsPos && <span style={{ fontSize: '.68rem', fontWeight: 800, color: '#f87171', background: 'rgba(255,255,255,.08)', borderRadius: 999, padding: '3px 9px' }}>📡 GPS off</span>}
            </div>
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
            <div style={{ fontSize: '.7rem', color: '#64748b', marginTop: 8, fontVariantNumeric: 'tabular-nums' }}>{hm}</div>
          </div>
        </div>

        <main className="page-content" style={{ maxWidth: 520, margin: '0 auto', paddingTop: '.9rem' }}>
          {loading ? (
            <div className="loading-state"><div className="spinner"></div><span>Loading…</span></div>
          ) : (
            <>
              {/* Map + site card — informational only; the site is whatever the employee's
                  profile says (no picker here, that's the check-in page's job). */}
              <div style={{ background: '#fff', borderRadius: 16, overflow: 'hidden', marginBottom: '.9rem', boxShadow: '0 4px 16px rgba(15,23,42,.08)' }}>
                <div ref={mapDivRef} style={{ height: 150, background: '#dbeafe' }} />
                <div style={{ padding: '.65rem .85rem' }}>
                  {usualSite ? (
                    <>
                      <div style={{ fontWeight: 800, fontSize: '.88rem', color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {usualSite.name} <span style={{ color: '#64748b', fontWeight: 600, fontSize: '.72rem' }}>{usualSite.code}</span>
                      </div>
                      <div style={{ fontSize: '.74rem', fontWeight: 700, marginTop: 1, color: liveInside === true ? '#16a34a' : liveInside === false ? '#b45309' : '#64748b' }}>
                        {!siteGeo ? 'Fence not set — GPS will still be recorded'
                          : liveDist == null ? 'Waiting for GPS…'
                          : liveInside ? `You are ${liveDist} m from site — inside fence`
                          : `You are ${liveDist} m from site — outside fence`}
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: '.85rem', color: '#64748b', fontWeight: 600 }}>No usual site on file — your live location will be recorded for HR</div>
                  )}
                </div>
              </div>

              {/* Camera (one-tap flow). The <video> stays mounted at all times (like the
                  working vanilla page did) — only hidden via display:none — so when
                  openCamera() runs, the element already exists and srcObject can be
                  assigned immediately with no mount-timing race. */}
              <div style={{ position: 'relative', marginBottom: camOn ? '.9rem' : 0, display: camOn ? 'block' : 'none' }}>
                <video ref={videoRef} playsInline autoPlay muted onLoadedMetadata={() => setCamReady(true)}
                  style={{ width: '100%', height: 320, objectFit: 'cover', borderRadius: 16, background: '#000', display: 'block', transform: 'scaleX(-1)' }} />
                {camOn && !camReady && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div className="loading-state" style={{ background: 'rgba(15,23,42,.55)', borderRadius: 12, color: '#fff' }}><div className="spinner"></div><span>Starting camera…</span></div>
                  </div>
                )}
                {camOn && (
                  <>
                    <button onClick={capturePhoto} aria-label="Take photo" disabled={!camReady}
                      style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', width: 64, height: 64, borderRadius: '50%', background: '#fff', border: '4px solid rgba(255,255,255,.45)', boxShadow: '0 2px 10px rgba(0,0,0,.35)', cursor: camReady ? 'pointer' : 'wait', opacity: camReady ? 1 : .5 }} />
                    <button onClick={stopCamera} aria-label="Close camera"
                      style={{ position: 'absolute', top: 10, right: 10, width: 34, height: 34, borderRadius: '50%', background: 'rgba(15,23,42,.7)', color: '#fff', border: 'none', fontWeight: 800, cursor: 'pointer' }}>✕</button>
                    <div style={{ position: 'absolute', top: 12, left: 12, background: 'rgba(15,23,42,.7)', color: '#fff', borderRadius: 8, padding: '3px 10px', fontSize: '.7rem', fontWeight: 700 }}>Photo captures → auto send</div>
                  </>
                )}
              </div>

              {/* Photo preview — review before sending (Retake or confirm) */}
              {r && !camOn && photoPreview && (
                <div style={{ marginBottom: '.9rem' }}>
                  <div style={{ position: 'relative', borderRadius: 16, overflow: 'hidden' }}>
                    <img src={photoPreview.url} alt="Captured" style={{ width: '100%', height: 320, objectFit: 'cover', display: 'block' }} />
                    <span style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(15,23,42,.7)', color: '#fff', borderRadius: 8, padding: '3px 10px', fontSize: '.7rem', fontWeight: 700 }}>Review your photo</span>
                  </div>
                  <div style={{ display: 'flex', gap: '.6rem', marginTop: '.7rem' }}>
                    <button onClick={retakePhoto} disabled={!!busy}
                      style={{ flex: 1, height: 50, background: '#fff', border: '1.5px solid #e2e8f0', borderRadius: 999, fontWeight: 800, fontSize: '.9rem', color: '#334155', cursor: busy ? 'wait' : 'pointer' }}>🔄 Retake</button>
                    <button onClick={confirmPhoto} disabled={!!busy}
                      style={{ flex: 2, height: 50, background: busy ? 'linear-gradient(135deg,#0ea5e9,#0369a1)' : 'linear-gradient(135deg,#3b82f6,#1d4ed8)', color: '#fff', border: 'none', borderRadius: 999, fontWeight: 800, fontSize: '.9rem', cursor: busy ? 'wait' : 'pointer', boxShadow: '0 8px 20px rgba(29,78,216,.3)' }}>
                      {busy || '📍 Send this photo'}
                    </button>
                  </div>
                </div>
              )}

              {/* Round send button (only when a request is pending) */}
              {r && !camOn && !photoPreview && (
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
                  <div style={{ textAlign: 'center', fontSize: '.72rem', color: '#94a3b8', marginBottom: '.9rem' }}>Tap → camera → photo → review → send</div>
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
