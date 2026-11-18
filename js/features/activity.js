/* Depende de: config.js (db); state.js (currentUser, myProfile, profilesCache, cachedActivityEvents,
   cachedFollowingIds, cachedFeedPosts); utils.js (ogCache, setCachedProfile, PROFILE_MINI_FIELDS, POST_SELECT_FIELDS)
   En tiempo de ejecución usa funciones de otros módulos: showAuthOverlay (auth.js),
   openPublicProfile (profile.js), openPostDetail (feed.js), showTab (navigation.js),
   ogFetchPendingRequests / ogOpenFollowRequests / ogRequestFollow / ogCancelFollowRequest (follow-requests.js)
   Expone: loadActivity, renderActivityDOM, ogUpdateRequestsRow, loadUserOwnActivity */

const OG_ACT_BUCKETS = ['Hoy', 'Ayer', 'Últimos 7 días', 'Últimos 30 días', 'Anteriores'];
let ogActFollowing = new Set();   // a quién sigo (para el botón Seguir de cada aviso)
let ogActRequested = new Set();   // a quién ya le pedí seguirlo (cuentas privadas)

/* ---------- Utilidades de formato ---------- */

function ogActTime(date) {
 const diff = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
 if (diff < 60) return 'ahora';
 if (diff < 3600) return Math.floor(diff / 60) + ' min';
 if (diff < 86400) return Math.floor(diff / 3600) + ' h';
 if (diff < 604800) return Math.floor(diff / 86400) + ' d';
 return Math.floor(diff / 604800) + ' sem';
}

function ogActBucket(date) {
 const now = new Date();
 const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
 const t = new Date(date).getTime();
 if (t >= startToday) return 0;
 if (t >= startToday - 86400000) return 1;
 if (t >= startToday - 7 * 86400000) return 2;
 if (t >= startToday - 30 * 86400000) return 3;
 return 4;
}

function ogActAvatar(profile) {
 const av = document.createElement('div');
 av.className = 'act-avatar';
 if (profile?.avatar_url) {
  const img = document.createElement('img');
  img.src = profile.avatar_url; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
  av.append(img);
 } else {
  av.textContent = (profile?.username || '?').charAt(0).toUpperCase();
 }
 return av;
}

function ogActStackedAvatars(profiles) {
 if (profiles.length < 2) return ogActAvatar(profiles[0]);
 const wrap = document.createElement('div');
 wrap.className = 'act-avatar-stack';
 wrap.append(ogActAvatar(profiles[0]), ogActAvatar(profiles[1]));
 return wrap;
}

function ogActName(profile) {
 const s = document.createElement('strong');
 s.textContent = profile?.username || profile?.display_name || 'usuario';
 return s;
}

function ogActTimeNode(date) {
 const t = document.createElement('span');
 t.className = 'act-time';
 t.textContent = ' ' + ogActTime(date);
 return t;
}

async function ogOpenPostFromActivity(postId) {
 try {
  const { data } = await db.from('posts').select(POST_SELECT_FIELDS).eq('id', postId).maybeSingle();
  if (data && typeof openPostDetail === 'function') openPostDetail(data);
 } catch (e) {}
}

/* ---------- Carga ---------- */

