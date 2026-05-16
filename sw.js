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
const CACHE_VERSION = '2026-05-16-002';
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

  // 5. Same-origin static assets (CSS, JS, images) → stale-while-revalidate
  event.respondWith(staleWhileRevalidate(request));
});

// ── Strategies ────────────────────────────────────────────

/** Network first. On failure serve cached version. On success update cache. */
async function networkFirstHTML(request) {
  try {
    const response = await fetch(request);
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
