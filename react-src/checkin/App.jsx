// React Site Check-in — market-inspired design (live clock, mini map with
// geo-fence, big round punch button, one-tap flow). Same functionality:
// notifications required, strict site pick, live photo only, GPS + fence,
// 3 slots, today list. Connects via app.js globals (same session/API/data).
import React, { useEffect, useRef, useState } from 'react';
import Sidebar from '../Sidebar.jsx';

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

// Open-Meteo weather_code → a little icon + label (free API, no key).
const wxFromCode = (c) => {
  if (c == null) return { icon: '🌡️', label: 'Weather' };
  if (c === 0) return { icon: '☀️', label: 'Clear' };
  if (c <= 2) return { icon: '⛅', label: 'Partly cloudy' };
  if (c === 3) return { icon: '☁️', label: 'Cloudy' };
  if (c <= 48) return { icon: '🌫️', label: 'Fog' };
  if (c <= 67) return { icon: '🌧️', label: 'Rain' };
  if (c <= 77) return { icon: '🌨️', label: 'Snow' };
  if (c <= 82) return { icon: '🌦️', label: 'Showers' };
  return { icon: '⛈️', label: 'Storm' };
};

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

// Sidebar is the shared component imported from ../Sidebar.jsx.

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
  const [weather, setWeather] = useState(null);      // { temp, icon, label } | null
  const [battery, setBattery] = useState(null);      // { level, charging } | null
  const [recent, setRecent] = useState(null);        // last check-in row | null
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
      loadRecent(prof);
      try { const reg = await navigator.serviceWorker?.ready; (await reg?.getNotifications())?.forEach((n) => n.close()); } catch { }
    })();
  }, []);

  // Last check-in (any day) — powers the "Recent Activity" card.
  async function loadRecent(prof = profile) {
    try {
      const { data } = await getDb().from('attendance_checkins')
        .select('site_name, site_code, inside_fence, checked_at, photo_url, source')
        .eq('user_id', prof.id).order('checked_at', { ascending: false }).limit(1);
      setRecent(data?.[0] || null);
    } catch { }
  }

  // Weather from live GPS (Open-Meteo — free, no key). Fetched once GPS is known.
  useEffect(() => {
    if (!gpsPos || weather) return;
    (async () => {
      try {
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${gpsPos.lat}&longitude=${gpsPos.lon}&current=temperature_2m,weather_code`);
        const j = await r.json();
        const t = j?.current?.temperature_2m;
        if (t != null) setWeather({ temp: Math.round(t), ...wxFromCode(j.current.weather_code) });
      } catch { }
    })();
  }, [gpsPos, weather]);

  // Battery (where the browser supports it — Chrome/Android; not iOS Safari).
  useEffect(() => {
    let b;
    const upd = () => setBattery({ level: Math.round(b.level * 100), charging: b.charging });
    if (navigator.getBattery) navigator.getBattery().then((bat) => { b = bat; upd(); b.addEventListener('levelchange', upd); b.addEventListener('chargingchange', upd); }).catch(() => { });
    return () => { if (b) { b.removeEventListener('levelchange', upd); b.removeEventListener('chargingchange', upd); } };
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

  const greeting = now.getHours() < 12 ? 'Good Morning' : now.getHours() < 17 ? 'Good Afternoon' : 'Good Evening';
  const fullDate = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
  const SLOT_ORDER = ['morning', 'afternoon', 'evening'];
  const curIdx = SLOT_ORDER.indexOf(nowKey);
  const slotStatus = (key) => doneAt[key] ? 'done' : (SLOT_ORDER.indexOf(key) <= curIdx ? 'pending' : 'locked');
  const doneCount = SLOT_ORDER.filter((k) => doneAt[k]).length;
  const pct = Math.round((doneCount / 3) * 100);
  const recentDay = (() => {
    if (!recent) return null;
    const d = new Date(recent.checked_at), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
    const same = (a, b) => a.toDateString() === b.toDateString();
    return same(d, t) ? 'Today' : same(d, y) ? 'Yesterday' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  })();
  const navItem = (href, icon, label) => (
    <a href={href} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, fontSize: 11, color: '#94a3b8', fontWeight: 700, textDecoration: 'none' }}><span style={{ fontSize: 20 }}>{icon}</span>{label}</a>
  );

  return (
    <div className="app-layout">
      <Sidebar active="checkin-react.html" />
      <div className="app-main" style={{ background: '#eef2f7' }}>
        <main className="page-content" style={{ maxWidth: 480, margin: '0 auto', padding: '14px 16px 0' }}>

          {/* Header — greeting + date + bell */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => window.toggleSidebar()} aria-label="Menu" style={{ background: 'none', border: 'none', marginTop: 5, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 5, padding: 0 }}>
                <span style={{ width: 22, height: 2.5, background: '#0f172a', borderRadius: 2 }} />
                <span style={{ width: 16, height: 2.5, background: '#0f172a', borderRadius: 2 }} />
                <span style={{ width: 20, height: 2.5, background: '#0f172a', borderRadius: 2 }} />
              </button>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.3px', color: '#0f172a' }}>{greeting}{firstName ? `, ${firstName}` : ''} 👋</div>
                <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>{fullDate}</div>
              </div>
            </div>
            <div style={{ width: 44, height: 44, borderRadius: 14, background: '#fff', boxShadow: '0 4px 14px rgba(15,23,42,.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, position: 'relative', flexShrink: 0 }}>🔔
              {(pendingCount > 0 || (!notifOn && notifState !== 'unsupported')) && <span style={{ position: 'absolute', top: 11, right: 12, width: 8, height: 8, background: '#ef4444', borderRadius: '50%', border: '2px solid #fff' }} />}
            </div>
          </div>

          {/* Clock + weather */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 42, fontWeight: 800, letterSpacing: '-1px', lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: '#0f172a' }}>{clockMain}</span>
              <span style={{ fontSize: 17, fontWeight: 700, color: '#64748b' }}>{clockAmPm}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#eff6ff', color: '#2563eb', fontSize: 12, fontWeight: 800, padding: '5px 11px', borderRadius: 999, marginLeft: 4 }}><span className="punch-ring" style={{ width: 7, height: 7, background: '#2563eb', borderRadius: '50%' }} />LIVE</span>
            </div>
            {weather && <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 4px 14px rgba(15,23,42,.07)', display: 'flex', alignItems: 'center', gap: 9, padding: '9px 13px' }}><span style={{ fontSize: 24 }}>{weather.icon}</span><div><div style={{ fontSize: 18, fontWeight: 800 }}>{weather.temp}°C</div><div style={{ fontSize: 11, color: '#64748b' }}>{weather.label}</div></div></div>}
          </div>

          {/* GPS status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, marginBottom: 4, fontSize: 13, fontWeight: 600, flexWrap: 'wrap' }}>
            {gpsPos ? (<>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: gpsPos.acc <= 20 ? '#16a34a' : gpsPos.acc <= 100 ? '#b45309' : '#dc2626', fontWeight: 700 }}><span style={{ width: 9, height: 9, borderRadius: '50%', background: 'currentColor', boxShadow: '0 0 0 4px rgba(34,197,94,.18)' }} />{gpsPos.acc <= 20 ? 'GPS Excellent' : gpsPos.acc <= 100 ? 'GPS Good' : 'GPS Weak'}</span>
              <span style={{ width: 1, height: 14, background: '#cbd5e1' }} />
              <span style={{ color: '#334155' }}>🎯 Accuracy {gpsPos.acc} m</span>
            </>) : gpsErr ? <span style={{ color: '#dc2626', fontWeight: 700 }}>📡 GPS off — allow location</span> : <span style={{ color: '#64748b' }}>📡 Getting GPS…</span>}
          </div>

          {/* Offline queue banner — check-ins saved on the phone, waiting for network */}
          <div style={{ marginTop: 8 }} />
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

          {/* Current site card */}
          <div style={{ background: '#fff', borderRadius: 20, boxShadow: '0 6px 22px rgba(15,23,42,.06)', padding: 16, marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ width: 46, height: 46, borderRadius: 14, background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>🏢</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>Current Site</div>
                {selected ? (
                  <>
                    <div style={{ fontSize: 18, fontWeight: 800, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.name} <span style={{ color: '#64748b', fontWeight: 600, fontSize: 13 }}>{selected.code}</span></div>
                    {siteGeo && liveInside != null
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: liveInside ? '#f0fdf4' : '#fffbeb', color: liveInside ? '#16a34a' : '#b45309', fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 999, marginTop: 6 }}>{liveInside ? '✓ Inside Geofence' : '⚠️ Outside Geofence'}</span>
                      : !siteGeo ? <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600, marginTop: 5 }}>Fence not set — GPS still recorded</div> : null}
                    {autoPicked && !userPicked && <span style={{ marginLeft: 6, background: '#eff6ff', color: '#2563eb', borderRadius: 5, padding: '1px 6px', fontSize: 11, fontWeight: 800 }}>📍 auto</span>}
                  </>
                ) : <div style={{ fontSize: 16, fontWeight: 800, marginTop: 1, color: '#64748b' }}>Select your site</div>}
              </div>
              <button onClick={() => { setSheetOpen(true); setSheetQ(''); }} style={{ background: 'none', border: 'none', color: '#2563eb', fontSize: 13, fontWeight: 700, cursor: 'pointer', flexShrink: 0, padding: 0 }}>{selected ? 'Change ›' : 'Select ›'}</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
              <div style={{ background: '#f8fafc', borderRadius: 14, padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 10 }}><div style={{ width: 34, height: 34, borderRadius: 10, background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>📍</div><div style={{ minWidth: 0 }}><div style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>Distance from site</div><div style={{ fontSize: 15, fontWeight: 800 }}>{liveDist != null ? `${liveDist} m` : '—'}</div></div></div>
              <div style={{ background: '#f8fafc', borderRadius: 14, padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 10 }}><div style={{ width: 34, height: 34, borderRadius: 10, background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>🛡️</div><div style={{ minWidth: 0 }}><div style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>Status</div><div style={{ fontSize: 15, fontWeight: 800, color: liveInside === true ? '#16a34a' : liveInside === false ? '#b45309' : '#64748b' }}>{liveInside === true ? 'Inside Fence' : liveInside === false ? 'Outside' : siteGeo ? '—' : 'No fence'}</div></div></div>
            </div>
            <div ref={mapDivRef} style={{ height: 170, borderRadius: 16, marginTop: 14, overflow: 'hidden', background: '#dbeafe' }} />
          </div>

          {/* Camera (one-tap flow). The <video> stays mounted at all times (like the
              working vanilla page did) — only hidden via display:none — so when
              openCamera() runs, the element already exists and srcObject can be
              assigned immediately with no mount-timing race. */}
          <div style={{ position: 'relative', marginTop: camOn ? 16 : 0, marginBottom: camOn ? '.9rem' : 0, display: camOn ? 'block' : 'none' }}>
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
            <div style={{ marginTop: 16, marginBottom: '.9rem' }}>
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

          {/* CHECK IN gradient button */}
          {!camOn && !photoPreview && (
            <button onClick={startCheckin} disabled={!!busy}
              style={{ width: '100%', marginTop: 16, border: 'none', borderRadius: 20, padding: 20, display: 'flex', alignItems: 'center', gap: 16, color: '#fff', cursor: busy ? 'wait' : 'pointer', textAlign: 'left', background: busy ? 'linear-gradient(100deg,#0ea5e9,#0369a1)' : 'linear-gradient(100deg,#16a34a 0%,#22c55e 42%,#2563eb 100%)', boxShadow: '0 12px 26px rgba(37,99,235,.28)' }}>
              <span style={{ width: 60, height: 60, borderRadius: '50%', background: 'rgba(255,255,255,.95)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, flexShrink: 0 }}>{busy ? '⏳' : '📷'}</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 22, fontWeight: 800, letterSpacing: '.3px' }}>{busy ? busy : !notifOn ? 'ENABLE NOTIFS' : !selected ? 'SELECT SITE' : 'CHECK IN'}</span>
                <span style={{ display: 'block', fontSize: 13, opacity: .9, marginTop: 2 }}>Photo + GPS Verification</span>
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 22, opacity: .9 }}>›</span>
            </button>
          )}

          {/* Result */}
          {result && (
            <div style={{ marginTop: 16, marginBottom: '.9rem' }}>
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

          {/* Today's Slots */}
          <div style={{ background: '#fff', borderRadius: 20, boxShadow: '0 6px 22px rgba(15,23,42,.06)', padding: 16, marginTop: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 14 }}>📅 Today's Slots</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
              {SLOTS.map((s) => {
                const st = slotStatus(s.key);
                const bg = st === 'done' ? '#f0fdf4' : st === 'pending' ? '#fffbeb' : '#f1f5f9';
                const bBg = st === 'done' ? '#dcfce7' : st === 'pending' ? '#fef3c7' : '#e2e8f0';
                const bCol = st === 'done' ? '#16a34a' : st === 'pending' ? '#b45309' : '#64748b';
                const badge = st === 'done' ? '✓ Completed' : st === 'pending' ? '⏳ Pending' : '🔒 Locked';
                const icon = { morning: '☀️', afternoon: '⛅', evening: '🌙' }[s.key];
                return (
                  <div key={s.key} style={{ background: bg, borderRadius: 15, padding: 12 }}>
                    <div style={{ fontSize: 20 }}>{icon}</div>
                    <div style={{ fontSize: 14, fontWeight: 800, marginTop: 6 }}>{s.label}</div>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: bBg, color: bCol, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, marginTop: 6 }}>{badge}</span>
                    <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 9, textTransform: 'uppercase', letterSpacing: '.03em' }}>Check-in</div>
                    <div style={{ fontSize: 13, fontWeight: 800, marginTop: 2, color: st === 'done' ? '#0f172a' : '#94a3b8' }}>{doneAt[s.key] || '---'}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Today's Progress */}
          <div style={{ background: '#fff', borderRadius: 20, boxShadow: '0 6px 22px rgba(15,23,42,.06)', padding: 16, marginTop: 16, display: 'flex', alignItems: 'center', gap: 18 }}>
            <div style={{ width: 100, height: 100, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `conic-gradient(#22c55e ${pct / 100}turn, #e5edf5 ${pct / 100}turn)` }}>
              <div style={{ width: 78, height: 78, borderRadius: '50%', background: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ fontSize: 21, fontWeight: 800 }}>{pct}%</div><div style={{ fontSize: 10, color: '#64748b' }}>Complete</div>
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 800 }}>Today's Progress</div>
              <div style={{ fontSize: 12, color: '#64748b', margin: '2px 0 12px' }}>{doneCount === 3 ? 'All done — great job!' : doneCount > 0 ? "Keep it up! You're doing great." : 'Start your first check-in.'}</div>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                {SLOTS.map((s, i) => {
                  const st = slotStatus(s.key);
                  const cBg = st === 'done' ? '#22c55e' : st === 'pending' ? '#fff' : '#e2e8f0';
                  const cCol = st === 'done' ? '#fff' : st === 'pending' ? '#f59e0b' : '#94a3b8';
                  const sCol = st === 'done' ? '#16a34a' : st === 'pending' ? '#b45309' : '#94a3b8';
                  const sTxt = st === 'done' ? 'Completed' : st === 'pending' ? 'Pending' : 'Locked';
                  return (
                    <React.Fragment key={s.key}>
                      {i > 0 && <div style={{ height: 2, flex: 1, background: slotStatus(SLOT_ORDER[i - 1]) === 'done' ? '#22c55e' : '#e5edf5', marginBottom: 22 }} />}
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 62 }}>
                        <div style={{ width: 26, height: 26, borderRadius: '50%', background: cBg, border: st === 'pending' ? '2px solid #f59e0b' : 'none', color: cCol, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>{st === 'done' ? '✓' : st === 'locked' ? '🔒' : '○'}</div>
                        <div style={{ fontSize: 10, fontWeight: 700, marginTop: 5 }}>{s.label}</div>
                        <div style={{ fontSize: 9, marginTop: 1, color: sCol }}>{sTxt}</div>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Recent activity */}
          {recent && (
            <div style={{ background: '#fff', borderRadius: 20, boxShadow: '0 6px 22px rgba(15,23,42,.06)', padding: 16, marginTop: 16 }}>
              <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 14 }}>🕘 Recent Activity</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, background: '#eff6ff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#2563eb', lineHeight: 1 }}>{String(new Date(recent.checked_at).getDate()).padStart(2, '0')}</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#2563eb' }}>{new Date(recent.checked_at).toLocaleDateString('en-IN', { month: 'short' }).toUpperCase()}</div>
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ color: '#2563eb', fontSize: 14, fontWeight: 800 }}>{recentDay}</div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>Check-in · <b style={{ color: '#0f172a' }}>{timeIN(recent.checked_at)}</b></div>
                  <div style={{ fontSize: 12, fontWeight: 700, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{recent.site_name}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: recent.inside_fence === false ? '#b45309' : '#16a34a' }}>{recent.inside_fence === false ? 'Outside fence' : recent.inside_fence ? 'Inside Fence ✓' : 'Recorded'}</div>
                </div>
                <button onClick={() => recent.photo_url && window.viewReceipt && window.viewReceipt(recent.photo_url)} style={{ width: 52, height: 44, borderRadius: 10, border: 'none', background: 'linear-gradient(135deg,#93c5fd,#c7d2fe)', cursor: recent.photo_url ? 'pointer' : 'default', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>{recent.photo_url ? '📷' : ''}</button>
              </div>
            </div>
          )}

          {/* Battery + Connection */}
          <div style={{ display: 'grid', gridTemplateColumns: battery ? '1fr 1fr' : '1fr', gap: 12, marginTop: 16, marginBottom: 16 }}>
            {battery && (
              <div style={{ background: '#fff', borderRadius: 16, padding: '13px 14px', boxShadow: '0 6px 22px rgba(15,23,42,.05)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>{battery.charging ? '🔌' : battery.level <= 20 ? '🪫' : '🔋'}</span>
                <div style={{ minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 800 }}>Battery</div><div style={{ fontSize: 10, color: '#64748b' }}>{battery.level <= 20 ? 'Low — may affect GPS' : 'Healthy'}</div></div>
                <div style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 800, color: battery.level <= 20 ? '#f59e0b' : '#16a34a' }}>{battery.level}%</div>
              </div>
            )}
            <div style={{ background: '#fff', borderRadius: 16, padding: '13px 14px', boxShadow: '0 6px 22px rgba(15,23,42,.05)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 20, color: navigator.onLine ? '#16a34a' : '#94a3b8' }}>📶</span>
              <div style={{ minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 800 }}>Connection</div><div style={{ fontSize: 10, color: '#64748b' }}>{navigator.onLine ? 'All systems operational' : 'Offline — check-ins queue'}</div></div>
              <div style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 800, color: navigator.onLine ? '#16a34a' : '#94a3b8' }}>{navigator.onLine ? 'Online' : 'Offline'}</div>
            </div>
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
