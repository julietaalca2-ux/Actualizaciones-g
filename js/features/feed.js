/* Depende de: config.js (db); state.js (currentUser, myProfile, profilesCache, feedPage,
   FEED_PAGE_SIZE, feedLoading, feedHasMore, loadedPostIds, cachedFeedPosts, cachedFollowingIds,
   cachedActivityEvents, isPublishing, postImageBlob, visitorId); utils.js (status, formatDate,
   setPreviewBlobUrl, revokePreviewBlobUrl, compressImageBlob, createAvatarNode, renderPostsGrid,
   ogCache, setCachedProfile, prefetchUserProfile, bindSmartPrefetch, POST_SELECT_FIELDS,
   PROFILE_MINI_FIELDS); core/navigation.js (showTab)
   En tiempo de ejecución usa funciones de otros módulos: showAuthOverlay (auth.js),
   openPublicProfile (profile.js)
   Expone: loadInitialPosts, loadMorePosts, fetchAndAppendPosts, renderPostsToDOM,
   prependSinglePostToFeed, buildPostDOMElement, toggleLike, loadPostLikes,
   loadPostComments, quickComment, handlePostImageSelect, removePostImage, publish,
   openPostDetail, closePostDetailModal, getSavedPostIds, toggleSavePost,
   fetchAndRenderSavedGrid, loadSavedPostsGrid, loadSavedPostsProfileGrid,
   choosePostAudio, setPostAudio, clearPostAudio, buildPostMusicNode
   (la música de las publicaciones usa la biblioteca de audio-library.js) */

async function loadInitialPosts() {
 feedPage = 0;
 feedHasMore = true;
 const container = document.getElementById('posts');

 if (cachedFeedPosts && cachedFeedPosts.length > 0) {
  renderPostsToDOM(cachedFeedPosts, container, true);
 } else {
  loadedPostIds.clear();
  container.innerHTML = '<div class="activity-empty">Cargando publicaciones...</div>';
 }
 await fetchAndAppendPosts(true);
}

async function loadMorePosts() {
 if (feedLoading || !feedHasMore) return;
 feedPage++;
 await fetchAndAppendPosts(false);
}

async function getAllowedFeedUserIds() {
 if (!currentUser) return [];
 if (Array.isArray(cachedFollowingIds)) {
  return [...new Set([...cachedFollowingIds, currentUser.id])];
 }
 const { data: followingRes } = await db.from('follows')
  .select('following_id')
  .eq('follower_id', currentUser.id);
 cachedFollowingIds = (followingRes || []).map(f => f.following_id);
 ogCache.set('following_ids', cachedFollowingIds);
 return [...new Set([...cachedFollowingIds, currentUser.id])];
}

