/* ÖG — Rendimiento (archivo NUEVO, no modifica ningún otro JS)
   Depende de: config.js (db, SUPABASE_URL). Cargar justo después de utils.js.
   Hace 4 cosas:
   1) Imágenes: lazy loading + decoding async automático en toda la app.
   2) Subidas: caché de 1 año en el CDN de Supabase para archivos nuevos (nombres únicos).
   3) Miniaturas de publicaciones: al subir una foto se guarda también una versión 400 px
      (archivo "...-t.jpg") y las grillas usan esa versión liviana. Si no existe, usan la original.
   4) Marcadores de carga (shimmer) en las grillas mientras llega la imagen.
   Opcional: si algún día pasás a Supabase Pro, poné OG_PERF.useTransform = true y se usan
   las transformaciones de imagen del CDN en vez de las miniaturas "-t.jpg". */

const OG_PERF = {
 useTransform: false,   // true solo con Supabase Pro (Image Transformations)
 thumbWidth: 400,
 thumbQuality: 0.78,
 gridSelector: '.explore-grid-item img, .ig-grid-item img'
};

(function ogPerformance() {
 const STORAGE_PUBLIC = '/storage/v1/object/public/';
 const STORAGE_RENDER = '/storage/v1/render/image/public/';
 const MISS_KEY = 'og_thumb_miss';

 /* ---------- Miniaturas que no existen (posts viejos): se recuerdan para no volver a pedirlas ---------- */
 let misses = new Set();
 try { misses = new Set(JSON.parse(localStorage.getItem(MISS_KEY) || '[]')); } catch (e) {}
 function rememberMiss(url) {
  misses.add(url);
  try { localStorage.setItem(MISS_KEY, JSON.stringify([...misses].slice(-600))); } catch (e) {}
 }

 function isPostPhoto(url) {
  return typeof url === 'string' && url.indexOf(STORAGE_PUBLIC + 'og-media/') !== -1 && /\/post-\d+\.jpg$/.test(url.split('?')[0]);
 }

 function thumbUrlFor(url, width) {
  if (!isPostPhoto(url)) return url;
  if (OG_PERF.useTransform) {
   return url.replace(STORAGE_PUBLIC, STORAGE_RENDER) + '?width=' + (width || OG_PERF.thumbWidth) + '&quality=75&resize=cover';
  }
  if (misses.has(url)) return url;
  return url.replace(/\.jpg(\?.*)?$/, '-t.jpg$1');
 }
 window.ogThumbUrl = thumbUrlFor;

 /* ---------- 1) y 3) Imágenes: lazy + miniaturas en grillas ---------- */
 function optimizeImg(img) {
  if (!(img instanceof HTMLImageElement) || img.dataset.ogPerf) return;
  img.dataset.ogPerf = '1';
  if (!img.getAttribute('loading')) img.loading = 'lazy';
  if (!img.getAttribute('decoding')) img.decoding = 'async';

  if (img.matches(OG_PERF.gridSelector)) {
   const original = img.getAttribute('src');
   const thumb = thumbUrlFor(original);
   if (thumb && thumb !== original) {
    img.addEventListener('error', function onFail() {
     img.removeEventListener('error', onFail);
     rememberMiss(original);
     img.src = original;
    });
    img.src = thumb;
   }
  }
 }

 function scan(root) {
  if (root.nodeType !== 1) return;
  if (root.tagName === 'IMG') optimizeImg(root);
  root.querySelectorAll && root.querySelectorAll('img').forEach(optimizeImg);
 }

 function startObserver() {
  document.querySelectorAll('img').forEach(optimizeImg);
  new MutationObserver(list => {
   list.forEach(m => m.addedNodes.forEach(scan));
  }).observe(document.documentElement, { childList: true, subtree: true });
 }
 if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver);
 else startObserver();

 /* ---------- 4) Shimmer mientras carga la imagen de una grilla ---------- */
 const style = document.createElement('style');
 style.textContent =
  '@keyframes ogShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}' +
  '.explore-grid-item:not(.explore-grid-item--video):not(.explore-grid-item--text),.ig-grid-item{' +
  'background:linear-gradient(90deg,rgba(128,128,128,.14) 25%,rgba(128,128,128,.26) 50%,rgba(128,128,128,.14) 75%);' +
  'background-size:200% 100%;animation:ogShimmer 1.4s linear infinite}';
 document.head.appendChild(style);

 /* ---------- 2) Subidas: caché larga + miniatura de posts ---------- */
 function makeThumbBlob(blob) {
  return new Promise(resolve => {
   const url = URL.createObjectURL(blob);
   const img = new Image();
   img.onload = () => {
    try {
     const scale = Math.min(1, OG_PERF.thumbWidth / (img.naturalWidth || OG_PERF.thumbWidth));
     const w = Math.max(1, Math.round(img.naturalWidth * scale));
     const h = Math.max(1, Math.round(img.naturalHeight * scale));
     const canvas = document.createElement('canvas');
     canvas.width = w; canvas.height = h;
     canvas.getContext('2d').drawImage(img, 0, 0, w, h);
     canvas.toBlob(b => { URL.revokeObjectURL(url); resolve(b); }, 'image/jpeg', OG_PERF.thumbQuality);
    } catch (e) { URL.revokeObjectURL(url); resolve(null); }
   };
   img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
   img.src = url;
  });
 }

 try {
  const originalFrom = db.storage.from.bind(db.storage);
  db.storage.from = function (bucket) {
   const api = originalFrom(bucket);
   const originalUpload = api.upload.bind(api);
   api.upload = function (path, body, options) {
    const opts = Object.assign({}, options || {});
    // Los archivos tienen nombre único (con fecha): se pueden guardar un año sin riesgo.
    // Si se sobrescribe un archivo (upsert), se mantiene la caché corta.
    if (opts.upsert !== true) opts.cacheControl = '31536000';
    const result = originalUpload(path, body, opts);
    if (bucket === 'og-media' && /\/post-\d+\.jpg$/.test(path) && body instanceof Blob) {
     Promise.resolve(result).then(res => {
      if (res && !res.error) {
       makeThumbBlob(body).then(thumb => {
        if (!thumb) return;
        originalUpload(path.replace(/\.jpg$/, '-t.jpg'), thumb, {
         cacheControl: '31536000', upsert: false, contentType: 'image/jpeg'
        }).catch(() => {});
       });
      }
     }).catch(() => {});
    }
    return result;
   };
   return api;
  };
 } catch (e) { /* si algo falla, la app sigue igual que antes */ }

 /* ---------- Conexión anticipada al CDN de Supabase ---------- */
 try {
  const host = new URL(SUPABASE_URL).origin;
  ['preconnect', 'dns-prefetch'].forEach(rel => {
   const l = document.createElement('link');
   l.rel = rel; l.href = host;
   if (rel === 'preconnect') l.crossOrigin = '';
   document.head.appendChild(l);
  });
 } catch (e) {}
})();
