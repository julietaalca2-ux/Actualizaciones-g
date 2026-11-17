/* Depende de: config.js (db); state.js (currentUser, profilesCache, searchTimer,
   explorePostsCache, explorePage, EXPLORE_PAGE_SIZE, exploreLoading, exploreHasMore);
   utils.js (createAvatarNode, setCachedProfile, prefetchUserProfile, bindSmartPrefetch,
   ogCache, POST_SELECT_FIELDS, PROFILE_MINI_FIELDS)
   En tiempo de ejecución usa funciones de otros módulos: openPostDetail (feed.js),
   openPublicProfile (profile.js)
   Expone: pauseExploreVideos, resumeExploreVideos, loadExploreGrid, loadMoreExploreGrid, handleExploreSearchFocus,
   handleExploreSearchInput, resetExploreSearch, switchSearchTab, executeAdvancedSearch */

let exploreObserverInitialized = false;

/* ---- Videos (Loors) dentro de Explorar: se reproducen solos, sin sonido, estilo Instagram ---- */
const EXPLORE_LOORS_PAGE_SIZE = 12;
const EXPLORE_MAX_PLAYING = 6;      // máximo de videos sonando a la vez (cuida batería y datos)
const EXPLORE_PLAY_RATIO = 0.12;    // con ver ~12 % del recuadro ya empieza a reproducirse
const explorePlayingVideos = [];
let exploreVideoLoadObserver = null;
let exploreVideoPlayObserver = null;
let exploreVideosSuspended = false;

function isExploreDataSaverOn() {
 try {
  const raw = localStorage.getItem('og_user_settings_' + (currentUser?.id || 'guest'));
  return raw ? JSON.parse(raw).dataSaver === true : false;
 } catch (e) { return false; }
}

function isExploreVisible() {
 return !!document.getElementById('explore')?.classList.contains('active') && !document.hidden;
}

function stopExploreVideo(video) {
 video.pause();
 const idx = explorePlayingVideos.indexOf(video);
 if (idx !== -1) explorePlayingVideos.splice(idx, 1);
}

function playExploreVideo(video) {
 if (exploreVideosSuspended || isExploreDataSaverOn() || !isExploreVisible()) return;
 if (!video.src) attachExploreVideoSource(video);
 const idx = explorePlayingVideos.indexOf(video);
 if (idx !== -1) explorePlayingVideos.splice(idx, 1);
 explorePlayingVideos.push(video);
 // Si hay demasiados, se detiene el que lleva más tiempo reproduciéndose
 while (explorePlayingVideos.length > EXPLORE_MAX_PLAYING) {
  explorePlayingVideos.shift().pause();
 }
 const p = video.play();
 if (p && p.catch) p.catch(() => {});
}

function attachExploreVideoSource(video) {
 if (video.dataset.src && !video.src) {
  video.src = video.dataset.src;
  video.load();
 }
}

function ensureExploreVideoObservers() {
 if (exploreVideoPlayObserver || !('IntersectionObserver' in window)) return;

 // 1) Carga el video un poco antes de que aparezca en pantalla
 exploreVideoLoadObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
   if (entry.isIntersecting) {
    attachExploreVideoSource(entry.target);
    exploreVideoLoadObserver.unobserve(entry.target);
   }
  });
 }, { rootMargin: '300px 0px', threshold: 0 });

 // 2) Reproduce al ver solo una parte del recuadro y pausa cuando sale de pantalla
 exploreVideoPlayObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
   const video = entry.target;
   if (entry.isIntersecting && entry.intersectionRatio >= EXPLORE_PLAY_RATIO) playExploreVideo(video);
   else stopExploreVideo(video);
  });
 }, { threshold: [0, EXPLORE_PLAY_RATIO, 0.5, 1] });
}

function pauseExploreVideos() {
 exploreVideosSuspended = true;
 [...explorePlayingVideos].forEach(stopExploreVideo);
}

function resumeExploreVideos() {
 exploreVideosSuspended = false;
 // Volver a evaluar qué videos están visibles
 if (!exploreVideoPlayObserver) return;
 document.querySelectorAll('#explore video.explore-grid-video').forEach(v => {
  exploreVideoPlayObserver.unobserve(v);
  exploreVideoPlayObserver.observe(v);
 });
}

document.addEventListener('visibilitychange', () => {
 if (document.hidden) [...explorePlayingVideos].forEach(stopExploreVideo);
 else if (!exploreVideosSuspended) resumeExploreVideos();
});

function formatExploreCount(n) {
 n = Number(n) || 0;
 if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',').replace(',0', '') + ' mill.';
 if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.', ',').replace(',0', '') + ' mil';
 return String(n);
}

const EXPLORE_EYE_SVG = '<svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';

function buildExploreLoorItem(loor, tall) {
 const item = document.createElement('div');
 item.className = 'explore-grid-item explore-grid-item--video' + (tall ? ' explore-grid-item--tall' : '');
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
 video.preload = 'metadata';
 // #t=0.1 hace que se vea el primer cuadro mientras no se reproduce
 video.dataset.src = loor.video_url + '#t=0.1';
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
 if (exploreVideoLoadObserver) {
  exploreVideoLoadObserver.observe(video);
  exploreVideoPlayObserver.observe(video);
 } else {
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
  item.textContent = (post.content || '').slice(0, 45);
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
  // Cada tercer video se muestra grande (2 filas), como en Instagram
  const tall = (exploreLoorCounter++ % 3) === 0;
  return buildExploreLoorItem(entry, tall);
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
  db.from('loors')
   .select('id, user_id, video_url, views_count, created_at')
   .order('created_at', { ascending: false })
   .range(page * EXPLORE_LOORS_PAGE_SIZE, (page + 1) * EXPLORE_LOORS_PAGE_SIZE - 1)
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
  [...explorePlayingVideos].forEach(stopExploreVideo);
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
 }, { root: null, rootMargin: '400px 0px', threshold: 0 });
 observer.observe(sentinel);
}

async function loadExploreGrid() {
 const grid = document.getElementById('exploreGrid');
 if (!grid) return;
 ensureExploreScrollObserver();

 explorePage = 0;
 exploreHasMore = true;

 if (!explorePostsCache) {
  const cached = ogCache.get('explore_posts', 1000 * 60 * 30);
  if (Array.isArray(cached) && cached.length > 0) explorePostsCache = cached;
 }
 if (Array.isArray(explorePostsCache) && explorePostsCache.length > 0) {
  renderExplorePostsToGrid(explorePostsCache, grid, true);
 }

 if (exploreLoading) return;
 exploreLoading = true;
 try {
  const { entries, hasMore } = await fetchExplorePage(0);
  exploreHasMore = hasMore;
  if (entries.length > 0) {
   explorePostsCache = entries;
   ogCache.set('explore_posts', entries);
   renderExplorePostsToGrid(entries, grid, true);
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
 document.getElementById('searchForYouResults').replaceChildren();
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
  db.from('loors')
   .select('id, user_id, video_url, views_count, created_at')
   .ilike('description', `%${query}%`)
   .order('created_at', { ascending: false })
   .limit(9)
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
 }
}
