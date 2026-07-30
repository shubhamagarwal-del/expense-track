/* ============================================================
   ExpenseTrack — Service Worker
   Strategy:
     • HTML pages   → network-first  (always fresh, cache as fallback)
     • App JS/CSS   → stale-while-revalidate + background update
     • CDN assets   → cache-first    (versioned CDN URLs don't change)
     • /api/*       → network-only   (never cache API responses)
     • Supabase     → network-only   (auth / realtime / DB)
   ============================================================ */

// ── Cache versioning ──────────────────────────────────────
// This string MUST change with every deployment so the browser
// detects a new SW, evicts the old cache, and reloads clients.
// Format: YYYY-MM-DD-NNN  (increment NNN for same-day deploys)
const CACHE_VERSION = '2026-07-30-016';
const CACHE_NAME    = `expensetrack-${CACHE_VERSION}`;

// Same-origin static assets (CSS / JS / icons / manifest)
// HTML pages are intentionally NOT pre-cached — they must
// always be fetched fresh from the network.
const STATIC_ASSETS = [
  '/style.css',
  '/app.js',
  '/pwa-register.js',
  '/manifest.json',
  '/icon.svg',
  '/help.html',
];

// CDN bundles — cached once, served forever (versioned URLs)
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap',
];

// ── Install ───────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Same-origin static assets — required
    try { await cache.addAll(STATIC_ASSETS); } catch (e) { console.warn('[SW] static cache partial failure:', e); }

    // CDN — best-effort
    await Promise.allSettled(
      CDN_ASSETS.map(url =>
        fetch(url, { mode: 'no-cors' })
          .then(res => cache.put(url, res))
          .catch(() => {})
      )
    );
  })());

  // Activate this SW immediately without waiting for old SW to become idle
  self.skipWaiting();
});

// ── Activate ──────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Delete every cache that is NOT the current version
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    );

    // Take control of all open tabs immediately
    await self.clients.claim();

    // Tell every open tab: "a new version just activated — please reload"
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION }));
  })());
});

// ── Fetch ─────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 1. Never cache: own API routes
  if (url.pathname.startsWith('/api/')) return;

  // 2. Never cache: Supabase auth / DB / realtime (but DO cache storage URLs for receipts)
  if (url.hostname.endsWith('.supabase.co') && !url.pathname.startsWith('/storage/')) return;

  // 3. HTML pages → network-first with cache fallback (always serve latest HTML)
  if (request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    event.respondWith(networkFirstHTML(request));
    return;
  }

  // 4. CDN assets → cache-first (they are content-addressed / versioned)
  if (url.hostname.endsWith('jsdelivr.net') || url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 5. Same-origin JS files → network-first (ensures latest code on every deploy;
  //    falls back to cache only when offline)
  if (url.pathname.endsWith('.js')) {
    event.respondWith(networkFirstHTML(request));
    return;
  }

  // 6. Same-origin CSS / images / other assets → stale-while-revalidate
  event.respondWith(staleWhileRevalidate(request));
});

// ── Strategies ────────────────────────────────────────────

/** Network first. On failure serve cached version. On success update cache.
 *  Uses cache: 'no-store' so the browser's own HTTP disk cache (Vercel sets
 *  max-age=86400 on static assets) can't silently short-circuit the fetch
 *  and hand back yesterday's file — this SW's cache is the only cache. */
async function networkFirstHTML(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Last-resort fallback for navigations
    const fallback = await caches.match('/index.html');
    return fallback || new Response('Offline — please reconnect and try again.', {
      status: 503, headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/** Cache first. Useful for immutable CDN assets. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request, { mode: 'no-cors' });
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
    return response;
  } catch {
    return new Response('', { status: 503 });
  }
}

/** Serve cached immediately; refresh cache in background. */
async function staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const networkPromise = fetch(request).then(response => {
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  return cached ?? await networkPromise ?? new Response('', { status: 503 });
}

// ── Messages from page ─────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Web Push: random "verify you're on site" check-in prompt ──
// The server pushes a payload; we show a notification. Tapping it opens the
// check-in page so the employee can respond with live photo + GPS.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || '📍 Site check-in';
  const body  = data.body  || 'Check in now — live photo + location.';
  const url   = data.url   || '/attendance-checkin.html';
  const tag   = data.tag   || 'site-checkin';
  const REPEATS = data.repeats || 10, GAP = data.gapMs || 2000; // re-alert up to 10×, 2s apart

  // Ring several times: a *new* notification (new tag) alerts every time, while the previous
  // one is closed first — so the tray shows ~one at a time but it re-rings each round.
  // Stops instantly once the employee has the check-in page open.
  event.waitUntil((async () => {
    let prevTag = null;
    for (let i = 0; i < REPEATS; i++) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const onPage = wins.some(w => w.url.includes('attendance-checkin') && (w.focused || w.visibilityState === 'visible'));
      if (onPage) break; // employee is on the check-in page → stop ringing

      const roundTag = `${tag}-${i}`;
      if (prevTag) (await self.registration.getNotifications({ tag: prevTag })).forEach(n => n.close());
      await self.registration.showNotification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: roundTag,                 // fresh tag each round → a real new alert (rings)
        renotify: true,
        requireInteraction: true,      // stays on screen until tapped/dismissed
        silent: false,                 // allow the OS notification sound
        vibrate: [300, 150, 300, 150, 300],
        data: { url },
      });
      prevTag = roundTag;
      if (i < REPEATS - 1) await new Promise(r => setTimeout(r, GAP));
    }
    // Clear everything once done/stopped (e.g. employee opened the page).
    const wins2 = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins2.some(w => w.url.includes('attendance-checkin') && (w.focused || w.visibilityState === 'visible'))) {
      (await self.registration.getNotifications()).forEach(n => n.close());
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/attendance-checkin.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) { if (w.url.includes('attendance-checkin') && 'focus' in w) return w.focus(); }
      return clients.openWindow(url);
    })
  );
});
