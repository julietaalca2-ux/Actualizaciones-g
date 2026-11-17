/* Depende de: config.js (db); state.js (currentUser, profilesCache, searchTimer,
   explorePostsCache, explorePage, EXPLORE_PAGE_SIZE, exploreLoading, exploreHasMore);
   utils.js (createAvatarNode, setCachedProfile, prefetchUserProfile, bindSmartPrefetch,
   ogCache, POST_SELECT_FIELDS, PROFILE_MINI_FIELDS)
   En tiempo de ejecución usa funciones de otros módulos: openPostDetail (feed.js),
   openPublicProfile (profile.js)
   Expone: pauseExploreVideos, resumeExploreVideos, loadExploreGrid, loadMoreExploreGrid, handleExploreSearchFocus,
   handleExploreSearchInput, resetExploreSearch, switchSearchTab, executeAdvancedSearch */

let exploreObserverInitialized = false;
let exploreThumbSupported = true;   // pasa a false si la columna thumbnail_url no existe en Supabase
const EXPLORE_LOOR_FIELDS_THUMB = 'id, user_id, video_url, thumbnail_url, views_count, created_at';
const EXPLORE_LOOR_FIELDS_BASE = 'id, user_id, video_url, views_count, created_at';

/* Pide loors con miniatura; si la columna no existe, repite sin ella (nunca deja la grilla vacía) */
async function queryExploreLoors(build) {
 if (exploreThumbSupported) {
  const res = await build(EXPLORE_LOOR_FIELDS_THUMB);
  if (!res.error) return res;
  exploreThumbSupported = false;
 }
 return build(EXPLORE_LOOR_FIELDS_BASE);
}
let exploreLastLoad = 0;      // cuándo se pidió la primera página por última vez
let exploreRenderedSig = '';   // firma de lo que ya está dibujado (evita redibujar lo mismo)
const EXPLORE_REFRESH_MS = 45000;

function exploreSignature(entries) {
 return entries.map(e => (e._type || 'p') + e.id).join(',');
}

/* ---- Videos (Loors) dentro de Explorar: se reproducen solos, sin sonido, estilo Instagram ----
   Un video empieza a reproducirse en cuanto se ve aunque sea un pedacito (arriba o abajo de la pantalla).
   Si hay muchos a la vez, suenan los más cercanos al centro de la pantalla. */
const EXPLORE_LOORS_PAGE_SIZE = 12;
const EXPLORE_MAX_PLAYING = 3;           // pocos videos a la vez: los decodificadores del teléfono son limitados
const EXPLORE_MAX_ATTACHED = 9;          // máximo de videos con archivo cargado en memoria
const exploreAttached = [];              // orden en que se cargaron (para liberar los más viejos)
const exploreVisibleVideos = new Set();  // videos que tienen aunque sea un pedacito en pantalla
let exploreVideoLoadObserver = null;
let exploreVideoViewObserver = null;
let exploreVideosSuspended = false;
let exploreUpdateQueued = false;

let exploreDataSaverCache = { v: false, t: 0 };
function isExploreDataSaverOn() {
 const now = Date.now();
 if (now - exploreDataSaverCache.t < 3000) return exploreDataSaverCache.v;
 let v = false;
 try {
  const raw = localStorage.getItem('og_user_settings_' + (currentUser?.id || 'guest'));
  v = raw ? JSON.parse(raw).dataSaver === true : false;
 } catch (e) {}
 exploreDataSaverCache = { v, t: now };
 return v;
}

function isExploreVisible() {
 return !!document.getElementById('explore')?.classList.contains('active') && !document.hidden;
}

function stopExploreVideo(video) {
 try { video.pause(); } catch (e) {}
}

function detachExploreVideoSource(video) {
 try { video.pause(); } catch (e) {}
 video.removeAttribute('src');
 video.load();
 const i = exploreAttached.indexOf(video);
 if (i >= 0) exploreAttached.splice(i, 1);
 // Cuando vuelva a acercarse a la pantalla se carga de nuevo
 if (video.isConnected && exploreVideoLoadObserver && !video.dataset.hasThumb) exploreVideoLoadObserver.observe(video);
}

