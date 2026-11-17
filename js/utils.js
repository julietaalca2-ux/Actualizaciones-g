/* Depende de: config.js (db); state.js (currentUser, onlineUsersMap, myProfile, profilesCache,
   prefetchedProfileIds, prefetchedConversationIds, prefetchedMessagesByConv);
   openPostDetail (feed.js) en tiempo de ejecución
   Expone: status, formatDate, timeAgo, setPreviewBlobUrl, revokePreviewBlobUrl,
   setAvatarContent, createAvatarNode, updateNavAvatarUI, renderPostsGrid,
   ogCache, sanitizeProfileForCache, setCachedProfile, compressImageBlob,
   prefetchUserProfile, prefetchConversationMessages, bindSmartPrefetch */

const PROFILE_SELECT_FIELDS = 'id, username, display_name, bio, avatar_url, pronouns, website, gender';
const PROFILE_MINI_FIELDS = 'id, username, display_name, avatar_url';
const POST_SELECT_FIELDS = 'id, user_id, content, image_url, views, created_at';
const MAX_PROFILES_IN_CACHE = 250;

function sanitizeProfileForCache(profile) {
 if (!profile || !profile.id) return null;
 return {
  id: profile.id,
  username: profile.username || '',
  display_name: profile.display_name || '',
  bio: profile.bio || '',
  avatar_url: profile.avatar_url || null,
  pronouns: profile.pronouns || '',
  website: profile.website || '',
  gender: profile.gender || ''
 };
}

const ogCache = {
 prefixFor(uid) {
  return uid ? `og_swr_${uid}_` : null;
 },
 getForUser(uid, key, maxAgeMs = 1000 * 60 * 60 * 12) {
  const prefix = this.prefixFor(uid);
  if (!prefix) return null;
  try {
   const raw = localStorage.getItem(prefix + key);
   if (!raw) return null;
   const parsed = JSON.parse(raw);
   if (!parsed || typeof parsed.ts !== 'number') return null;
   if (maxAgeMs > 0 && (Date.now() - parsed.ts) > maxAgeMs) {
    localStorage.removeItem(prefix + key);
    return null;
   }
   return parsed.data;
  } catch (e) {
   return null;
  }
 },
 setForUser(uid, key, data) {
  const prefix = this.prefixFor(uid);
  if (!prefix) return;
  const payload = JSON.stringify({ ts: Date.now(), data });
  try {
   localStorage.setItem(prefix + key, payload);
  } catch (e) {
   this.evictOldest();
   try {
    localStorage.setItem(prefix + key, payload);
   } catch (err) {}
  }
 },
 get(key, maxAgeMs) {
  return this.getForUser(currentUser?.id, key, maxAgeMs);
 },
 set(key, data) {
  this.setForUser(currentUser?.id, key, data);
 },
 remove(key) {
  const prefix = this.prefixFor(currentUser?.id);
  if (!prefix) return;
  try { localStorage.removeItem(prefix + key); } catch (e) {}
 },
 clearForUser(uid) {
  const prefix = this.prefixFor(uid);
  if (!prefix) return;
  try {
   const toRemove = [];
   for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) toRemove.push(k);
   }
   toRemove.forEach(k => localStorage.removeItem(k));
  } catch (e) {}
 },
 clearAll() {
  try {
   const toRemove = [];
   for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('og_swr_')) toRemove.push(k);
   }
   toRemove.forEach(k => localStorage.removeItem(k));
  } catch (e) {}
 },
 evictOldest() {
  try {
   const entries = [];
   for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('og_swr_')) continue;
    let ts = 0;
    try { ts = JSON.parse(localStorage.getItem(k))?.ts || 0; } catch (e) {}
    entries.push({ k, ts });
   }
   entries.sort((a, b) => a.ts - b.ts);
   entries.slice(0, Math.max(1, Math.ceil(entries.length / 2))).forEach(item => {
    localStorage.removeItem(item.k);
   });
  } catch (e) {}
 }
};