async function loadActivity() {
 const container = document.getElementById('activitylist');
 if (!currentUser) { showAuthOverlay(); return; }

 if (!cachedActivityEvents) {
  const cached = ogCache.get('activity_events', 1000 * 60 * 60 * 6);
  if (Array.isArray(cached)) cachedActivityEvents = cached;
 }
 if (Array.isArray(cachedActivityEvents)) {
  renderActivityDOM(cachedActivityEvents, container);
 } else {
  container.innerHTML = '<div id="actRequestsSlot"></div><div class="activity-empty">Cargando…</div>';
  ogUpdateRequestsRow();
 }

 try {
  const safe = p => Promise.resolve(p).catch(() => ({ data: [] }));
  const { data: ownPosts } = await db.from('posts').select('id,image_url,content').eq('user_id', currentUser.id);
  const postMap = {};
  (ownPosts || []).forEach(p => { postMap[p.id] = { thumb: p.image_url || null }; });
  const postIds = Object.keys(postMap);

  const [followsResult, likesResult, commentsResult, myFollowsRes, myReqsRes] = await Promise.all([
   db.from('follows').select('follower_id,created_at').eq('following_id', currentUser.id).order('created_at', { ascending: false }).limit(50),
   postIds.length ? db.from('likes').select('user_id,post_id,created_at').in('post_id', postIds).order('created_at', { ascending: false }).limit(120) : Promise.resolve({ data: [] }),
   postIds.length ? db.from('comments').select('id,user_id,post_id,content,created_at').in('post_id', postIds).order('created_at', { ascending: false }).limit(60) : Promise.resolve({ data: [] }),
   safe(db.from('follows').select('following_id').eq('follower_id', currentUser.id)),
   safe(db.from('follow_requests').select('target_id').eq('requester_id', currentUser.id).eq('status', 'pending'))
  ]);

  ogActFollowing = new Set((myFollowsRes.data || []).map(f => f.following_id));
  ogActRequested = new Set((myReqsRes.data || []).map(r => r.target_id));

  const events = [];
  (followsResult.data || []).forEach(f => { if (f.follower_id !== currentUser.id) events.push({ type: 'follow', user_id: f.follower_id, created_at: f.created_at }); });
  (likesResult.data || []).forEach(l => { if (l.user_id !== currentUser.id) events.push({ type: 'like', user_id: l.user_id, post_id: l.post_id, thumb: postMap[l.post_id]?.thumb || null, created_at: l.created_at }); });
  (commentsResult.data || []).forEach(c => { if (c.user_id !== currentUser.id) events.push({ type: 'comment', user_id: c.user_id, post_id: c.post_id, thumb: postMap[c.post_id]?.thumb || null, content: c.content, created_at: c.created_at }); });

  events.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  cachedActivityEvents = events;
  ogCache.set('activity_events', events);
  await renderActivityDOM(events, container);
 } catch (e) {
  if (!cachedActivityEvents) {
   container.textContent = 'No se pudo cargar la actividad.';
  }
 }
}

/* ---------- Fila "Solicitudes de seguidores" ---------- */

async function ogUpdateRequestsRow() {
 const paint = () => {
  const slot = document.getElementById('actRequestsSlot');
  if (!slot) return;
  const reqs = typeof ogPendingRequests !== 'undefined' ? ogPendingRequests : [];
  if (!reqs.length) { slot.replaceChildren(); return; }

  const profiles = reqs.map(r => profilesCache[r.requester_id]).filter(Boolean);
  if (!profiles.length) { slot.replaceChildren(); return; }

  const row = document.createElement('div');
  row.className = 'act-requests-row';
  row.append(ogActStackedAvatars(profiles.slice(0, 2)));

  const text = document.createElement('div');
  text.className = 'act-requests-text';
  const title = document.createElement('div');
  title.className = 'act-requests-title';
  title.textContent = 'Solicitudes de seguidores';
  const sub = document.createElement('div');
  sub.className = 'act-requests-sub';
  const rest = reqs.length - 1;
  sub.textContent = (profiles[0].username || 'usuario') + (rest > 0 ? ' + ' + rest + ' más' : '');
  text.append(title, sub);

  const dot = document.createElement('span');
  dot.className = 'act-requests-dot';
  const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chev.setAttribute('viewBox', '0 0 24 24'); chev.setAttribute('fill', 'none');
  chev.setAttribute('stroke', 'currentColor'); chev.setAttribute('stroke-width', '2');
  chev.setAttribute('stroke-linecap', 'round'); chev.setAttribute('stroke-linejoin', 'round');
  chev.setAttribute('class', 'act-chevron');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  path.setAttribute('points', '9 18 15 12 9 6');
  chev.append(path);

  row.append(text, dot, chev);
  row.onclick = () => ogOpenFollowRequests();
  slot.replaceChildren(row);
 };

 paint();
 if (typeof ogFetchPendingRequests === 'function') {
  await ogFetchPendingRequests();
  paint();
 }
}

/* ---------- Pintado ---------- */