function attachExploreVideoSource(video) {
 if (video.dataset.src && !video.getAttribute('src')) {
  video.src = video.dataset.src;
  video.load();
  exploreAttached.push(video);
  // Si hay demasiados cargados, se sueltan los más viejos que no se están viendo
  while (exploreAttached.length > EXPLORE_MAX_ATTACHED) {
   const idx = exploreAttached.findIndex(v => v !== video && !exploreVisibleVideos.has(v));
   if (idx === -1) break;
   detachExploreVideoSource(exploreAttached[idx]);
  }
 }
}

/* Decide qué videos suenan ahora: los visibles más cercanos al centro de la pantalla */
function updateExplorePlayback() {
 const canPlay = !exploreVideosSuspended && !isExploreDataSaverOn() && isExploreVisible();
 const vh = window.innerHeight || document.documentElement.clientHeight;
 const center = vh / 2;
 const candidates = [];

 exploreVisibleVideos.forEach(video => {
  if (!video.isConnected) { exploreVisibleVideos.delete(video); return; }
  const r = video.getBoundingClientRect();
  if (r.bottom <= 0 || r.top >= vh) return;
  candidates.push({ video, dist: Math.abs((r.top + r.bottom) / 2 - center) });
 });
 candidates.sort((x, y) => x.dist - y.dist);

 const toPlay = new Set(canPlay ? candidates.slice(0, EXPLORE_MAX_PLAYING).map(c => c.video) : []);

 exploreVisibleVideos.forEach(video => {
  if (toPlay.has(video)) return;
  stopExploreVideo(video);
  // Con miniatura no hace falta tener el video cargado: se libera y se ve la foto
  if (video.dataset.hasThumb && video.getAttribute('src')) detachExploreVideoSource(video);
 });
 toPlay.forEach(video => {
  attachExploreVideoSource(video);
  if (video.paused) {
   const p = video.play();
   if (p && p.catch) p.catch(() => {});
  }
 });
}

function scheduleExplorePlayback() {
 if (exploreUpdateQueued) return;
 exploreUpdateQueued = true;
 requestAnimationFrame(() => {
  exploreUpdateQueued = false;
  updateExplorePlayback();
 });
}

// Durante el scroll no hace falta recalcular en cada cuadro: cada ~150 ms alcanza
let exploreScrollTimer = null;
function scheduleExplorePlaybackThrottled() {
 if (exploreScrollTimer) return;
 exploreScrollTimer = setTimeout(() => {
  exploreScrollTimer = null;
  scheduleExplorePlayback();
 }, 150);
}

function ensureExploreVideoObservers() {
 if (exploreVideoViewObserver || !('IntersectionObserver' in window)) return;

 // 1) Carga el video un poco antes de que aparezca en pantalla
 exploreVideoLoadObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
   if (entry.isIntersecting) {
    attachExploreVideoSource(entry.target);
    exploreVideoLoadObserver.unobserve(entry.target);
   }
  });
 }, { root: document.querySelector('main'), rootMargin: '250px 0px', threshold: 0 });

 // 2) Controla cuáles se ven en pantalla (con ver 1 píxel ya cuenta)
 exploreVideoViewObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
   const video = entry.target;
   if (entry.isIntersecting) {
    exploreVisibleVideos.add(video);
   } else {
    exploreVisibleVideos.delete(video);
    stopExploreVideo(video);
   }
  });
  scheduleExplorePlayback();
 }, { threshold: [0, 0.01] });

 // Al hacer scroll cambia cuál está más cerca del centro
 document.addEventListener('scroll', () => {
  if (exploreVisibleVideos.size && isExploreVisible()) scheduleExplorePlaybackThrottled();
 }, { capture: true, passive: true });
 window.addEventListener('resize', scheduleExplorePlayback);
}

/* Libera los videos de una grilla que se va a redibujar */
function releaseExploreVideos(root) {
 root.querySelectorAll('video.explore-grid-video').forEach(video => {
  if (exploreVideoViewObserver) exploreVideoViewObserver.unobserve(video);
  if (exploreVideoLoadObserver) exploreVideoLoadObserver.unobserve(video);
  exploreVisibleVideos.delete(video);
  stopExploreVideo(video);
  const ai = exploreAttached.indexOf(video);
  if (ai >= 0) exploreAttached.splice(ai, 1);
  video.removeAttribute('src');
  video.load();
 });
}

function pauseExploreVideos() {
 exploreVideosSuspended = true;
 exploreVisibleVideos.forEach(stopExploreVideo);
}

function resumeExploreVideos() {
 exploreVideosSuspended = false;
 scheduleExplorePlayback();
}