async function fetchAndAppendPosts(isInitial) {
 if (feedLoading || !feedHasMore || !currentUser) return;
 feedLoading = true;
 const loader = document.getElementById('feedLoader');
 if (loader) loader.style.display = 'block';

 try {
  const allowedUserIds = await getAllowedFeedUserIds();

  const from = feedPage * FEED_PAGE_SIZE;
  const to = from + FEED_PAGE_SIZE - 1;

  const { data: posts, error } = await db.from('posts')
   .select(POST_SELECT_FIELDS)
   .in('user_id', allowedUserIds)
   .order('created_at', { ascending: false })
   .range(from, to);

  if (loader) loader.style.display = 'none';
  feedLoading = false;
  if (error) return;

  if (!posts || posts.length < FEED_PAGE_SIZE) feedHasMore = false;

  if (!posts || !posts.length) {
   if (isInitial) {
    cachedFeedPosts = [];
    ogCache.set('feed_posts', []);
    document.getElementById('posts').innerHTML = '<div class="activity-empty">Aún no sigues a nadie o no hay publicaciones en tu feed. ¡Explora perfiles para ver contenido!</div>';
   }
   return;
  }

  const targetPosts = isInitial ? posts : posts.filter(p => !loadedPostIds.has(p.id));
  if (!targetPosts.length && !isInitial) return;

  const postIds = targetPosts.map(p => p.id);

  // Eliminar consultas N+1: cargar likes y comentarios de toda la página en 2 consultas batch
  const [likesRes, commentsRes] = await Promise.all([
   db.from('likes').select('post_id, user_id').in('post_id', postIds),
   db.from('comments').select('id, post_id, user_id, content, created_at').in('post_id', postIds).order('created_at', { ascending: true })
  ]);

  const likesByPost = {};
  (likesRes.data || []).forEach(like => {
   if (!likesByPost[like.post_id]) likesByPost[like.post_id] = [];
   likesByPost[like.post_id].push(like);
  });

  const commentsByPost = {};
  (commentsRes.data || []).forEach(comment => {
   if (!commentsByPost[comment.post_id]) commentsByPost[comment.post_id] = [];
   commentsByPost[comment.post_id].push(comment);
  });

  const neededUserIds = new Set();
  targetPosts.forEach(p => { if (p.user_id) neededUserIds.add(p.user_id); });
  (commentsRes.data || []).forEach(c => { if (c.user_id) neededUserIds.add(c.user_id); });

  const missingUserIds = [...neededUserIds].filter(id => !profilesCache[id]);
  if (missingUserIds.length > 0) {
   const { data: newProfiles } = await db.from('og_profiles')
    .select(PROFILE_MINI_FIELDS)
    .in('id', missingUserIds);
   (newProfiles || []).forEach(p => setCachedProfile(p, false));
   ogCache.set('profiles_map', profilesCache);
  }

  const metaByPost = {};
  targetPosts.forEach(p => {
   metaByPost[p.id] = {
    likes: likesByPost[p.id] || [],
    comments: commentsByPost[p.id] || []
   };
  });

  if (isInitial) {
   cachedFeedPosts = posts;
   ogCache.set('feed_posts', posts.slice(0, 30));
   renderPostsToDOM(posts, document.getElementById('posts'), true, metaByPost);
  } else {
   cachedFeedPosts = (cachedFeedPosts || []).concat(targetPosts);
   ogCache.set('feed_posts', cachedFeedPosts.slice(0, 30));
   const container = document.getElementById('posts');
   const fragment = document.createDocumentFragment();
   targetPosts.forEach(post => {
    loadedPostIds.add(post.id);
    fragment.append(buildPostDOMElement(post, metaByPost[post.id]));
   });
   container.append(fragment);
  }
 } catch (e) {
  if (loader) loader.style.display = 'none';
  feedLoading = false;
 }
}

function renderPostsToDOM(posts, container, reset = false, metaByPost = null) {
 if (!container) return;
 if (reset) {
  loadedPostIds.clear();
  container.replaceChildren();
 }
 if (!posts || !posts.length) return;

 const fragment = document.createDocumentFragment();
 posts.forEach(post => {
  if (loadedPostIds.has(post.id)) return;
  loadedPostIds.add(post.id);
  fragment.append(buildPostDOMElement(post, metaByPost ? metaByPost[post.id] : null));
 });

 if (reset) container.replaceChildren(fragment);
 else container.append(fragment);
}

function prependSinglePostToFeed(post) {
 if (!post || loadedPostIds.has(post.id)) return;
 loadedPostIds.add(post.id);
 const container = document.getElementById('posts');
 if (!container) return;
 const emptyPlaceholder = container.querySelector('.activity-empty');
 if (emptyPlaceholder) emptyPlaceholder.remove();
 container.insertBefore(buildPostDOMElement(post), container.firstChild);
}

function renderCommentsListToContainer(comments, container) {
 if (!comments || !comments.length) {
  container.replaceChildren();
  return;
 }
 const fragment = document.createDocumentFragment();
 comments.slice(0, 3).forEach(c => {
  const profile = profilesCache[c.user_id] || { username: 'usuario' };
  const div = document.createElement('div');
  div.className = 'comment-item';
  const userSpan = document.createElement('span');
  userSpan.className = 'comment-user';
  userSpan.textContent = profile.username || profile.display_name;
  userSpan.setAttribute('data-verify-user', c.user_id);
  const textSpan = document.createElement('span');
  textSpan.className = 'comment-text';
  textSpan.textContent = c.content;
  div.append(userSpan, textSpan);
  fragment.append(div);
 });
 container.replaceChildren(fragment);
}