function setCachedProfile(profile, persist = false) {
 const clean = sanitizeProfileForCache(profile);
 if (!clean) return null;
 const existing = profilesCache[clean.id] || {};
 const merged = {
  ...existing,
  ...clean,
  bio: clean.bio || existing.bio || '',
  pronouns: clean.pronouns || existing.pronouns || '',
  website: clean.website || existing.website || '',
  gender: clean.gender || existing.gender || ''
 };
 const keys = Object.keys(profilesCache);
 if (!profilesCache[merged.id] && keys.length >= MAX_PROFILES_IN_CACHE) {
  delete profilesCache[keys[0]];
 }
 profilesCache[merged.id] = merged;
 if (persist && currentUser?.id) {
  ogCache.set('profiles_map', profilesCache);
 }
 return merged;
}

function status(id, message) {
 const el = document.getElementById(id);
 if (el) el.textContent = message;
}

function formatDate(date) {
 return new Date(date).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
}

function timeAgo(dateString) {
 const diff = Math.floor((new Date() - new Date(dateString)) / 1000);
 if (diff < 60) return 'Ahora';
 if (diff < 3600) return Math.floor(diff / 60) + ' min';
 if (diff < 86400) return Math.floor(diff / 3600) + ' h';
 return Math.floor(diff / 86400) + ' d';
}

function setPreviewBlobUrl(imgElement, blob) {
 if (!imgElement) return;
 if (imgElement.dataset.blobUrl) {
  URL.revokeObjectURL(imgElement.dataset.blobUrl);
 }
 const url = URL.createObjectURL(blob);
 imgElement.dataset.blobUrl = url;
 imgElement.src = url;
}

function revokePreviewBlobUrl(imgElement) {
 if (!imgElement) return;
 if (imgElement.dataset.blobUrl) {
  URL.revokeObjectURL(imgElement.dataset.blobUrl);
  delete imgElement.dataset.blobUrl;
 }
 imgElement.removeAttribute('src');
}

function compressImageBlob(file, maxDimension = 1080, quality = 0.82) {
 return new Promise(resolve => {
  if (!file || !(file instanceof Blob) || !file.type.startsWith('image/')) {
   resolve(file);
   return;
  }
  const objectUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
   try {
    let width = img.naturalWidth || img.width;
    let height = img.naturalHeight || img.height;
    if (!width || !height) {
     URL.revokeObjectURL(objectUrl);
     resolve(file);
     return;
    }
    if (width > maxDimension || height > maxDimension) {
     if (width >= height) {
      height = Math.round((height * maxDimension) / width);
      width = maxDimension;
     } else {
      width = Math.round((width * maxDimension) / height);
      height = maxDimension;
     }
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
     URL.revokeObjectURL(objectUrl);
     resolve(file);
     return;
    }
    ctx.drawImage(img, 0, 0, width, height);
    canvas.toBlob(compressed => {
     URL.revokeObjectURL(objectUrl);
     if (compressed && compressed.size > 0 && compressed.size < file.size) {
      resolve(compressed);
     } else {
      resolve(file);
     }
    }, 'image/jpeg', quality);
   } catch (err) {
    URL.revokeObjectURL(objectUrl);
    resolve(file);
   }
  };
  img.onerror = () => {
   URL.revokeObjectURL(objectUrl);
   resolve(file);
  };
  img.src = objectUrl;
 });
}

function setAvatarContent(container, avatarUrl, fallbackEmoji = '👤') {
 if (!container) return;
 container.replaceChildren();
 if (avatarUrl) {
  const img = document.createElement('img');
  img.src = avatarUrl;
  img.alt = 'Avatar';
  img.loading = 'lazy';
  img.decoding = 'async';
  container.append(img);
 } else {
  container.textContent = fallbackEmoji;
 }
}

