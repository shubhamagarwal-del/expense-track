// React Site Check-in — market-inspired design (live clock, mini map with
// geo-fence, big round punch button, one-tap flow). Same functionality:
// notifications required, strict site pick, live photo only, GPS + fence,
// 3 slots, today list. Connects via app.js globals (same session/API/data).
import React, { useEffect, useRef, useState } from 'react';

/* global SITE_DATA, db, L */
const getSites = () => (typeof SITE_DATA !== 'undefined' ? SITE_DATA : []);
const getDb = () => (typeof db !== 'undefined' ? db : window.db);

const VAPID_PUBLIC = 'BDpDnIhZAEesC14fexaPrqWFPwS7YIJMl01Hi1P1z_j2A-52y3Y_qQCskrPJaJwiWTz6vLN1CY7ARB_cjw60jbI';

const SLOTS = [
  { key: 'morning', label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'evening', label: 'Evening' },
];
const slotOf = (iso) => {
  const h = new Date(new Date(iso).getTime() + 5.5 * 3600 * 1000).getUTCHours();
  return h < 12 ? 'morning' : h < 16 ? 'afternoon' : 'evening';
};
const currentSlot = () => slotOf(new Date().toISOString());
const timeIN = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

const hav = (a, b, c, d) => {
  const R = 6371000, r = (x) => x * Math.PI / 180;
  const dLat = r(c - a), dLon = r(d - b);
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
};

