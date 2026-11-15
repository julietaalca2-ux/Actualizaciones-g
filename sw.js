/* ÖG — Service Worker (og-mobile-dev) */

const VERSION = '1.0.0';
const CACHE_PREFIX = 'og-mobile-dev-';
const CACHE_NAME = CACHE_PREFIX + VERSION;

const SCOPE = self.registration.scope;
const toURL = (path) => new URL(path, SCOPE).href;

const CDN_HOST = 'cdn.jsdelivr.net';
const CDN_SUPABASE = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

const APP_SHELL = [
  './',
  'index.html',
  'manifest.json',
  'css/style.css',
  'js/config.js',
  'js/state.js',
  'js/utils.js',
  'js/app.js',
  'js/core/pwa.js',
  'js/core/navigation.js',
  'js/core/realtime.js',
  'js/features/activity.js',
  'js/features/auth.js',
  'js/features/chat.js',
  'js/features/explore.js',
  'js/features/feed.js',
  'js/features/highlights.js',
  'js/features/profile.js',
  'js/features/settings.js',
  'js/features/stories.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
].map(toURL);

/* ---------- Instalación ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Un archivo que falle no cancela la instalación de los demás.
    await Promise.allSettled(
      APP_SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })))
    );

    // Librería de Supabase (para poder abrir la app sin conexión).
    try {
      const res = await fetch(CDN_SUPABASE);
      if (res.ok) await cache.put(CDN_SUPABASE, res);
    } catch (e) { /* sin conexión durante la instalación */ }

    await self.skipWaiting();
  })());
});

/* ---------- Activación y limpieza ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ---------- Peticiones ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Archivos propios de la app
  if (url.origin === self.location.origin) {
    if (!url.href.startsWith(SCOPE)) return;
    if (req.mode === 'navigate') {
      event.respondWith(handleNavigation(req, url));
    } else {
      event.respondWith(networkFirst(req));
    }
    return;
  }

  // Librería de Supabase desde el CDN
  if (url.hostname === CDN_HOST) {
    event.respondWith(staleWhileRevalidate(event, req));
  }
  // Todo lo demás (API de Supabase, imágenes, etc.) va directo a la red.
});

/* Navegación: red primero; sin conexión, se muestra index.html guardado */
async function handleNavigation(req, url) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    const isRoot = url.href === SCOPE || url.pathname.endsWith('/index.html');
    if (res.ok && isRoot) cache.put(toURL('index.html'), res.clone());
    return res;
  } catch (e) {
    const cached = (await cache.match(toURL('index.html'))) || (await cache.match(SCOPE));
    return cached || new Response('Sin conexión', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

/* JS, CSS, íconos: red primero (evita versiones viejas), caché como respaldo */
async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true }));
    return cached || new Response('', { status: 503, statusText: 'Sin conexión' });
  }
}

/* CDN: usa lo guardado y lo actualiza en segundo plano */
async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);

  const network = fetch(req)
    .then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) || new Response('', { status: 503, statusText: 'Sin conexión' });
}