function createAvatarNode(profile, isStoryActive = false) {
 const container = document.createElement('div');
 container.className = 'story-avatar-container';

 const inner = document.createElement('div');
 inner.className = 'story-avatar-inner';

 if (profile?.avatar_url) {
  const img = document.createElement('img');
  img.src = profile.avatar_url;
  img.alt = 'Avatar';
  img.loading = 'lazy';
  img.decoding = 'async';
  inner.append(img);
 } else {
  const placeholder = document.createElement('div');
  placeholder.style.fontSize = '20px';
  placeholder.textContent = '👤';
  inner.append(placeholder);
 }
 container.append(inner);

 const dot = document.createElement('span');
 dot.className = 'online-dot';
 if (profile?.id && onlineUsersMap[profile.id]) {
  dot.classList.add('active');
 }
 dot.id = `online-dot-${profile?.id}`;
 container.append(dot);

 return container;
}

function updateNavAvatarUI() {
 const navContainer = document.getElementById('navAvatarContainer');
 if (!navContainer) return;

 const dot = document.getElementById('navOnlineDot');
 navContainer.replaceChildren();

 if (myProfile?.avatar_url) {
  const img = document.createElement('img');
  img.src = myProfile.avatar_url;
  img.alt = 'Perfil';
  img.loading = 'lazy';
  img.decoding = 'async';
  navContainer.append(img);
 } else {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.style.width = '16px';
  svg.style.height = '16px';
  svg.innerHTML = '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>';
  navContainer.append(svg);
 }
 if (dot) navContainer.append(dot);
}

function renderPostsGrid(posts, gridElement, emptyMessage) {
 if (!gridElement) return;
 gridElement.replaceChildren();
 if (!posts || !posts.length) {
  gridElement.innerHTML = `<div class="grid-empty-msg">${emptyMessage}</div>`;
  return;
 }

 const fragment = document.createDocumentFragment();
 posts.forEach(post => {
  const item = document.createElement('div');
  item.className = 'ig-grid-item';
  item.onclick = () => openPostDetail(post);

  if (post.image_url) {
   const img = document.createElement('img');
   img.src = post.image_url;
   img.loading = 'lazy';
   img.decoding = 'async';
   item.append(img);
  } else {
   item.textContent = (post.content || '').slice(0, 55);
  }
  fragment.append(item);
 });
 gridElement.replaceChildren(fragment);
}

function prefetchUserProfile(userId) {
 if (!userId || !currentUser || userId === currentUser.id) return;
 if (prefetchedProfileIds.has(userId) && profilesCache[userId]?.bio !== undefined) return;
 prefetchedProfileIds.add(userId);
 db.from('og_profiles')
  .select(PROFILE_SELECT_FIELDS)
  .eq('id', userId)
  .maybeSingle()
  .then(({ data }) => {
   if (data) setCachedProfile(data, true);
  })
  .catch(() => {});
}

function prefetchConversationMessages(conversationId) {
 if (!conversationId || !currentUser || prefetchedConversationIds.has(conversationId)) return;
 prefetchedConversationIds.add(conversationId);
 db.from('messages')
  .select('id, conversation_id, sender_id, content, reply_to_id, reply_to_snippet, created_at')
  .eq('conversation_id', conversationId)
  .order('created_at', { ascending: true })
  .limit(40)
  .then(({ data }) => {
   if (data) {
    prefetchedMessagesByConv[conversationId] = data;
    ogCache.set(`chat_msgs_${conversationId}`, data);
   }
  })
  .catch(() => {});
}

function bindSmartPrefetch(element, callback) {
 if (!element || typeof callback !== 'function') return;
 let triggered = false;
 const run = () => {
  if (triggered) return;
  triggered = true;
  callback();
 };
 element.addEventListener('touchstart', run, { passive: true, once: true });
 element.addEventListener('mouseenter', run, { passive: true, once: true });
}