function buildPostDOMElement(post, preloadedMeta = null) {
 const profile = profilesCache[post.user_id] || { username: 'usuario' };

 const article = document.createElement('article');
 article.className = 'post';

 const head = document.createElement('div');
 head.className = 'posthead';

 const goProfile = () => openPublicProfile(post.user_id);
 const prefetchAuthor = () => prefetchUserProfile(post.user_id);

 const av = createAvatarNode(profile, false);
 av.style.cursor = 'pointer';
 av.onclick = goProfile;
 bindSmartPrefetch(av, prefetchAuthor);

 const info = document.createElement('div');
 info.style.cursor = 'pointer';
 info.onclick = goProfile;
 bindSmartPrefetch(info, prefetchAuthor);

 const name = document.createElement('div');
 name.className = 'username';
 name.textContent = profile.username || profile.display_name || 'Usuario';
 name.setAttribute('data-verify-user', post.user_id);

 const time = document.createElement('div');
 time.className = 'time';
 time.textContent = formatDate(post.created_at);

 info.append(name, time);
 head.append(av, info);
 article.append(head);

 if (post.image_url) {
  const img = document.createElement('img');
  img.className = 'postimage';
  img.src = post.image_url;
  img.alt = 'Imagen';
  img.loading = 'lazy';
  img.decoding = 'async';
  article.append(img);
 }

 const musicNode = buildPostMusicNode(post);
 if (musicNode) article.append(musicNode);

 if (post.content) {
  const content = document.createElement('p');
  content.className = 'posttext';
  content.style.marginTop = (post.image_url || musicNode) ? '12px' : '0';
  content.textContent = post.content;
  article.append(content);
 }

 const commentsSec = document.createElement('div');
 commentsSec.className = 'post-comments-section';
 commentsSec.id = `comments-${post.id}`;
 article.append(commentsSec);

 const commentInputBox = document.createElement('div');
 commentInputBox.className = 'comment-input-box';
 commentInputBox.id = `commentbox-${post.id}`;

 const commentInput = document.createElement('input');
 commentInput.className = 'comment-input';
 commentInput.placeholder = 'Agrega un comentario...';

 const commentSend = document.createElement('button');
 commentSend.className = 'comment-send-btn';
 commentSend.textContent = 'Publicar';
 commentSend.onclick = () => quickComment(post.id, commentInput);

 commentInputBox.append(commentInput, commentSend);
 article.append(commentInputBox);

 const actions = document.createElement('div');
 actions.className = 'post-actions';

 const likeBtn = document.createElement('button');
 likeBtn.className = 'post-action-btn';
 likeBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
 likeBtn.onclick = () => toggleLike(post.id, likeBtn, likesCountDiv);

 const commentIconBtn = document.createElement('button');
 commentIconBtn.className = 'post-action-btn';
 commentIconBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
 commentIconBtn.onclick = () => {
  if (!currentUser) { showAuthOverlay(); return; }
  const box = document.getElementById(`commentbox-${post.id}`);
  box.classList.toggle('open');
  if (box.classList.contains('open')) box.querySelector('input').focus();
 };

 const saveBtn = document.createElement('button');
 saveBtn.className = 'post-action-btn';
 saveBtn.style.marginLeft = 'auto';
 if (getSavedPostIds().includes(post.id)) saveBtn.classList.add('saved');
 saveBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
 saveBtn.onclick = () => toggleSavePost(post.id, saveBtn);

 actions.append(likeBtn, commentIconBtn, saveBtn);
 article.append(actions);

 const likesCountDiv = document.createElement('div');
 likesCountDiv.className = 'likes-count';
 likesCountDiv.textContent = '0 Me gusta';
 article.append(likesCountDiv);

 if (preloadedMeta) {
  const likes = preloadedMeta.likes || [];
  likesCountDiv.textContent = `${likes.length} Me gusta`;
  if (currentUser && likes.some(l => l.user_id === currentUser.id)) {
   likeBtn.classList.add('liked');
  }
  renderCommentsListToContainer(preloadedMeta.comments || [], commentsSec);
 } else {
  loadPostLikes(post.id, likeBtn, likesCountDiv);
  loadPostComments(post.id, commentsSec);
 }

 return article;
}