const urlB64ToUint8 = (base64) => {
  const pad = '='.repeat((4 - base64.length % 4) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function notificationsOn() {
  // Some Android browsers (notably Samsung Internet) return getSubscription() as null
  // even right after a successful subscribe — which left this banner stuck on "Turn ON"
  // and blocked check-in entirely. So: if the browser reports a live subscription, trust
  // it; otherwise fall back to a flag we persist only after a confirmed server-side save.
  try { const reg = await navigator.serviceWorker?.ready; if (reg && (await reg.pushManager.getSubscription())) return true; } catch { }
  try { return localStorage.getItem('checkin_notif_on') === '1'; } catch { return false; }
}

const buzz = (ms = 120) => { try { navigator.vibrate?.(ms); } catch { } };

const uuid = () => (crypto?.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));

// ── Offline check-in queue (IndexedDB) ─────────────────────────────────────
// When there's no network at a site, GPS + photo are still captured on the phone
// (GPS is satellite-based, camera is local) — only the upload/record needs the
// network. So we stash {photo Blob, GPS, site, captured_at, client_id} here and
// auto-sync when connectivity returns. The photo is kept as a raw Blob (uploaded
// during sync, not before). Same store is reused by the location-request page.
const OQ_DB = 'checkin_offline_v1';
function oqOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(OQ_DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('pending')) r.result.createObjectStore('pending', { keyPath: 'client_id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function oqAdd(item) { const db = await oqOpen(); return new Promise((res, rej) => { const tx = db.transaction('pending', 'readwrite'); tx.objectStore('pending').put(item); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }
async function oqAll() { try { const db = await oqOpen(); return await new Promise((res) => { const rq = db.transaction('pending', 'readonly').objectStore('pending').getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]); }); } catch { return []; } }
async function oqDel(client_id) { try { const db = await oqOpen(); await new Promise((res) => { const tx = db.transaction('pending', 'readwrite'); tx.objectStore('pending').delete(client_id); tx.oncomplete = () => res(); tx.onerror = () => res(); }); } catch { } }

// Sync one queued item → upload its photo, then record it. Returns 'done' (synced or
// permanently-rejected → removed), or 'retry' (network still down → keep for later).
async function oqSyncOne(getDb, it, userId) {
  const token = (await getDb().auth.getSession()).data.session?.access_token;
  if (!token) return 'retry';
  const file = it.photo instanceof Blob ? new File([it.photo], `checkin_${it.client_id}.jpg`, { type: 'image/jpeg' }) : it.photo;
  const photo_url = await window.uploadReceipt(file, userId);   // throws on network failure
  if (!photo_url) throw new Error('photo upload failed');
  const res = await fetch('/api/receipt-url', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ checkin: { site_code: it.site_code, site_name: it.site_name, latitude: it.latitude, longitude: it.longitude, accuracy: it.accuracy, photo_url, source: it.source, client_id: it.client_id, captured_at: it.captured_at } }),
  });
  if (res.ok) { await oqDel(it.client_id); return 'done'; }
  // 4xx (except 429) = not retryable (bad data / blocked) → drop so it doesn't loop forever.
  if (res.status >= 400 && res.status < 500 && res.status !== 429) { await oqDel(it.client_id); return 'done'; }
  throw new Error('server ' + res.status);
}

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
        <a href="checkin-react.html" className="sidebar-link active">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
          Site Check-in
        </a>
        <a href="location-request-react.html" className="sidebar-link" id="sb-location-request-link" style={{ display: 'none' }}>
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
  const [sites, setSites] = useState([]);
  const [siteVal, setSiteVal] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetQ, setSheetQ] = useState('');
  const [siteGeo, setSiteGeo] = useState(null);      // { latitude, longitude, radius_m } | null
  const [allSiteGeo, setAllSiteGeo] = useState([]);  // every site's geo-fence — used to find the nearest one
  const [userPicked, setUserPicked] = useState(false); // true once the employee explicitly chose a site — stop auto-selecting after that
  const [autoPicked, setAutoPicked] = useState(false); // true when the current selection came from GPS proximity, not a manual pick
  const [camOn, setCamOn] = useState(false);
  const [camReady, setCamReady] = useState(false);
  const [photoPreview, setPhotoPreview] = useState(null); // { file, url } | null — awaiting Retake/confirm
  const [vh, setVh] = useState(() => (typeof window !== 'undefined' ? (window.visualViewport?.height || window.innerHeight) : 800));
  const [today, setToday] = useState([]);
  const [notifState, setNotifState] = useState('off');
  const [notifBusy, setNotifBusy] = useState(false);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [pendingCount, setPendingCount] = useState(0);   // offline check-ins waiting to sync
  const [gpsPos, setGpsPos] = useState(null);        // { lat, lon, acc } live
  const [gpsErr, setGpsErr] = useState(false);
  const [now, setNow] = useState(new Date());
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const sheetInputRef = useRef(null);
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const userLayerRef = useRef(null);
  const siteLayerRef = useRef(null);

  // ── boot ──
  useEffect(() => {
    (async () => {
      const user = await window.requireAuth();
      if (!user) return;
      const prof = await window.getUserProfile();
      if (!prof) { window.showMessage('Could not load profile.', 'error'); return; }
      setProfile(prof);
      const s = getSites();
      setSites(s);
      const mine = (prof.site_name || '').trim().toLowerCase();
      const hit = mine && s.find((x) => x.name.toLowerCase() === mine);
      if (hit) setSiteVal(`${hit.name} — ${hit.code}`);
      refreshNotif();
      loadToday(prof);
      try { const reg = await navigator.serviceWorker?.ready; (await reg?.getNotifications())?.forEach((n) => n.close()); } catch { }
    })();
  }, []);

  useEffect(() => { if (profile && window.populateSidebar) window.populateSidebar(profile); }, [profile]);

  const refreshPending = async () => { setPendingCount((await oqAll()).length); };

  // Drain the offline queue: upload + record each stashed check-in. Stops on the first
  // network failure (keeps the rest for next time). Safe to call repeatedly.
  const syncQueue = async () => {
    if (!profile || !navigator.onLine) return;
    const items = await oqAll();
    for (const it of items) {
      try { await oqSyncOne(getDb, it, profile.id); }
      catch { break; } // network still down — try again later
    }
    await refreshPending();
    loadToday();
  };

  // On load and whenever the network comes back, flush anything queued offline.
  useEffect(() => {
    if (!profile) return;
    refreshPending();
    syncQueue();
    const onOnline = () => syncQueue();
    window.addEventListener('online', onOnline);
    const iv = setInterval(() => { if (navigator.onLine) syncQueue(); }, 30000);
    return () => { window.removeEventListener('online', onOnline); clearInterval(iv); };
  }, [profile]);
  useEffect(() => { if (sheetOpen) setTimeout(() => sheetInputRef.current?.focus(), 80); }, [sheetOpen]);

  // Track the visual viewport height so the site-picker sheet shrinks when the
  // on-screen keyboard opens — otherwise the results list ends up hidden behind
  // the keyboard (vh units don't account for it).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => setVh(vv.height);
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    return () => { vv.removeEventListener('resize', onResize); vv.removeEventListener('scroll', onResize); };
  }, []);

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

  // live clock (per-second)
  useEffect(() => { const iv = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(iv); }, []);

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

  const selected = sites.find((s) => `${s.name} — ${s.code}`.toLowerCase() === siteVal.trim().toLowerCase()) || null;

  // fetch the selected site's geo-fence (site_locations is readable by signed-in users)
  useEffect(() => {
    (async () => {
      if (!selected || !profile) { setSiteGeo(null); return; }
      try {
        const { data } = await getDb().from('site_locations').select('latitude, longitude, radius_m').eq('site_code', selected.code).maybeSingle();
        setSiteGeo(data && data.latitude != null ? data : null);
      } catch { setSiteGeo(null); }
    })();
  }, [siteVal, profile]);

  // Fetch every site's geo-fence once — needed to find which site is nearest
  // (not just the currently-selected one).
  useEffect(() => {
    if (!profile) return;
    (async () => {
      try {
        const { data } = await getDb().from('site_locations').select('site_code, latitude, longitude, radius_m').eq('active', true);
        setAllSiteGeo((data || []).filter((s) => s.latitude != null && s.longitude != null));
      } catch { setAllSiteGeo([]); }
    })();
  }, [profile]);

  // Auto-select the nearest site from live GPS — but only until the employee
  // manually picks one themselves (userPicked). A profile-based guess may already
  // be selected from the boot effect; GPS proximity is more reliable and is
  // allowed to replace that, but never a real manual choice.
  useEffect(() => {
    if (userPicked || !gpsPos || !allSiteGeo.length || !sites.length) return;
    let best = null;
    for (const g of allSiteGeo) {
      const d = hav(gpsPos.lat, gpsPos.lon, g.latitude, g.longitude);
      if (!best || d < best.d) best = { d, code: g.site_code };
    }
    const NEAR_THRESHOLD_M = 450; // only auto-pick when genuinely close to a known site
    if (best && best.d <= NEAR_THRESHOLD_M) {
      const s = sites.find((x) => x.code === best.code);
      if (s) { setSiteVal(`${s.name} — ${s.code}`); setAutoPicked(true); }
    }
  }, [gpsPos, allSiteGeo, sites, userPicked]);

  // ── Leaflet map ──
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current || typeof window.L === 'undefined') return;
    const m = window.L.map(mapDivRef.current, { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false });
    // Satellite/aerial imagery (Esri World Imagery — free, no API key) + a transparent
    // place-name/road label layer on top = a hybrid view that reads as almost-3D from
    // above while staying light enough for low-end phones.
    window.L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery © Esri' }).addTo(m);
    window.L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, opacity: 0.9 }).addTo(m);
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
      siteLayerRef.current = window.L.circle([siteGeo.latitude, siteGeo.longitude], { radius: siteGeo.radius_m || 200, color: '#22c55e', weight: 3, fillColor: '#22c55e', fillOpacity: 0.22 }).addTo(m);
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

  async function refreshNotif() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return setNotifState('unsupported');
    if (Notification.permission === 'denied') return setNotifState('blocked');
    setNotifState((await notificationsOn()) ? 'on' : 'off');
  }

  async function loadToday(prof = profile) {
    try {
      const t0 = new Date(); t0.setHours(0, 0, 0, 0);
      const { data } = await getDb().from('attendance_checkins')
        .select('site_name, distance_m, inside_fence, checked_at, photo_url, source')
        .eq('user_id', prof.id).gte('checked_at', t0.toISOString())
        .order('checked_at', { ascending: false });
      setToday(data || []);
    } catch { }
  }

  async function enableNotifications() {
    try {
      setNotifBusy(true);
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { window.showMessage('Notification permission needed — click Allow.', 'error'); return; }
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) { try { await existing.unsubscribe(); } catch { } }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(VAPID_PUBLIC) });
      const token = (await getDb().auth.getSession()).data.session?.access_token;
      const res = await fetch('/api/receipt-url', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ subscribe_push: sub.toJSON() }) });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      try { localStorage.setItem('checkin_notif_on', '1'); } catch { }
      window.showMessage('Check-in verification is ON ✓', 'success');
      refreshNotif();
    } catch (err) { window.showMessage("Couldn't turn on notifications: " + err.message, 'error'); }
    finally { setNotifBusy(false); }
  }

  // ── one-tap flow: round button → camera → capture → auto submit ──
  async function startCheckin() {
    if (!(await notificationsOn())) { refreshNotif(); return window.showMessage('Turn on notifications first — required to check in.', 'error'); }
    if (!selected) { setSheetOpen(true); return; }
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
      const file = new File([blob], `checkin_${Date.now()}.jpg`, { type: 'image/jpeg' });
      setPhotoPreview({ file, url: URL.createObjectURL(blob) }); // show preview → Retake / Check in
    }, 'image/jpeg', 0.9);
  }
  function retakePhoto() {
    if (photoPreview) URL.revokeObjectURL(photoPreview.url);
    setPhotoPreview(null);
    openCamera();
  }
  function confirmPhoto() {
    if (!photoPreview) return;
    submitCheckin(photoPreview.file);
  }

  async function submitCheckin(file) {
    if (!navigator.geolocation) return window.showMessage("GPS isn't supported on this device.", 'error');
    setBusy(navigator.onLine ? 'Getting GPS…' : 'Getting GPS… (offline)'); setResult(null);
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const captured_at = new Date().toISOString();
      const client_id = uuid();
      // Stash the check-in locally (raw photo Blob + GPS) to sync later.
      const queueIt = async () => {
        await oqAdd({ client_id, site_code: selected.code, site_name: selected.name, latitude, longitude, accuracy, captured_at, source: 'regular', photo: file });
        setResult({ offline: true, siteName: selected.name });
        buzz([80, 60, 80]);
        if (photoPreview) URL.revokeObjectURL(photoPreview.url);
        setPhotoPreview(null);
        await refreshPending();
      };
      // Already offline → don't even try the network; queue straight away.
      if (!navigator.onLine) { setBusy(''); return queueIt(); }
      try {
        const token = (await getDb().auth.getSession()).data.session?.access_token;
        setBusy('Uploading photo…');
        const photo_url = await window.uploadReceipt(file, profile.id);
        if (!photo_url) throw new Error('Photo upload failed — check your network and try again.');
        setBusy('Checking in…');
        const res = await fetch('/api/receipt-url', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ checkin: { site_code: selected.code, site_name: selected.name, latitude, longitude, accuracy, photo_url, source: 'regular', client_id, captured_at } }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Check-in failed');
        setResult({ ...body, siteName: selected.name });
        buzz([80, 60, 80]);
        loadToday();
        if (photoPreview) URL.revokeObjectURL(photoPreview.url);
        setPhotoPreview(null); // success → clear preview, show the result card below
      } catch (err) {
        // Network dropped mid-request (no signal) → save offline instead of failing.
        // A real server error (device online, server said no) → show it so they can fix.
        if (!navigator.onLine || err?.name === 'TypeError') { await queueIt(); }
        else { setResult({ error: err.message }); } // keep the preview so Retake/Check in stay available to retry
      }
      finally { setBusy(''); }
    }, (err) => {
      setBusy('');
      setResult({ error: err.code === 1 ? 'GPS permission needed (allow location in the browser).' : "Couldn't get GPS location — try in the open." });
    }, { enableHighAccuracy: true, timeout: navigator.onLine ? 15000 : 30000, maximumAge: 0 });
  }

  // ── derived ──
  const doneAt = {};
  today.filter((c) => c.source !== 'notification').forEach((c) => { doneAt[slotOf(c.checked_at)] = timeIN(c.checked_at); });
  const nowKey = currentSlot();
  const notifOn = notifState === 'on';
  const firstName = (profile?.name || '').split(' ')[0] || '';
  const dateLabel = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
  const hm = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const clockMain = hm.replace(/\s?(AM|PM|am|pm)$/, '');
  const clockAmPm = (hm.match(/(AM|PM|am|pm)$/) || [''])[0].toUpperCase();
  const clockSec = String(now.getSeconds()).padStart(2, '0');

  const liveDist = gpsPos && siteGeo ? Math.round(hav(gpsPos.lat, gpsPos.lon, siteGeo.latitude, siteGeo.longitude)) : null;
  const liveInside = liveDist != null ? liveDist <= (siteGeo.radius_m || 200) : null;

  const sq = sheetQ.trim().toLowerCase();
  let sheetMatches = sites;
  if (sq) {
    const pre = [], sub = [];
    for (const s of sites) {
      const name = s.name.toLowerCase(), code = s.code.toLowerCase(), dist = (s.district || '').toLowerCase();
      if (name.startsWith(sq) || code.startsWith(sq) || code.replace('loc', '').startsWith(sq.replace('loc', ''))) pre.push(s);
      else if (name.includes(sq) || code.includes(sq) || dist.includes(sq)) sub.push(s);
    }
    sheetMatches = [...pre, ...sub];
  }
  sheetMatches = sheetMatches.slice(0, 80);

  const punchReady = notifOn && !!selected && !busy && !camOn && !photoPreview;
  const punchLabel = busy ? busy : !notifOn ? 'NOTIFS OFF' : !selected ? 'SELECT SITE' : 'CHECK IN';

  const slotChip = (key, label) => {
    const done = doneAt[key];
    if (done) return <span key={key} style={{ fontSize: '.68rem', color: '#4ade80', fontWeight: 700 }}>✓ {label} {done}</span>;
    if (key === nowKey) return <span key={key} style={{ fontSize: '.68rem', color: '#fbbf24', fontWeight: 700 }}>● {label} — do now</span>;
    return <span key={key} style={{ fontSize: '.68rem', color: '#64748b', fontWeight: 600 }}>○ {label}</span>;
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <div className="app-main" style={{ background: '#f1f5f9' }}>
        {/* Dark clock header */}
        <div style={{ background: '#0f172a', padding: '0 0 1.15rem' }}>
          <header className="topbar" style={{ background: 'transparent', borderBottom: 'none' }}>
            <button className="topbar-menu" onClick={() => window.toggleSidebar()} aria-label="Open menu" style={{ color: '#94a3b8' }}>
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <span className="topbar-title" style={{ color: '#e2e8f0' }}>Hi{firstName ? `, ${firstName}` : ''}</span>
            <div className="topbar-right">
              {gpsPos && <span style={{ fontSize: '.68rem', fontWeight: 800, color: gpsPos.acc <= 100 ? '#4ade80' : '#fbbf24', background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)', borderRadius: 999, padding: '3px 9px' }}>📡 ±{gpsPos.acc}m</span>}
              {gpsErr && !gpsPos && <span style={{ fontSize: '.68rem', fontWeight: 800, color: '#f87171', background: 'rgba(255,255,255,.08)', borderRadius: 999, padding: '3px 9px' }}>📡 GPS off</span>}
            </div>
          </header>
          <div style={{ textAlign: 'center' }}>
            <div style={{ color: '#fff', fontSize: '2.1rem', fontWeight: 700, letterSpacing: '.02em', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
              {clockMain}<span style={{ fontSize: '1rem', color: '#64748b' }}>:{clockSec} {clockAmPm}</span>
            </div>
            <div style={{ fontSize: '.74rem', color: '#94a3b8', marginTop: 5 }}>{dateLabel} · <span style={{ color: '#fbbf24', fontWeight: 700 }}>{SLOTS.find((s) => s.key === nowKey).label} slot</span></div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 14, marginTop: 10, flexWrap: 'wrap', padding: '0 .75rem' }}>
            {SLOTS.map((s) => slotChip(s.key, s.label))}
          </div>
        </div>

        <main className="page-content" style={{ maxWidth: 520, margin: '0 auto', paddingTop: '.9rem' }}>
          {/* Offline queue banner — check-ins saved on the phone, waiting for network */}
          {pendingCount > 0 && (
            <div style={{ background: '#fffbeb', border: '1.5px solid #fde68a', borderRadius: 14, padding: '.7rem 1rem', marginBottom: '.8rem', display: 'flex', alignItems: 'center', gap: '.6rem' }}>
              <span style={{ fontSize: '1.1rem' }}>⏳</span>
              <div style={{ flex: 1, fontSize: '.78rem', color: '#92400e' }}>
                <b>{pendingCount} check-in offline saved.</b> {navigator.onLine ? 'Syncing…' : 'Network aate hi apne aap chala jayega.'}
              </div>
              {navigator.onLine && <button onClick={syncQueue} style={{ background: '#92400e', color: '#fff', border: 'none', borderRadius: 10, padding: '.5rem .9rem', fontWeight: 800, fontSize: '.78rem', cursor: 'pointer' }}>Sync now</button>}
            </div>
          )}

          {/* Notifications banner */}
          {!notifOn && notifState !== 'unsupported' && (
            <div style={{ background: notifState === 'blocked' ? '#fef2f2' : '#fff', border: `1.5px solid ${notifState === 'blocked' ? '#fecaca' : '#e2e8f0'}`, borderRadius: 14, padding: '.8rem 1rem', marginBottom: '.8rem', display: 'flex', alignItems: 'center', gap: '.7rem', boxShadow: '0 4px 14px rgba(15,23,42,.06)' }}>
              <span style={{ fontSize: '1.2rem' }}>{notifState === 'blocked' ? '🔕' : '🔔'}</span>
              <div style={{ flex: 1, fontSize: '.78rem', color: notifState === 'blocked' ? '#991b1b' : '#334155' }}>
                {notifState === 'blocked'
                  ? <><b>Notifications blocked.</b> Tap 🔒 in the address bar → Notifications → Allow, then reload.</>
                  : <><b>Turn on notifications</b> — required to check in.</>}
              </div>
              {notifState === 'blocked'
                ? <button onClick={() => location.reload()} style={{ background: '#0f172a', color: '#fff', border: 'none', borderRadius: 10, padding: '.55rem .9rem', fontWeight: 800, fontSize: '.8rem', cursor: 'pointer' }}>Reload</button>
                : <button onClick={enableNotifications} disabled={notifBusy} style={{ background: '#0f172a', color: '#fff', border: 'none', borderRadius: 10, padding: '.55rem 1rem', fontWeight: 800, fontSize: '.85rem', cursor: 'pointer' }}>{notifBusy ? '…' : 'Turn ON'}</button>}
            </div>
          )}

          {/* Map + site card */}
          <div style={{ background: '#fff', borderRadius: 16, overflow: 'hidden', marginBottom: '.9rem', boxShadow: '0 4px 16px rgba(15,23,42,.08)' }}>
            <div ref={mapDivRef} style={{ height: 150, background: '#dbeafe' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', padding: '.65rem .85rem' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {selected ? (
                  <>
                    <div style={{ fontWeight: 800, fontSize: '.88rem', color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {selected.name} <span style={{ color: '#64748b', fontWeight: 600, fontSize: '.72rem' }}>{selected.code}</span>
                      {autoPicked && !userPicked && (
                        <span style={{ marginLeft: 6, background: '#eff6ff', color: '#2563eb', borderRadius: 5, padding: '1px 6px', fontSize: '.62rem', fontWeight: 800, whiteSpace: 'nowrap' }}>📍 auto-detected</span>
                      )}
                    </div>
                    <div style={{ fontSize: '.74rem', fontWeight: 700, marginTop: 1, color: liveInside === true ? '#16a34a' : liveInside === false ? '#b45309' : '#64748b' }}>
                      {!siteGeo ? 'Fence not set — GPS will still be recorded'
                        : liveDist == null ? 'Waiting for GPS…'
                        : liveInside ? `You are ${liveDist} m from site — inside fence`
                        : `You are ${liveDist} m from site — outside fence`}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: '.85rem', color: '#64748b', fontWeight: 600 }}>Select your site to see the fence</div>
                )}
              </div>
              <button onClick={() => { setSheetOpen(true); setSheetQ(''); }} style={{ background: '#f1f5f9', border: 'none', borderRadius: 10, padding: '.5rem .8rem', fontWeight: 800, fontSize: '.78rem', color: '#2563eb', cursor: 'pointer', flexShrink: 0 }}>
              {selected ? 'Change ▾' : 'Select ▾'}
              </button>
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
                <div style={{ position: 'absolute', top: 12, left: 12, background: 'rgba(15,23,42,.7)', color: '#fff', borderRadius: 8, padding: '3px 10px', fontSize: '.7rem', fontWeight: 700 }}>Photo captures → auto check-in</div>
              </>
            )}
          </div>

          {/* Photo preview — review before submitting (Retake or confirm) */}
          {!camOn && photoPreview && (
            <div style={{ marginBottom: '.9rem' }}>
              <div style={{ position: 'relative', borderRadius: 16, overflow: 'hidden' }}>
                <img src={photoPreview.url} alt="Captured" style={{ width: '100%', height: 320, objectFit: 'cover', display: 'block' }} />
                <span style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(15,23,42,.7)', color: '#fff', borderRadius: 8, padding: '3px 10px', fontSize: '.7rem', fontWeight: 700 }}>Review your photo</span>
              </div>
              <div style={{ display: 'flex', gap: '.6rem', marginTop: '.7rem' }}>
                <button onClick={retakePhoto} disabled={!!busy}
                  style={{ flex: 1, height: 50, background: '#fff', border: '1.5px solid #e2e8f0', borderRadius: 999, fontWeight: 800, fontSize: '.9rem', color: '#334155', cursor: busy ? 'wait' : 'pointer' }}>🔄 Retake</button>
                <button onClick={confirmPhoto} disabled={!!busy}
                  style={{ flex: 2, height: 50, background: busy ? 'linear-gradient(135deg,#0ea5e9,#0369a1)' : 'linear-gradient(135deg,#22c55e,#15803d)', color: '#fff', border: 'none', borderRadius: 999, fontWeight: 800, fontSize: '.9rem', cursor: busy ? 'wait' : 'pointer', boxShadow: '0 8px 20px rgba(21,128,61,.3)' }}>
                  {busy || '✅ Check in with this photo'}
                </button>
              </div>
            </div>
          )}

          {/* Round punch button */}
          {!camOn && !photoPreview && (
            <>
              <div style={{ display: 'flex', justifyContent: 'center', padding: '.4rem 0 .5rem' }}>
                <div style={{ position: 'relative', width: 150, height: 150 }}>
                  {punchReady && <div className="punch-ring" style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(34,197,94,.25)' }} />}
                  {punchReady && <div className="punch-ring r2" style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(34,197,94,.18)' }} />}
                  <button onClick={startCheckin} disabled={!!busy}
                    style={{ position: 'absolute', inset: 12, borderRadius: '50%', border: 'none', cursor: busy ? 'wait' : 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, color: '#fff', background: punchReady ? 'linear-gradient(135deg,#22c55e,#15803d)' : busy ? 'linear-gradient(135deg,#0ea5e9,#0369a1)' : 'linear-gradient(135deg,#94a3b8,#64748b)', boxShadow: punchReady ? '0 12px 28px rgba(21,128,61,.4)' : '0 10px 22px rgba(15,23,42,.2)' }}>
                    <span style={{ fontSize: '1.5rem', lineHeight: 1 }}>{busy ? '⏳' : '👆'}</span>
                    <span style={{ fontWeight: 800, fontSize: busy ? '.72rem' : '.95rem', letterSpacing: '.04em', padding: '0 .5rem', textAlign: 'center' }}>{punchLabel}</span>
                    {!busy && <span style={{ fontSize: '.62rem', color: 'rgba(255,255,255,.75)', fontWeight: 600 }}>photo + GPS</span>}
                  </button>
                </div>
              </div>
              <div style={{ textAlign: 'center', fontSize: '.72rem', color: '#94a3b8', marginBottom: '.9rem' }}>
                {punchReady ? 'Tap → camera → photo → review → check in' : !notifOn ? 'Enable notifications above to continue' : !selected ? 'Tap to choose your site' : ''}
              </div>
            </>
          )}

          {/* Result */}
          {result && (
            <div style={{ marginBottom: '.9rem' }}>
              {result.offline ? (
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 14, padding: '1rem', color: '#92400e' }}>
                  <div style={{ fontSize: '1rem', fontWeight: 800 }}>✅ Offline save ho gaya</div>
                  <div style={{ fontSize: '.83rem', marginTop: '.2rem' }}><b>{result.siteName}</b> — photo aur location phone me save h. Network aate hi apne aap check-in ho jayega.</div>
                </div>
              ) : result.error ? (
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 14, padding: '.9rem 1rem', color: '#991b1b', fontSize: '.85rem', fontWeight: 600 }}>{result.error}</div>
              ) : !result.has_fence ? (
                <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 14, padding: '1rem', color: '#1e40af' }}>
                  <div style={{ fontSize: '1rem', fontWeight: 800 }}>✅ Check-in recorded</div>
                  <div style={{ fontSize: '.83rem', marginTop: '.2rem' }}><b>{result.siteName}</b>'s geo-fence isn't set yet — location saved, HR will verify.</div>
                </div>
              ) : result.inside_fence ? (
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 14, padding: '1rem', color: '#166534' }}>
                  <div style={{ fontSize: '1rem', fontWeight: 800 }}>✅ Check-in successful</div>
                  <div style={{ fontSize: '.83rem', marginTop: '.2rem' }}>You're at <b>{result.siteName}</b> — {result.distance_m} m from the site. Attendance marked.</div>
                </div>
              ) : (
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 14, padding: '1rem', color: '#92400e' }}>
                  <div style={{ fontSize: '1rem', fontWeight: 800 }}>⚠️ Outside the site</div>
                  <div style={{ fontSize: '.83rem', marginTop: '.2rem' }}>You're {result.distance_m} m from <b>{result.siteName}</b> (fence {result.radius_m} m). Recorded as "outside" — HR will review.</div>
                </div>
              )}
              {result.site_mismatch && result.nearest_site_name && (
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 14, padding: '.75rem 1rem', color: '#991b1b', marginTop: '.5rem', fontSize: '.8rem' }}>
                  📍 Your GPS is closer to <b>{result.nearest_site_name}</b> ({result.nearest_distance_m} m). Did you pick the right site? HR will see this note.
                </div>
              )}
            </div>
          )}

          {/* Today timeline */}
          <div style={{ background: '#fff', borderRadius: 16, padding: '1rem', marginBottom: '1.2rem', boxShadow: '0 4px 14px rgba(15,23,42,.06)' }}>
            <div style={{ fontSize: '.72rem', fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: '.6rem' }}>Today</div>
            {today.length === 0 && !doneAt[nowKey] && (
              <div style={{ fontSize: '.82rem', color: '#94a3b8' }}>No check-ins yet — {SLOTS.find((s) => s.key === nowKey).label} slot is open.</div>
            )}
            {today.map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: '.6rem', alignItems: 'flex-start', paddingBottom: '.55rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', alignSelf: 'stretch' }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: c.inside_fence ? '#22c55e' : '#f59e0b', marginTop: 4, flexShrink: 0 }}></span>
                  {i < today.length - 1 && <span style={{ width: 1.5, flex: 1, background: '#e2e8f0', marginTop: 2 }}></span>}
                </div>
                <div style={{ flex: 1, minWidth: 0, fontSize: '.83rem' }}>
                  <span style={{ fontWeight: 700, color: '#0f172a' }}>{c.site_name}</span>
                  {c.source === 'notification' && <span style={{ marginLeft: 6, background: '#f1f5f9', color: '#475569', borderRadius: 5, padding: '1px 6px', fontSize: '.62rem', fontWeight: 800 }}>🔔 verify</span>}
                  <div style={{ color: '#94a3b8', fontSize: '.72rem', marginTop: 1 }}>
                    {timeIN(c.checked_at)} · {c.inside_fence ? 'inside fence' : c.inside_fence === false ? 'outside fence' : 'no fence'}{c.distance_m != null ? ` · ${c.distance_m}m` : ''} {c.photo_url ? '· 📷' : ''}
                  </div>
                </div>
              </div>
            ))}
            {!doneAt[nowKey] && (
              <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', border: '2px solid #f59e0b', flexShrink: 0 }}></span>
                <span style={{ fontSize: '.8rem', fontWeight: 700, color: '#b45309' }}>{SLOTS.find((s) => s.key === nowKey).label} — pending</span>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Bottom-sheet site picker */}
      {sheetOpen && (
        <div onClick={() => setSheetOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,.45)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 560, background: '#fff', borderRadius: '24px 24px 0 0', maxHeight: Math.round(vh * 0.85), display: 'flex', flexDirection: 'column', boxShadow: '0 -12px 40px rgba(15,23,42,.25)' }}>
            <div style={{ padding: '.9rem 1rem .5rem' }}>
              <div style={{ width: 40, height: 4, background: '#e2e8f0', borderRadius: 4, margin: '0 auto .7rem' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
                <input ref={sheetInputRef} value={sheetQ} onChange={(e) => setSheetQ(e.target.value)} placeholder="Search site name or LOC code…"
                  style={{ flex: 1, height: 46, border: '1.5px solid #cbd5e1', borderRadius: 12, padding: '0 .9rem', fontSize: '1rem', fontFamily: 'inherit', outline: 'none' }} />
                <button onClick={() => setSheetOpen(false)} style={{ background: '#f1f5f9', border: 'none', borderRadius: 10, width: 42, height: 42, fontWeight: 800, color: '#475569', cursor: 'pointer' }}>✕</button>
              </div>
              <div style={{ fontSize: '.72rem', color: '#94a3b8', marginTop: '.45rem', fontWeight: 600 }}>{sheetMatches.length} site{sheetMatches.length === 1 ? '' : 's'}</div>
            </div>
            <div style={{ overflowY: 'auto', padding: '0 .5rem .8rem' }}>
              {sheetMatches.map((s) => {
                const isSel = selected && selected.code === s.code;
                return (
                  <div key={s.code} onClick={() => { setSiteVal(`${s.name} — ${s.code}`); setUserPicked(true); setAutoPicked(false); setSheetOpen(false); buzz(30); }}
                    style={{ padding: '.7rem .8rem', borderRadius: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '.6rem', background: isSel ? '#f0fdf4' : 'transparent' }}>
                    <span style={{ fontSize: '1rem' }}>📍</span>
                    <span style={{ flex: 1 }}>
                      <span style={{ display: 'block', fontWeight: 700, fontSize: '.92rem', color: '#0f172a' }}>{s.name}</span>
                      <span style={{ display: 'block', fontSize: '.72rem', color: '#64748b' }}><span style={{ color: '#16a34a', fontWeight: 700 }}>{s.code}</span>{s.district ? ` · ${s.district}` : ''}</span>
                    </span>
                    {isSel && <span style={{ color: '#16a34a', fontWeight: 800 }}>✓</span>}
                  </div>
                );
              })}
              {sheetMatches.length === 0 && <div style={{ padding: '1.5rem', textAlign: 'center', color: '#94a3b8', fontSize: '.88rem' }}>No sites match "{sheetQ}"</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
