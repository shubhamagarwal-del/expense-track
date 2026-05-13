/* ExpenseTrack service worker */
const CACHE_VERSION = 'v1';
const CACHE_NAME = `expensetrack-${CACHE_VERSION}`;

const APP_SHELL = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/add-expense.html',
  '/plans.html',
  '/profile.html',
  '/create-user.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon.svg',
  '/icon-maskable.svg',
  '/pwa-register.js',
];

const CDN_PRECACHE = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdn.jsdelivr.net/npm/xlsx/dist/xlsx.full.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Same-origin shell — fail the install if any are missing
      await cache.addAll(APP_SHELL);
      // CDN assets — best-effort, don't block install if network is flaky
      await Promise.allSettled(
        CDN_PRECACHE.map((url) =>
          fetch(url, { mode: 'no-cors' })
            .then((res) => cache.put(url, res))
            .catch(() => {})
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Always go to network for our own API and Supabase REST/Auth
  if (url.pathname.startsWith('/api/')) return;
  if (url.hostname.endsWith('.supabase.co') && !url.pathname.startsWith('/storage/')) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (
            response &&
            response.ok &&
            (url.origin === self.location.origin ||
              url.hostname.endsWith('jsdelivr.net') ||
              url.hostname.endsWith('googleapis.com') ||
              url.hostname.endsWith('gstatic.com') ||
              url.hostname.endsWith('.supabase.co'))
          ) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => null);

      // Stale-while-revalidate for cached items
      if (cached) {
        networkFetch.catch(() => {});
        return cached;
      }

      return networkFetch.then((response) => {
        if (response) return response;
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('Offline', {
          status: 503,
          statusText: 'Offline',
          headers: { 'Content-Type': 'text/plain' },
        });
      });
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