document.addEventListener('visibilitychange', () => {
 if (document.hidden) exploreVisibleVideos.forEach(stopExploreVideo);
 else scheduleExplorePlayback();
});

function formatExploreCount(n) {
 n = Number(n) || 0;
 if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',').replace(',0', '') + ' mill.';
 if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.', ',').replace(',0', '') + ' mil';
 return String(n);
}

const EXPLORE_EYE_SVG = '<svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';

function buildExploreLoorItem(loor, tall, tallRight) {
 const item = document.createElement('div');
 item.className = 'explore-grid-item explore-grid-item--video' + (tall ? ' explore-grid-item--tall' : '') + (tall && tallRight ? ' explore-grid-item--tall-right' : '');
 item.onclick = () => {
  if (typeof openLoorsSection === 'function') openLoorsSection(loor.id);
 };

 const video = document.createElement('video');
 video.className = 'explore-grid-video';
 video.muted = true;
 video.defaultMuted = true;
 video.loop = true;
 video.playsInline = true;
 video.setAttribute('playsinline', '');
 video.setAttribute('muted', '');
 video.disablePictureInPicture = true;
 if (loor.thumbnail_url) {
  // Con miniatura: se ve la foto liviana y el video solo se carga cuando le toca reproducirse
  video.poster = loor.thumbnail_url;
  video.preload = 'none';
  video.dataset.hasThumb = '1';
  video.dataset.src = loor.video_url;
 } else {
  video.preload = 'metadata';
  // #t=0.1 hace que se vea el primer cuadro mientras no se reproduce
  video.dataset.src = loor.video_url + '#t=0.1';
 }
 item.append(video);

 const badge = document.createElement('div');
 badge.className = 'explore-grid-badge';
 badge.innerHTML = `${EXPLORE_EYE_SVG} <span>${formatExploreCount(loor.views_count)}</span>`;
 item.append(badge);

 const reel = document.createElement('div');
 reel.className = 'explore-grid-reel-icon';
 reel.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm4 5v8l7-4-7-4z"/></svg>';
 item.append(reel);

 ensureExploreVideoObservers();
 if (exploreVideoViewObserver) {
  if (!video.dataset.hasThumb) exploreVideoLoadObserver.observe(video);
  exploreVideoViewObserver.observe(video);
 } else {
  // Navegadores sin IntersectionObserver: se carga y se reproduce directo
  video.autoplay = true;
  attachExploreVideoSource(video);
 }
 return item;
}

function buildExplorePostItem(post) {
 const item = document.createElement('div');
 item.className = 'explore-grid-item';
 item.onclick = () => openPostDetail(post);
 if (post.image_url) {
  const img = document.createElement('img');
  img.src = post.image_url;
  img.loading = 'lazy';
  img.decoding = 'async';
  item.append(img);
 } else {
  item.classList.add('explore-grid-item--text');
  item.textContent = (post.content || '').slice(0, 60);
 }
 const badge = document.createElement('div');
 badge.className = 'explore-grid-badge';
 badge.innerHTML = `${EXPLORE_EYE_SVG} <span data-post-views="${post.id}">${post.views || 0}</span>`;
 item.append(badge);
 return item;
}

let exploreLoorCounter = 0;
function buildExploreGridItem(entry) {
 if (entry && entry._type === 'loor') {
  // Cada tercer video se muestra grande (2 filas) y alterna izquierda/derecha, como en Instagram
  const n = exploreLoorCounter++;
  const tall = (n % 3) === 0;
  const tallRight = (Math.floor(n / 3) % 2) === 1;
  return buildExploreLoorItem(entry, tall, tallRight);
 }
 return buildExplorePostItem(entry);
}

/* Junta fotos y videos en un solo listado, del más nuevo al más viejo */
function mergeExploreEntries(posts, loors) {
 const all = [
  ...(posts || []).map(p => ({ ...p, _type: 'post' })),
  ...(loors || []).map(l => ({ ...l, _type: 'loor' }))
 ];
 all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
 return all;
}