function ogActFollowButton(userId) {
 const btn = document.createElement('button');
 btn.type = 'button';
 btn.className = 'act-follow-btn';
 const paint = () => {
  const following = ogActFollowing.has(userId);
  const requested = ogActRequested.has(userId);
  btn.textContent = following ? 'Siguiendo' : (requested ? 'Solicitado' : 'Seguir');
  btn.classList.toggle('is-following', following || requested);
 };
 paint();

 btn.onclick = async e => {
  e.stopPropagation();
  btn.disabled = true;
  try {
   if (ogActFollowing.has(userId) || ogActRequested.has(userId)) {
    if (ogActFollowing.has(userId)) {
     await db.from('follows').delete().eq('follower_id', currentUser.id).eq('following_id', userId);
    }
    await ogCancelFollowRequest(userId);
    ogActFollowing.delete(userId); ogActRequested.delete(userId);
   } else {
    const res = await ogRequestFollow(userId);
    if (res === 'following') ogActFollowing.add(userId);
    else if (res === 'requested') ogActRequested.add(userId);
   }
   cachedFollowingIds = null; ogCache.remove('following_ids');
   cachedFeedPosts = null; ogCache.remove('feed_posts');
  } finally {
   btn.disabled = false;
   paint();
  }
 };
 return btn;
}

function ogActThumb(thumb) {
 if (thumb) {
  const img = document.createElement('img');
  img.className = 'act-thumb';
  img.src = thumb; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
  img.onerror = () => { img.replaceWith(ogActThumb(null)); };
  return img;
 }
 const ph = document.createElement('div');
 ph.className = 'act-thumb-text';
 ph.textContent = '✎';
 return ph;
}

// Junta los "me gusta" de una misma publicación dentro del mismo tramo de tiempo
function ogActGroupEvents(events) {
 const items = [];
 const likeGroups = new Map();
 events.forEach(ev => {
  if (ev.type !== 'like') { items.push({ ...ev, users: [ev.user_id] }); return; }
  const key = ev.post_id + '|' + ogActBucket(ev.created_at);
  let g = likeGroups.get(key);
  if (!g) {
   g = { type: 'like', post_id: ev.post_id, thumb: ev.thumb, created_at: ev.created_at, users: [] };
   likeGroups.set(key, g);
   items.push(g);
  }
  if (!g.users.includes(ev.user_id)) g.users.push(ev.user_id);
 });
 items.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
 return items;
}

function ogActBuildItem(item) {
 const profiles = item.users.map(id => profilesCache[id]).filter(Boolean);
 if (!profiles.length) return null;

 const row = document.createElement('div');
 row.className = 'act-item';

 const text = document.createElement('div');
 text.className = 'act-text';
 let right = null;

 if (item.type === 'follow') {
  const p = profiles[0];
  row.append(ogActAvatar(p));
  text.append(ogActName(p), document.createTextNode(' comenzó a seguirte.'));
  right = ogActFollowButton(p.id);
  row.onclick = () => openPublicProfile(p.id);
 } else if (item.type === 'comment') {
  const p = profiles[0];
  row.append(ogActAvatar(p));
  const q = document.createElement('span');
  q.className = 'act-quote';
  const c = String(item.content || '');
  q.textContent = c.length > 90 ? c.slice(0, 90) + '…' : c;
  text.append(ogActName(p), document.createTextNode(' comentó: '), q);
  right = ogActThumb(item.thumb);
  row.onclick = () => ogOpenPostFromActivity(item.post_id);
 } else {
  row.append(ogActStackedAvatars(profiles));
  const n = item.users.length;
  const names = profiles.map(ogActName);
  if (n === 1) {
   text.append(names[0], document.createTextNode(' le dio me gusta a tu publicación.'));
  } else if (n === 2) {
   text.append(document.createTextNode('A '), names[0], document.createTextNode(' y '), names[1], document.createTextNode(' les gustó tu publicación.'));
  } else {
   const more = n - 2;
   text.append(document.createTextNode('A '), names[0], document.createTextNode(', '), names[1],
    document.createTextNode(' y ' + more + (more === 1 ? ' persona más' : ' personas más') + ' les gustó tu publicación.'));
  }
  right = ogActThumb(item.thumb);
  row.onclick = () => ogOpenPostFromActivity(item.post_id);
 }

 text.append(ogActTimeNode(item.created_at));
 row.append(text);
 if (right) row.append(right);
 return row;
}

