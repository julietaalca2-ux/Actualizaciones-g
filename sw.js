/* ÖG — Service Worker (og-mobile-dev) */

const VERSION = '1.6.7';
const CACHE_PREFIX = 'og-mobile-dev-';
const CACHE_NAME = CACHE_PREFIX + VERSION;

/* Caché de imágenes del CDN de Supabase: aparte, para que sobreviva a las actualizaciones de la app */
const MEDIA_CACHE = 'og-media-images-v1';
const MEDIA_MAX_ENTRIES = 150;
const STORAGE_PATH = '/storage/v1/';

const SCOPE = self.registration.scope;
const toURL = (path) => new URL(path, SCOPE).href;

const CDN_HOST = 'cdn.jsdelivr.net';
const CDN_SUPABASE = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

const APP_SHELL = [
  './',
  'index.html',
  'manifest.json',
  'css/variables.css',
  'css/components.css',
  'css/auth.css',
  'css/header.css',
  'css/layout.css',
  'css/navigation.css',
  'css/stories.css',
  'css/camera.css',
  'css/story-viewer.css',
  'css/feed.css',
  'css/explore.css',
  'css/chat.css',
  'css/calls.css',
  'css/profile.css',
  'css/settings.css',
  'css/loors.css',
  'css/loors-share.css',
  'css/notes.css',
  'css/notifications.css',
  'css/activity.css',
  'css/verification.css',
  'css/style.css',
  'css/animations.css',
  'js/config.js',
  'js/state.js',
  'js/utils.js',
  'js/core/performance.js',
  'js/app.js',
  'js/core/pwa.js',
  'js/core/navigation.js',
  'js/core/realtime.js',
  'js/core/sounds.js',
  'js/core/last-seen.js',
  'js/core/stability.js',
  'js/features/activity.js',
  'js/features/follow-requests.js',
  'js/features/auth.js',
  'js/features/chat.js',
  'js/features/chat-media.js',
  'js/features/calls.js',
  'js/features/explore.js',
  'js/features/feed.js',
  'js/features/highlights.js',
  'js/features/profile.js',
  'js/features/settings.js',
  'js/features/stories.js',
  'js/features/loors-engine.js',
  'js/features/loors.js',
  'js/features/loors-share.js',
  'js/features/notes.js',
  'js/features/notifications.js',
  'js/features/audio-library.js',
  'js/features/verified.badge.js',
  'js/features/verification.js',
  'js/features/verification-admin.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
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
  })());
});

/* ---------- Activación y limpieza ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME && k !== MEDIA_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ---------- Mensaje desde pwa.js para activar la versión nueva ---------- */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
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
    } else if (/\.(js|css|json)$/i.test(url.pathname)) {
      // Código de la app: red primero, así nunca queda un CSS/JS viejo mezclado con un HTML nuevo
      event.respondWith(networkFirst(req));
    } else {
      event.respondWith(staleWhileRevalidate(event, req));
    }
    return;
  }

  // Librería de Supabase desde el CDN
  if (url.hostname === CDN_HOST) {
    event.respondWith(staleWhileRevalidate(event, req));
  }

  // Imágenes del almacenamiento de Supabase (fotos, miniaturas, avatares): primero la caché
  if (url.pathname.includes(STORAGE_PATH) && req.destination === 'image') {
    event.respondWith(cacheFirstImage(event, req));
    return;
  }
  // Todo lo demás (API de Supabase, videos, audios) va directo a la red. Los videos NO se interceptan a propósito:
  // el navegador necesita hablar con el servidor mediante HTTP Range (respuestas 206) y su propia caché de medios.
});

/* Imágenes: si ya se vieron, salen al instante de la caché (los nombres son únicos, no cambian).
   Se guarda como máximo MEDIA_MAX_ENTRIES; al pasarse se borran las más viejas. */
async function cacheFirstImage(event, req) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(req.url);
  if (cached) return cached;
  try {
    // Pedido con CORS para poder guardar la respuesta sin inflar el espacio (las "opacas" ocupan de más)
    let res;
    try {
      res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
    } catch (e) {
      res = await fetch(req);
    }
    if (res && res.ok && res.type !== 'opaque') {
      event.waitUntil((async () => {
        await cache.put(req.url, res.clone());
        const keys = await cache.keys();
        if (keys.length > MEDIA_MAX_ENTRIES) {
          await Promise.all(keys.slice(0, keys.length - MEDIA_MAX_ENTRIES).map((k) => cache.delete(k)));
        }
      })());
    }
    return res;
  } catch (e) {
    return new Response('', { status: 503, statusText: 'Sin conexión' });
  }
}

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

/* JS / CSS / JSON propios: se pide a la red (revalidando contra el servidor) y, si no hay conexión, se usa la copia guardada */
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

/* Assets estáticos (JS, CSS, íconos, CDN): respuesta instantánea desde caché y actualización en segundo plano */
async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req) || await cache.match(req, { ignoreSearch: true });

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

/* ---------- Notificaciones push (llegan con la app cerrada) ---------- */
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) {
    payload = { title: 'ÖG', body: event.data ? event.data.text() : '' };
  }

  event.waitUntil((async () => {
    // Si la app está abierta y a la vista, ella misma muestra el aviso de arriba
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.some((c) => c.visibilityState === 'visible' && c.focused)) return;

    const type = payload.data && payload.data.type;
    await self.registration.showNotification(payload.title || 'ÖG', {
      body: payload.body || '',
      icon: payload.icon || toURL('icons/icon-192.png'),
      badge: payload.badge || toURL('icons/icon-192.png'),
      tag: payload.tag || undefined,
      renotify: false,
      requireInteraction: type === 'call',
      data: payload.data || {},
      timestamp: Date.now()
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients.find((c) => c.url.startsWith(SCOPE)) || clients[0];
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: 'OG_NOTIF_CLICK', data });
      return;
    }
    const url = new URL('./', SCOPE);
    url.searchParams.set('ognotif', encodeURIComponent(JSON.stringify(data)));
    await self.clients.openWindow(url.href);
  })());
});

/* El navegador renovó la suscripción: la app la vuelve a registrar al abrirse */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach((c) => c.postMessage({ type: 'OG_PUSH_RESUBSCRIBE' }));
  })());
});