async function toggleLike(postId, btn, countDiv) {
 if (!currentUser) { showAuthOverlay(); return; }
 const { data, error } = await db.rpc('toggle_like', { p_post_id: postId, p_user_id: currentUser.id });
 if (error) return;
 if (data) {
  if (data.liked) btn.classList.add('liked');
  else btn.classList.remove('liked');
  countDiv.textContent = `${data.count || 0} Me gusta`;
 }
}

async function loadPostLikes(postId, btn, countDiv) {
 const { data: likes } = await db.from('likes').select('user_id').eq('post_id', postId);
 const count = likes ? likes.length : 0;
 countDiv.textContent = `${count} Me gusta`;
 if (currentUser && likes && likes.some(l => l.user_id === currentUser.id)) btn.classList.add('liked');
}

async function loadPostComments(postId, container) {
 const { data: comments } = await db.from('comments')
  .select('id, post_id, user_id, content, created_at')
  .eq('post_id', postId)
  .order('created_at', { ascending: true });
 if (!comments || !comments.length) { container.replaceChildren(); return; }

 const missing = [...new Set(comments.map(c => c.user_id))].filter(id => !profilesCache[id]);
 if (missing.length > 0) {
  const { data: profs } = await db.from('og_profiles').select(PROFILE_MINI_FIELDS).in('id', missing);
  (profs || []).forEach(p => setCachedProfile(p, false));
 }

 renderCommentsListToContainer(comments, container);
}

async function quickComment(postId, input) {
 if (!currentUser) { showAuthOverlay(); return; }
 const text = input.value.trim();
 if (!text) return;
 input.value = '';
 await db.from('comments').insert({ post_id: postId, user_id: currentUser.id, content: text });
 cachedActivityEvents = null;
 ogCache.remove('activity_events');
 const sec = document.getElementById(`comments-${postId}`);
 if (sec) loadPostComments(postId, sec);
}

async function handlePostImageSelect(input) {
 const file = input.files?.[0];
 if (!file) return;
 input.value = '';
 const compressed = await compressImageBlob(file, 1080, 0.82);
 postImageBlob = compressed;
 setPreviewBlobUrl(document.getElementById('postImagePreviewImg'), compressed);
 document.getElementById('postImagePreviewContainer').style.display = 'block';
 document.getElementById('dropzoneBox').style.display = 'none';
}

function removePostImage() {
 postImageBlob = null;
 revokePreviewBlobUrl(document.getElementById('postImagePreviewImg'));
 document.getElementById('postImagePreviewContainer').style.display = 'none';
 document.getElementById('dropzoneBox').style.display = 'flex';
}

async function publish() {
 if (!currentUser || isPublishing) return;
 const text = document.getElementById('newpost').value.trim();
 if (!text && !postImageBlob) return status('publishStatus', 'Escribe algo o agrega una foto.');

 isPublishing = true;
 status('publishStatus', 'Publicando...');
 document.getElementById('publishBtn').disabled = true;

 let imageUrl = null;
 if (postImageBlob) {
  const path = currentUser.id + '/post-' + Date.now() + '.jpg';
  const { error: uploadError } = await db.storage.from('og-media').upload(path, postImageBlob, { cacheControl: '3600', upsert: false, contentType: 'image/jpeg' });
  if (!uploadError) {
   imageUrl = db.storage.from('og-media').getPublicUrl(path).data.publicUrl;
  }
 }

 const newPost = { user_id: currentUser.id, content: text, image_url: imageUrl };
 // La música solo se envía si se eligió una (así las publicaciones sin música no dependen de las columnas nuevas)
 if (postDraftAudio) {
  newPost.audio_url = postDraftAudio.url;
  newPost.audio_title = postDraftAudio.title;
  newPost.audio_link = postDraftAudio.link || null;
 }

 const { error: insertError } = await db.from('posts').insert(newPost);

 isPublishing = false;
 document.getElementById('publishBtn').disabled = false;

 if (insertError) {
  console.error('Error al publicar:', insertError);
  const missingCols = /audio_(url|title|link)/i.test(insertError.message || '');
  return status('publishStatus', missingCols
   ? 'Falta ejecutar el SQL de música en Supabase (supabase/01_musica_posts_y_push.sql).'
   : 'No se pudo publicar: ' + insertError.message);
 }

 document.getElementById('newpost').value = '';
 removePostImage();
 clearPostAudio();
 status('publishStatus', '¡Publicado con éxito!');
 ogPlaySound('publish');
 setTimeout(() => status('publishStatus', ''), 2000);
 cachedFeedPosts = null;
 ogCache.remove('feed_posts');
 showTab('feed');
 await loadInitialPosts();
}