async function fetchExplorePage(page) {
 const from = page * EXPLORE_PAGE_SIZE;
 const [postsRes, loorsRes] = await Promise.all([
  db.from('posts')
   .select(POST_SELECT_FIELDS)
   .order('created_at', { ascending: false })
   .range(from, from + EXPLORE_PAGE_SIZE - 1),
  queryExploreLoors(fields => db.from('loors')
   .select(fields)
   .order('created_at', { ascending: false })
   .range(page * EXPLORE_LOORS_PAGE_SIZE, (page + 1) * EXPLORE_LOORS_PAGE_SIZE - 1))
 ]);
 const posts = postsRes.data || [];
 const loors = (loorsRes.data || []).filter(l => l.video_url);
 return {
  entries: mergeExploreEntries(posts, loors),
  hasMore: posts.length >= EXPLORE_PAGE_SIZE || (loorsRes.data || []).length >= EXPLORE_LOORS_PAGE_SIZE
 };
}

function renderExplorePostsToGrid(posts, grid, reset = true) {
 if (!grid) return;
 if (reset) {
  // Al redibujar, se sueltan los videos anteriores
  releaseExploreVideos(grid);
  exploreLoorCounter = 0;
 }
 if (!posts || !posts.length) {
  if (reset) grid.replaceChildren();
  return;
 }
 const fragment = document.createDocumentFragment();
 posts.forEach(post => fragment.append(buildExploreGridItem(post)));
 if (reset) grid.replaceChildren(fragment);
 else grid.append(fragment);
 scheduleExplorePlayback();
}

function ensureExploreScrollObserver() {
 if (exploreObserverInitialized || !('IntersectionObserver' in window)) return;
 const grid = document.getElementById('exploreGrid');
 if (!grid || !grid.parentElement) return;
 exploreObserverInitialized = true;

 const sentinel = document.createElement('div');
 sentinel.id = 'exploreScrollSentinel';
 sentinel.style.height = '1px';
 grid.parentElement.append(sentinel);

 const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
   if (entry.isIntersecting && document.getElementById('explore')?.classList.contains('active') && document.getElementById('exploreDefaultView')?.classList.contains('active')) {
    loadMoreExploreGrid();
   }
  }
 }, { root: document.querySelector('main'), rootMargin: '400px 0px', threshold: 0 });
 observer.observe(sentinel);
}

async function loadExploreGrid() {
 const grid = document.getElementById('exploreGrid');
 if (!grid) return;
 ensureExploreScrollObserver();

 // Volver a Explorar con la grilla ya dibujada y reciente: no se toca nada, solo se reanuda
 if (grid.childElementCount > 0 && (Date.now() - exploreLastLoad) < EXPLORE_REFRESH_MS) {
  scheduleExplorePlayback();
  return;
 }

 // Primera vez: pintar rápido desde caché
 if (grid.childElementCount === 0) {
  if (!explorePostsCache) {
   const cached = ogCache.get('explore_posts', 1000 * 60 * 30);
   if (Array.isArray(cached) && cached.length > 0) explorePostsCache = cached;
  }
  if (Array.isArray(explorePostsCache) && explorePostsCache.length > 0) {
   explorePage = 0;
   exploreHasMore = true;
   renderExplorePostsToGrid(explorePostsCache, grid, true);
   exploreRenderedSig = exploreSignature(explorePostsCache);
  }
 }

 if (exploreLoading) return;
 exploreLoading = true;
 try {
  const { entries, hasMore } = await fetchExplorePage(0);
  exploreLastLoad = Date.now();
  if (entries.length > 0) {
   const sig = exploreSignature(entries);
   // Si no cambió nada, se deja la grilla (y sus videos) tal cual
   if (sig !== exploreRenderedSig || grid.childElementCount === 0) {
    explorePage = 0;
    exploreHasMore = hasMore;
    explorePostsCache = entries;
    exploreRenderedSig = sig;
    renderExplorePostsToGrid(entries, grid, true);
    setTimeout(() => ogCache.set('explore_posts', entries), 0);
   }
  }
 } finally {
  exploreLoading = false;
 }
}

async function loadMoreExploreGrid() {
 if (exploreLoading || !exploreHasMore) return;
 exploreLoading = true;
 explorePage++;

 try {
  const { entries, hasMore } = await fetchExplorePage(explorePage);
  exploreHasMore = hasMore;
  if (entries.length > 0) {
   explorePostsCache = (explorePostsCache || []).concat(entries);
   renderExplorePostsToGrid(entries, document.getElementById('exploreGrid'), false);
  }
 } finally {
  exploreLoading = false;
 }
}

function handleExploreSearchFocus() {
 const val = document.getElementById('search').value.trim();
 if (val.length >= 1) {
  document.getElementById('searchCategoriesBar').classList.add('active');
  document.getElementById('exploreDefaultView').classList.remove('active');
  document.getElementById('exploreSearchResultsView').classList.add('active');
 }
}

