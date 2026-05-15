// IB Scout — Service Worker
//
// Solves the iOS-PWA-stuck-on-stale-version problem. The iOS standalone
// WebView ignores standard Cache-Control headers and pins resources for
// days; this SW takes control of fetch with a network-first strategy
// so every request hits the network first and only falls back to cache
// when offline. Result: deploys land in the installed PWA the next time
// the user opens it.
//
// Bump VERSION whenever this SW file changes — that's what triggers
// browsers to register it as an update.

const VERSION = 'v3';
const CACHE_NAME = `ib-scout-${VERSION}`;

// Keep precache minimal — start_url just needs to be reachable so the
// PWA install criteria pass. Everything else is cached on demand by
// the network-first fetch handler below.
const PRECACHE = ['/', '/manifest.json', '/pwa-icon-192.png', '/pwa-icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => { /* precache best-effort; SW still installs */ }),
  );
  // Don't auto-skip — wait for the page to message SKIP_WAITING so we
  // can show the user an update banner first. This prevents a deploy
  // from yanking the rug out mid-action.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('ib-scout-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Web Push ─────────────────────────────────────────────────────────────────
// Server sends a JSON payload with { title, body, project_id } when a Scout
// report finishes. We show a system notification; tapping it opens the
// scout-report page for that project (focusing an existing tab if one is
// already open, otherwise opening a new one).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'IB Scout';
  const body  = data.body  || 'Your Scout report is ready.';
  const projectId = data.project_id || '';
  const url = projectId ? `/scout-report.html?project=${projectId}` : '/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/pwa-icon-192.png',
      badge: '/pwa-icon-192.png',
      tag: projectId || 'ib-scout',
      data: { url, project_id: projectId },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If an IB Scout tab is already open on the right URL, focus it.
      for (const client of clientList) {
        const u = new URL(client.url);
        if (u.pathname === '/scout-report.html' && u.search.includes(`project=${event.notification.data?.project_id}`)) {
          return client.focus();
        }
      }
      // Otherwise open a new window.
      return self.clients.openWindow(targetUrl);
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only intercept same-origin GETs. POSTs and cross-origin requests
  // (Supabase, Anthropic, Auth0, Google Maps, Leaflet CDN, etc.) pass
  // through unmodified so the existing flows aren't affected.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Cache the successful response so we have a fallback when
        // offline. Only cache "basic" responses (same-origin, opaque
        // responses can't be safely cached).
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) =>
          cached || new Response(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Offline — IB Scout</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#0a0a0f;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:32px;text-align:center}h1{font-size:18px;margin-bottom:8px}p{font-size:13px;color:#94a3b8;max-width:320px;line-height:1.5}</style></head><body><h1>📡 Offline</h1><p>IB Scout needs an internet connection to load fresh property data.</p></body></html>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          ),
        ),
      ),
  );
});