/* ---------- Música en publicaciones ---------- */

let postDraftAudio = null;   // { title, url, link } elegido en la biblioteca
let postMusicEl = null;      // único <audio> de publicaciones (evita sonar dos a la vez)
let postMusicBtn = null;
let postMusicObserver = null;

function choosePostAudio() {
 openAudioPicker('post');
}

function setPostAudio(audio) {
 postDraftAudio = audio;
 renderPostDraftAudio();
}

function clearPostAudio() {
 postDraftAudio = null;
 renderPostDraftAudio();
}

function renderPostDraftAudio() {
 const box = document.getElementById('post-audio-selected');
 const name = document.getElementById('post-audio-selected-name');
 const btn = document.getElementById('post-audio-choose-btn');
 if (!box || !name) return;
 if (postDraftAudio) {
  name.textContent = postDraftAudio.title;
  box.style.display = 'flex';
  if (btn) btn.textContent = '🎵 Cambiar música';
 } else {
  name.textContent = '';
  box.style.display = 'none';
  if (btn) btn.textContent = '🎵 Añadir música';
 }
}

const POST_MUSIC_PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const POST_MUSIC_PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

function stopPostMusic() {
 const el = postMusicEl;
 const btn = postMusicBtn;
 postMusicEl = null;
 postMusicBtn = null;
 if (el) {
  el.pause();
  el.removeAttribute('src');
  el.load();
 }
 if (btn) {
  btn.innerHTML = POST_MUSIC_PLAY_SVG;
  btn.closest('.post-music')?.classList.remove('playing');
 }
}

function togglePostMusic(url, btn) {
 if (postMusicEl && postMusicBtn === btn) {
  if (postMusicEl.paused) postMusicEl.play().catch(() => stopPostMusic());
  else stopPostMusic();
  return;
 }
 stopPostMusic();

 const el = new Audio(url);
 el.loop = true;
 el.preload = 'auto';
 postMusicEl = el;
 postMusicBtn = btn;
 btn.innerHTML = POST_MUSIC_PAUSE_SVG;
 btn.closest('.post-music')?.classList.add('playing');
 el.addEventListener('error', () => { if (postMusicEl === el) stopPostMusic(); });
 el.play().catch(() => stopPostMusic());
}

// Pausa la música cuando la publicación sale de la pantalla
function watchPostMusic(node) {
 if (!('IntersectionObserver' in window)) return;
 if (!postMusicObserver) {
  postMusicObserver = new IntersectionObserver(entries => {
   entries.forEach(entry => {
    if (!entry.isIntersecting && postMusicBtn && entry.target.contains(postMusicBtn)) stopPostMusic();
   });
  }, { threshold: 0.15 });
 }
 postMusicObserver.observe(node);
}

document.addEventListener('visibilitychange', () => {
 if (document.visibilityState === 'hidden') stopPostMusic();
});

function buildPostMusicNode(post) {
 if (!post || !post.audio_url) return null;

 const wrap = document.createElement('div');
 wrap.className = 'post-music';

 const btn = document.createElement('button');
 btn.type = 'button';
 btn.className = 'post-music-btn';
 btn.setAttribute('aria-label', 'Reproducir música');
 btn.innerHTML = POST_MUSIC_PLAY_SVG;
 btn.onclick = () => togglePostMusic(post.audio_url, btn);

 const info = document.createElement('div');
 info.className = 'post-music-info';
 const title = document.createElement('span');
 title.className = 'post-music-title';
 title.textContent = post.audio_title || 'Música';
 info.append(title);

 if (post.audio_link) {
  const link = document.createElement('a');
  link.className = 'post-music-credit';
  link.href = post.audio_link;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Fuente';
  info.append(link);
 }

 const bars = document.createElement('div');
 bars.className = 'post-music-bars';
 bars.innerHTML = '<i></i><i></i><i></i>';

 wrap.append(btn, info, bars);
 watchPostMusic(wrap);
 return wrap;
}