async function renderActivityDOM(events, container) {
 const missing = [...new Set((events || []).map(e => e.user_id).filter(Boolean))].filter(id => !profilesCache[id]);
 if (missing.length > 0) {
  const { data: newProfiles } = await db.from('og_profiles').select(PROFILE_MINI_FIELDS).in('id', missing);
  (newProfiles || []).forEach(p => setCachedProfile(p, false));
 }

 const fragment = document.createDocumentFragment();
 const slot = document.createElement('div');
 slot.id = 'actRequestsSlot';
 fragment.append(slot);

 const items = ogActGroupEvents(events || []);
 let lastBucket = -1;
 let rendered = 0;
 items.forEach(item => {
  const node = ogActBuildItem(item);
  if (!node) return;
  const bucket = ogActBucket(item.created_at);
  if (bucket !== lastBucket) {
   const h = document.createElement('div');
   h.className = 'act-section-title';
   h.textContent = OG_ACT_BUCKETS[bucket];
   fragment.append(h);
   lastBucket = bucket;
  }
  fragment.append(node);
  rendered++;
 });

 if (!rendered) {
  const empty = document.createElement('div');
  empty.className = 'act-empty';
  empty.innerHTML = '<strong>Todavía no tenés actividad</strong>Cuando alguien te siga, le guste o comente tus publicaciones, lo vas a ver acá.';
  fragment.append(empty);
 }

 container.replaceChildren(fragment);
 ogUpdateRequestsRow();
}

async function loadUserOwnActivity() {
 const container = document.getElementById('userOwnActivityContainer');
 if (!currentUser) return;
 container.innerHTML = '<div class="activity-empty">Cargando tu historial...</div>';

 try {
  const [myLikes, myComments, myFollows] = await Promise.all([
   db.from('likes').select('post_id, created_at').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(25),
   db.from('comments').select('post_id, content, created_at').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(25),
   db.from('follows').select('following_id, created_at').eq('follower_id', currentUser.id).order('created_at', { ascending: false }).limit(25)
  ]);

  const events = [];
  (myLikes.data || []).forEach(l => events.push({ type: 'liked_post', post_id: l.post_id, created_at: l.created_at }));
  (myComments.data || []).forEach(c => events.push({ type: 'commented_post', post_id: c.post_id, content: c.content, created_at: c.created_at }));
  (myFollows.data || []).forEach(f => events.push({ type: 'followed_user', user_id: f.following_id, created_at: f.created_at }));

  events.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  if (!events.length) {
   container.innerHTML = '<div class="activity-empty">Aún no realizaste interacciones en ÖG.</div>';
   return;
  }

  const missingUserIds = [...new Set(events.map(e => e.user_id).filter(Boolean))].filter(id => !profilesCache[id]);
  if (missingUserIds.length > 0) {
   const { data: profs } = await db.from('og_profiles').select(PROFILE_MINI_FIELDS).in('id', missingUserIds);
   (profs || []).forEach(p => setCachedProfile(p, false));
  }

  const fragment = document.createDocumentFragment();
  events.forEach(ev => {
   const row = document.createElement('div');
   row.className = 'activity-item';

   const info = document.createElement('div');
   info.className = 'activity-info';

   const text = document.createElement('div');
   const date = document.createElement('div');
   date.className = 'activity-date';
   date.textContent = formatDate(ev.created_at);

   if (ev.type === 'liked_post') {
    text.innerHTML = '❤ Le diste <strong>Me gusta</strong> a una publicación.';
   } else if (ev.type === 'commented_post') {
    const span = document.createElement('span');
    span.style.color = 'var(--text-secondary)';
    span.textContent = `“${ev.content}”`;
    text.textContent = '💬 Comentaste: ';
    text.append(span);
   } else if (ev.type === 'followed_user') {
    const p = profilesCache[ev.user_id];
    text.innerHTML = `👤 Empezaste a seguir a <strong>@${p?.username || 'usuario'}</strong>.`;
   }

   info.append(text, date);
   row.append(info);
   fragment.append(row);
  });

  container.replaceChildren(fragment);
 } catch (e) {
  container.innerHTML = '<div class="activity-empty">No se pudo cargar el historial.</div>';
 }
}