function handleExploreSearchInput() {
 clearTimeout(searchTimer);
 const val = document.getElementById('search').value.trim();
 const catBar = document.getElementById('searchCategoriesBar');
 const defaultView = document.getElementById('exploreDefaultView');
 const resultsView = document.getElementById('exploreSearchResultsView');

 if (val.length === 0) {
  resetExploreSearch();
  return;
 }

 catBar.classList.add('active');
 defaultView.classList.remove('active');
 resultsView.classList.add('active');

 searchTimer = setTimeout(() => executeAdvancedSearch(val), 250);
}

function resetExploreSearch() {
 document.getElementById('searchCategoriesBar').classList.remove('active');
 document.getElementById('exploreDefaultView').classList.add('active');
 document.getElementById('exploreSearchResultsView').classList.remove('active');
 const forYouGrid = document.getElementById('searchForYouResults');
 releaseExploreVideos(forYouGrid);
 forYouGrid.replaceChildren();
 document.getElementById('searchProfilesResults').replaceChildren();
}

function switchSearchTab(tabKey, btnElement) {
 document.querySelectorAll('.search-cat-tab').forEach(b => b.classList.remove('active'));
 btnElement.classList.add('active');
 document.querySelectorAll('.search-tab-content').forEach(c => { c.style.display = 'none'; });
 const targetTab = document.getElementById(`searchTab-${tabKey}`);
 if (targetTab) targetTab.style.display = 'block';
}

async function executeAdvancedSearch(queryText) {
 const query = queryText.toLowerCase();

 const [profilesRes, postsRes, loorsRes] = await Promise.all([
  db.from('og_profiles')
   .select(PROFILE_MINI_FIELDS)
   .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
   .limit(15),
  db.from('posts')
   .select(POST_SELECT_FIELDS)
   .ilike('content', `%${query}%`)
   .order('created_at', { ascending: false })
   .limit(18),
  queryExploreLoors(fields => db.from('loors')
   .select(fields)
   .ilike('description', `%${query}%`)
   .order('created_at', { ascending: false })
   .limit(9))
 ]);

 const profilesData = profilesRes.data;
 const profilesContainer = document.getElementById('searchProfilesResults');
 profilesContainer.replaceChildren();

 if (!profilesData || !profilesData.length) {
  profilesContainer.innerHTML = '<div class="activity-empty">No se encontraron perfiles.</div>';
 } else {
  const profileFragment = document.createDocumentFragment();
  profilesData.forEach(profile => {
   if (profile.id === currentUser?.id) return;
   setCachedProfile(profile, false);
   const item = document.createElement('div');
   item.className = 'public-user';
   item.style.padding = '8px 16px';
   item.append(createAvatarNode(profile, false));
   const info = document.createElement('div');
   info.className = 'public-user-info';
   info.innerHTML = `<strong>${profile.display_name || profile.username}</strong><small>@${profile.username}</small>`;
   item.append(info);
   item.onclick = () => openPublicProfile(profile.id);
   bindSmartPrefetch(item, () => prefetchUserProfile(profile.id));
   profileFragment.append(item);
  });
  profilesContainer.replaceChildren(profileFragment);
 }

 const postsData = mergeExploreEntries(postsRes.data, (loorsRes.data || []).filter(l => l.video_url));
 const forYouContainer = document.getElementById('searchForYouResults');
 releaseExploreVideos(forYouContainer);
 forYouContainer.replaceChildren();

 if (!postsData.length) {
  forYouContainer.innerHTML = '<div class="activity-empty" style="grid-column: span 3;">No hay publicaciones relacionadas.</div>';
 } else {
  const postsFragment = document.createDocumentFragment();
  postsData.forEach(entry => {
   // En resultados de búsqueda los videos van en tamaño normal
   postsFragment.append(entry._type === 'loor' ? buildExploreLoorItem(entry, false) : buildExplorePostItem(entry));
  });
  forYouContainer.replaceChildren(postsFragment);
  scheduleExplorePlayback();
 }
}


/* Buscador más limpio, como en Instagram */
(function setExploreSearchPlaceholder() {
 const apply = () => {
  const input = document.getElementById('search');
  if (input) input.setAttribute('placeholder', 'Buscar');
 };
 if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
 else apply();
})();