async function openPostDetail(post) {
 if (!currentUser) { showAuthOverlay(); return; }
 const modal = document.getElementById('postDetailModal');
 const container = document.getElementById('modalPostContainer');
 container.replaceChildren();

 const profile = profilesCache[post.user_id] || myProfile || { username: 'usuario' };
 const article = document.createElement('article');
 article.className = 'post';
 article.style.borderBottom = 'none';

 const head = document.createElement('div');
 head.className = 'posthead';
 head.append(createAvatarNode(profile, false));
 const info = document.createElement('div');
 info.innerHTML = `<div class="username" data-verify-user="${post.user_id}">${profile.username || profile.display_name}</div><div class="time">${formatDate(post.created_at)}</div>`;
 head.append(info);
 article.append(head);

 if (post.image_url) {
  const img = document.createElement('img');
  img.className = 'postimage';
  img.src = post.image_url;
  img.decoding = 'async';
  article.append(img);
 }
 const detailMusic = buildPostMusicNode(post);
 if (detailMusic) article.append(detailMusic);
 if (post.content) {
  const content = document.createElement('p');
  content.className = 'posttext';
  content.textContent = post.content;
  article.append(content);
 }

 const commentsSec = document.createElement('div');
 commentsSec.className = 'post-comments-section';
 commentsSec.id = `modal-comments-${post.id}`;
 article.append(commentsSec);

 const commentInputBox = document.createElement('div');
 commentInputBox.className = 'comment-input-box open';
 const commentInput = document.createElement('input');
 commentInput.className = 'comment-input';
 commentInput.placeholder = 'Agrega un comentario...';
 const commentSend = document.createElement('button');
 commentSend.className = 'comment-send-btn';
 commentSend.textContent = 'Publicar';
 commentSend.onclick = async () => {
  await quickComment(post.id, commentInput);
  loadPostComments(post.id, commentsSec);
 };
 commentInputBox.append(commentInput, commentSend);
 article.append(commentInputBox);

 container.append(article);
 modal.classList.add('active');
 loadPostComments(post.id, commentsSec);

 db.rpc('register_post_view', { p_post_id: post.id, p_visitor_id: visitorId }).then(() => {
  const nextViews = (post.views || 0) + 1;
  post.views = nextViews;
  document.querySelectorAll(`[data-post-views="${post.id}"]`).forEach(el => {
   el.textContent = nextViews;
  });
 }).catch(() => {});
}

function closePostDetailModal() {
 stopPostMusic();
 document.getElementById('postDetailModal').classList.remove('active');
}

function getSavedPostIds() {
 if (!currentUser) return [];
 try {
  return JSON.parse(localStorage.getItem('og_saved_posts_' + currentUser.id) || '[]');
 } catch (e) { return []; }
}

function toggleSavePost(postId, btn) {
 if (!currentUser) { showAuthOverlay(); return; }
 let saved = getSavedPostIds();
 if (saved.includes(postId)) {
  saved = saved.filter(id => id !== postId);
  btn.classList.remove('saved');
 } else {
  saved.unshift(postId);
  btn.classList.add('saved');
 }
 localStorage.setItem('og_saved_posts_' + currentUser.id, JSON.stringify(saved));
}

async function fetchAndRenderSavedGrid(gridId, emptyText) {
 const grid = document.getElementById(gridId);
 if (!grid || !currentUser) return;
 const savedIds = getSavedPostIds();
 if (!savedIds.length) {
  grid.dataset.sig = '';
  renderPostsGrid([], grid, emptyText);
  return;
 }
 const { data: posts } = await db.from('posts').select(POST_SELECT_FIELDS).in('id', savedIds);
 const sig = (posts || []).map(p => p.id).join(',');
 if (grid.dataset.sig === sig && grid.childElementCount > 0) return;
 grid.dataset.sig = sig;
 renderPostsGrid(posts, grid, 'No se encontraron publicaciones guardadas.');
}

async function loadSavedPostsGrid() {
 await fetchAndRenderSavedGrid('savedPostsGrid', 'Todavía no guardaste ninguna publicación.');
}

async function loadSavedPostsProfileGrid() {
 await fetchAndRenderSavedGrid('savedPostsGridProfile', 'Solo tú puedes ver lo que has guardado.');
}
