/* ==========================================
   FEATURE: LOORS (Videos verticales 9:16)
   Depende de: db (Supabase), currentUser
   ========================================== */

// Avatar por defecto (silueta gris) para creadores sin foto; no depende de ningún archivo externo
const LOOR_DEFAULT_AVATAR = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#3a3a3c"/><circle cx="20" cy="15" r="7" fill="#9a9aa0"/><path d="M6 36c0-8 6-13 14-13s14 5 14 13z" fill="#9a9aa0"/></svg>'
);

let activeLoorIdForComments = null;
const viewedLoorsSession = new Set();
let loorVideoObserver = null;
let loorsInitialized = false;

function initLoors() {
  if (loorsInitialized) return;
  loorsInitialized = true;
  bindLoorsUIEvents();
}

async function openLoorsSection(targetLoorId) {
  initLoors();
  const section = document.getElementById('loors-section');
  if (!section) return;
  section.classList.add('active');
  await loadLoorsFeed(targetLoorId);
}

function closeLoorsSection() {
  const section = document.getElementById('loors-section');
  if (!section) return;
  section.classList.remove('active');
  document.querySelectorAll('.loor-video, .loor-audio').forEach(media => media.pause());
}

// Reproduce el video de una tarjeta y, si tiene música elegida, también su audio
function playLoorCard(card) {
  const video = card.querySelector('.loor-video');
  const audio = card.querySelector('.loor-audio');

  video.play().then(() => {
    card.classList.remove('paused');
  }).catch(() => {
    video.muted = true;
    video.play().catch(() => {});
  });

  // En iPhone el audio puede quedar bloqueado hasta que la persona toque la pantalla
  if (audio) audio.play().catch(() => {});
}

function pauseLoorCard(card) {
  const video = card.querySelector('.loor-video');
  const audio = card.querySelector('.loor-audio');
  video.pause();
  if (audio) audio.pause();
}

/* Paginación: se cargan LOORS_PAGE_SIZE videos por vez; al llegar al final se piden los siguientes */
const LOORS_PAGE_SIZE = 8;
const LOORS_FIELDS = 'id, user_id, video_url, thumbnail_url, description, hashtags, audio_url, audio_name, audio_link, views_count, created_at';
let loorsPage = 0;
let loorsHasMore = true;
let loorsLoading = false;
let loorsFeedToken = 0;
let loorsSentinelObserver = null;
let loorsFieldsOk = true;   // pasa a false si alguna columna de LOORS_FIELDS no existe: se usa '*'

async function fetchLoorsPage(page) {
  const from = page * LOORS_PAGE_SIZE;
  const build = (fields) => db.from('loors').select(fields)
    .order('created_at', { ascending: false })
    .range(from, from + LOORS_PAGE_SIZE - 1);
  if (loorsFieldsOk) {
    const res = await build(LOORS_FIELDS);
    if (!res.error) return res;
    loorsFieldsOk = false;
  }
  return build('*');
}

async function loadLoorsFeed(targetLoorId) {
  const container = document.getElementById('loors-feed-container');
  if (!container) return;
  if (loorsLoading) return;
  loorsLoading = true;
  const token = ++loorsFeedToken;

  // Detener cualquier video o audio anterior antes de recargar la lista
  document.querySelectorAll('.loor-video, .loor-audio').forEach(media => media.pause());
  if (loorsSentinelObserver) { loorsSentinelObserver.disconnect(); loorsSentinelObserver = null; }
  loorsPage = 0;
  loorsHasMore = true;

  container.innerHTML = `<div style="color:#fff;text-align:center;margin-top:45vh;font-size:0.95rem;">Cargando LOORS...</div>`;

  try {
    const { data: loors, error } = await fetchLoorsPage(0);

    if (token !== loorsFeedToken) return;

    if (error) {
      console.error('Error cargando loors:', error);
      container.innerHTML = `<div style="color:#fff;text-align:center;margin-top:45vh;">Error al cargar videos.</div>`;
      return;
    }

    if (!loors || loors.length === 0) {
      loorsHasMore = false;
      container.innerHTML = `
        <div style="color:#fff;text-align:center;margin-top:38vh;padding:0 24px;">
          <p style="font-size:1.1rem;font-weight:700;margin-bottom:8px;">Aún no hay LOORS</p>
          <p style="font-size:0.9rem;opacity:0.75;margin-bottom:18px;">Subí el primer video vertical en ÖG.</p>
          <button class="loor-submit-btn" style="background:#fff;color:#000;" onclick="document.getElementById('loors-upload-modal').classList.add('open')">Subir Loor</button>
        </div>`;
      return;
    }

    loorsHasMore = loors.length >= LOORS_PAGE_SIZE;
    let firstBatch = loors;

    // Si se tocó un video en Explorar, aparece primero
    if (targetLoorId) {
      const inPage = loors.find(l => String(l.id) === String(targetLoorId));
      if (inPage) {
        firstBatch = [inPage, ...loors.filter(l => l !== inPage)];
      } else {
        const one = await db.from('loors').select(loorsFieldsOk ? LOORS_FIELDS : '*').eq('id', targetLoorId).maybeSingle();
        if (one.data) firstBatch = [one.data, ...loors];
      }
    }

    container.innerHTML = '';
    await renderLoorsBatch(firstBatch, container);
    attachLoorsSentinel(container);
  } catch (err) {
    console.error('Loors: error al mostrar videos', err);
    if (token === loorsFeedToken && !container.querySelector('.loor-item')) {
      container.innerHTML = `<div style="color:#fff;text-align:center;margin-top:42vh;padding:0 24px;"><p style="margin-bottom:14px;">No se pudieron cargar los videos.</p><button class="loor-submit-btn" style="background:#fff;color:#000;" onclick="loadLoorsFeed()">Reintentar</button></div>`;
    }
  } finally {
    loorsLoading = false;
  }
}

/* Pide la página siguiente cuando la persona llega al final del listado */
async function loadMoreLoors() {
  const container = document.getElementById('loors-feed-container');
  if (!container || loorsLoading || !loorsHasMore) return;
  loorsLoading = true;
  const token = loorsFeedToken;
  try {
    const { data: loors, error } = await fetchLoorsPage(loorsPage + 1);
    if (token !== loorsFeedToken) return;
    if (error) return;
    loorsPage++;
    const known = new Set([...container.querySelectorAll('.loor-item')].map(c => String(c.dataset.loorId)));
    const fresh = (loors || []).filter(l => !known.has(String(l.id)));
    loorsHasMore = (loors || []).length >= LOORS_PAGE_SIZE;
    if (fresh.length) await renderLoorsBatch(fresh, container);
    attachLoorsSentinel(container);
  } finally {
    loorsLoading = false;
  }
}

function attachLoorsSentinel(container) {
  if (loorsSentinelObserver) { loorsSentinelObserver.disconnect(); loorsSentinelObserver = null; }
  container.querySelectorAll('.loors-sentinel').forEach(n => n.remove());
  if (!loorsHasMore || !('IntersectionObserver' in window)) return;
  // Se observa el penúltimo video: cuando se ve, ya se piden los siguientes
  const cards = container.querySelectorAll('.loor-item');
  const trigger = cards[Math.max(0, cards.length - 2)];
  if (!trigger) return;
  loorsSentinelObserver = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) {
      loorsSentinelObserver.disconnect();
      loadMoreLoors();
    }
  }, { root: container, threshold: 0.5 });
  loorsSentinelObserver.observe(trigger);
}

/* Dibuja un grupo de videos (con sus perfiles, likes, comentarios y guardados) al final del listado */
async function renderLoorsBatch(loors, container) {
  const userIds = [...new Set(loors.map(l => l.user_id))];
  const loorIds = loors.map(l => l.id);

  // Nota: si tu tabla de perfiles en ÖG es 'og_profiles' en lugar de 'profiles', cambiá 'profiles' por 'og_profiles' aquí abajo:
  const [profilesRes, likesRes, commentsRes, savesRes, followsRes] = await Promise.all([
    db.from('og_profiles').select('id, username, display_name, avatar_url').in('id', userIds),
    db.from('loor_likes').select('loor_id, user_id').in('loor_id', loorIds),
    db.from('loor_comments').select('loor_id').in('loor_id', loorIds),
    currentUser
      ? db.from('loor_saves').select('loor_id').eq('user_id', currentUser.id)
      : Promise.resolve({ data: [] }),
    currentUser
      ? db.from('follows').select('following_id').eq('follower_id', currentUser.id)
      : Promise.resolve({ data: [] })
  ]);

  // Perfiles de los creadores: si la consulta falla o viene vacía, se reintenta con todas las columnas
  // y, como último recurso, se usa la caché de perfiles que ya tiene la app.
  let profilesData = profilesRes.data || [];
  if (profilesRes.error || profilesData.length === 0) {
    console.error('Loors: no se pudieron leer los perfiles, reintentando', profilesRes.error);
    const retry = await db.from('og_profiles').select('*').in('id', userIds);
    if (retry.error) console.error('Loors: error en el reintento de perfiles', retry.error);
    profilesData = retry.data || [];
  }
  const profilesMap = new Map(profilesData.map(p => [p.id, p]));
  userIds.forEach(id => {
    if (!profilesMap.has(id) && typeof profilesCache !== 'undefined' && profilesCache[id]) {
      profilesMap.set(id, profilesCache[id]);
    }
  });
  const allLikes = likesRes.data || [];
  const allComments = commentsRes.data || [];
  const savedSet = new Set((savesRes.data || []).map(s => s.loor_id));
  const followingSet = new Set((followsRes.data || []).map(f => f.following_id));

  const newCards = [];

  loors.forEach((loor, loorIndex) => {
    const creator = profilesMap.get(loor.user_id) || {
      username: 'usuario_og',
      avatar_url: LOOR_DEFAULT_AVATAR
    };

    const loorLikes = allLikes.filter(lk => lk.loor_id === loor.id);
    const isLiked = currentUser ? loorLikes.some(lk => lk.user_id === currentUser.id) : false;
    const commentsCount = allComments.filter(c => c.loor_id === loor.id).length;
    const isSaved = savedSet.has(loor.id);
    const isFollowing = followingSet.has(loor.user_id);
    const isOwnVideo = currentUser && currentUser.id === loor.user_id;

    const hashtagsFormatted = (loor.hashtags || [])
      .map(tag => (tag.startsWith('#') ? tag : `#${tag}`))
      .join(' ');

    const card = document.createElement('article');
    card.className = 'loor-item';
    card.dataset.loorId = loor.id;

    card.innerHTML = `
      <video class="loor-video" src="${loor.video_url}" ${loor.thumbnail_url ? `poster="${escapeLoorHtml(loor.thumbnail_url)}"` : ''} playsinline loop preload="metadata" ${loor.audio_url ? 'muted' : ''}></video>
      ${loor.audio_url ? `<audio class="loor-audio" src="${escapeLoorHtml(loor.audio_url)}" loop preload="none"></audio>` : ''}
      <div class="loor-pause-indicator">❚❚</div>

      <div class="loor-overlay-wrapper">
        <div class="loor-actions-bar">
          <button class="loor-action-btn btn-like ${isLiked ? 'liked' : ''}" data-id="${loor.id}" aria-label="Me gusta">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
            <span class="loor-action-count like-count">${loorLikes.length}</span>
          </button>

          <button class="loor-action-btn btn-comment" data-id="${loor.id}" aria-label="Comentarios">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
            <span class="loor-action-count comment-count">${commentsCount}</span>
          </button>

          <button class="loor-action-btn btn-save ${isSaved ? 'saved' : ''}" data-id="${loor.id}" aria-label="Guardar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
            <span class="loor-action-count">${isSaved ? 'Guardado' : 'Guardar'}</span>
          </button>

          <button class="loor-action-btn btn-share" data-id="${loor.id}" data-desc="${escapeLoorHtml(loor.description)}" aria-label="Compartir">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
            <span class="loor-action-count">Compartir</span>
          </button>
        </div>

        <div class="loor-info-panel">
          <div class="loor-creator-row">
            <div class="loor-creator-link" data-user-id="${loor.user_id}">
              <img class="loor-avatar" loading="lazy" decoding="async" src="${escapeLoorHtml(creator.avatar_url || '') || LOOR_DEFAULT_AVATAR}" alt="${escapeLoorHtml(creator.username)}" onerror="this.onerror=null;this.src=LOOR_DEFAULT_AVATAR">
              <span class="loor-username">@${escapeLoorHtml(creator.username)}</span>
            </div>
            ${!isOwnVideo ? `
              <button class="loor-follow-btn ${isFollowing ? 'following' : ''}" data-creator-id="${loor.user_id}">
                ${isFollowing ? 'Siguiendo' : 'Seguir'}
              </button>
            ` : ''}
          </div>

          ${loor.description ? `<p class="loor-description">${escapeLoorHtml(loor.description)}</p>` : ''}
          ${hashtagsFormatted ? `<p class="loor-hashtags">${escapeLoorHtml(hashtagsFormatted)}</p>` : ''}

          <div class="loor-meta-row">
            <div class="loor-audio-pill">
              ${loor.audio_link ? `
                <a class="loor-audio-link" href="${escapeLoorHtml(loor.audio_link)}" target="_blank" rel="noopener noreferrer">
                  <span>🎵</span>
                  <span>${escapeLoorHtml(loor.audio_name || 'Audio original')}</span>
                </a>
              ` : `
                <span>🎵</span>
                <span>${escapeLoorHtml(loor.audio_name || 'Audio original')}</span>
              `}
            </div>
            <span class="loor-views-text">👁️ <b class="views-number">${loor.views_count || 0}</b> reproducciones</span>
          </div>
        </div>
      </div>
    `;

    // Pausar / reanudar tocando el video
    const videoEl = card.querySelector('.loor-video');
    // Si el video falla al cargar, se reintenta una vez
    videoEl.addEventListener('error', () => {
      if (videoEl.dataset.retried) return;
      videoEl.dataset.retried = '1';
      setTimeout(() => { videoEl.load(); }, 1200);
    });
    const audioEl = card.querySelector('.loor-audio');
    videoEl.addEventListener('click', () => {
      // Si el video corre pero el audio quedó bloqueado por el iPhone, el primer toque lo activa
      if (audioEl && !videoEl.paused && audioEl.paused) {
        audioEl.play().catch(() => {});
        return;
      }
      if (videoEl.paused) {
        playLoorCard(card);
      } else {
        pauseLoorCard(card);
        card.classList.add('paused');
      }
    });

    // Abrir perfil del creador usando las funciones globales existentes de ÖG
    card.querySelector('.loor-creator-link').addEventListener('click', () => {
      closeLoorsSection();
      if (typeof openPublicProfile === 'function') {
        openPublicProfile(loor.user_id);
      } else if (typeof viewUserProfile === 'function') {
        viewUserProfile(loor.user_id);
      } else if (typeof openUserProfile === 'function') {
        openUserProfile(loor.user_id);
      }
    });

    container.appendChild(card);
    newCards.push(card);
  });

  setupLoorAutoplayObserver(newCards);
}

/* Si ya existe el observador solo se agregan los videos nuevos (al cargar más páginas) */
function setupLoorAutoplayObserver(newCards) {
  const container = document.getElementById('loors-feed-container');
  if (loorVideoObserver && newCards && loorVideoObserver.root === container) {
    newCards.forEach(item => loorVideoObserver.observe(item));
    return;
  }
  if (loorVideoObserver) loorVideoObserver.disconnect();

  loorVideoObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const card = entry.target;
      const video = card.querySelector('.loor-video');
      const loorId = card.dataset.loorId;

      if (entry.isIntersecting) {
        playLoorCard(card);
        const nextVideo = card.nextElementSibling && card.nextElementSibling.querySelector && card.nextElementSibling.querySelector('.loor-video');
        if (nextVideo) nextVideo.preload = 'auto';

        if (!viewedLoorsSession.has(loorId)) {
          viewedLoorsSession.add(loorId);
          incrementLoorViews(loorId, card);
        }
      } else {
        video.pause();
        video.currentTime = 0;
        const audio = card.querySelector('.loor-audio');
        if (audio) {
          audio.pause();
          audio.currentTime = 0;
        }
      }
    });
  }, {
    root: document.getElementById('loors-feed-container'),
    threshold: 0.75
  });

  (newCards || document.querySelectorAll('.loor-item')).forEach(item => loorVideoObserver.observe(item));
}

async function incrementLoorViews(loorId, card) {
  const { error } = await db.rpc('increment_loor_views', { target_loor_id: loorId });
  if (!error) {
    const numEl = card.querySelector('.views-number');
    if (numEl) numEl.textContent = parseInt(numEl.textContent || '0', 10) + 1;
  }
}

function bindLoorsUIEvents() {
  const feed = document.getElementById('loors-feed-container');
  if (!feed) return;

  feed.addEventListener('click', async (e) => {
    // ME GUSTA
    const likeBtn = e.target.closest('.btn-like');
    if (likeBtn) {
      if (!requireLoorAuth()) return;
      const loorId = likeBtn.dataset.id;
      const countEl = likeBtn.querySelector('.like-count');
      const count = parseInt(countEl.textContent, 10);

      if (likeBtn.classList.contains('liked')) {
        likeBtn.classList.remove('liked');
        countEl.textContent = Math.max(0, count - 1);
        await db.from('loor_likes').delete().match({ loor_id: loorId, user_id: currentUser.id });
      } else {
        likeBtn.classList.add('liked');
        countEl.textContent = count + 1;
        await db.from('loor_likes').insert({ loor_id: loorId, user_id: currentUser.id });
      }
      return;
    }

    // FAVORITOS
    const saveBtn = e.target.closest('.btn-save');
    if (saveBtn) {
      if (!requireLoorAuth()) return;
      const loorId = saveBtn.dataset.id;
      const labelEl = saveBtn.querySelector('.loor-action-count');

      if (saveBtn.classList.contains('saved')) {
        saveBtn.classList.remove('saved');
        labelEl.textContent = 'Guardar';
        await db.from('loor_saves').delete().match({ loor_id: loorId, user_id: currentUser.id });
      } else {
        saveBtn.classList.add('saved');
        labelEl.textContent = 'Guardado';
        await db.from('loor_saves').insert({ loor_id: loorId, user_id: currentUser.id });
      }
      return;
    }

    // COMENTARIOS
    const commentBtn = e.target.closest('.btn-comment');
    if (commentBtn) {
      activeLoorIdForComments = commentBtn.dataset.id;
      openLoorCommentsModal(activeLoorIdForComments);
      return;
    }

    // COMPARTIR
    const shareBtn = e.target.closest('.btn-share');
    if (shareBtn) {
      const shareData = {
        title: 'Mirá este Loor en ÖG',
        text: shareBtn.dataset.desc || 'Video en ÖG LOORS',
        url: window.location.origin + '?loor=' + shareBtn.dataset.id
      };
      if (navigator.share) {
        try { await navigator.share(shareData); } catch (_) {}
      } else {
        await navigator.clipboard.writeText(shareData.url);
        if (typeof showToast === 'function') showToast('Enlace copiado');
        else alert('Enlace del Loor copiado al portapapeles');
      }
      return;
    }

    // SEGUIR AL CREADOR
    const followBtn = e.target.closest('.loor-follow-btn');
    if (followBtn) {
      if (!requireLoorAuth()) return;
      const creatorId = followBtn.dataset.creatorId;
      if (followBtn.classList.contains('following')) {
        followBtn.classList.remove('following');
        followBtn.textContent = 'Seguir';
        await db.from('follows').delete().match({ follower_id: currentUser.id, following_id: creatorId });
      } else {
        followBtn.classList.add('following');
        followBtn.textContent = 'Siguiendo';
        await db.from('follows').insert({ follower_id: currentUser.id, following_id: creatorId });
      }
    }
  });

  // Nuevo comentario
  document.getElementById('loor-comment-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!requireLoorAuth() || !activeLoorIdForComments) return;
    const input = document.getElementById('loor-comment-input');
    const content = input.value.trim();
    if (!content) return;

    input.value = '';
    const { error } = await db.from('loor_comments').insert({
      loor_id: activeLoorIdForComments,
      user_id: currentUser.id,
      content
    });

    if (!error) {
      await openLoorCommentsModal(activeLoorIdForComments);
      const countEl = document.querySelector(`.loor-item[data-loor-id="${activeLoorIdForComments}"] .comment-count`);
      if (countEl) countEl.textContent = parseInt(countEl.textContent, 10) + 1;
    }
  });

  // Subir video desde galería
  document.getElementById('loor-upload-form')?.addEventListener('submit', handleUploadLoor);
}

async function openLoorCommentsModal(loorId) {
  const modal = document.getElementById('loors-comments-modal');
  const list = document.getElementById('loor-comments-list');
  modal.classList.add('open');
  list.innerHTML = '<p style="text-align:center;color:#666;">Cargando comentarios...</p>';

  let { data: comments, error: commentsErr } = await db
    .from('loor_comments')
    .select('id, user_id, content, created_at')
    .eq('loor_id', loorId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (commentsErr) {
    ({ data: comments } = await db.from('loor_comments').select('*').eq('loor_id', loorId).order('created_at', { ascending: true }).limit(200));
  }

  if (!comments || comments.length === 0) {
    list.innerHTML = '<p style="text-align:center;color:#888;margin-top:20px;">Aún no hay comentarios.</p>';
    return;
  }

  const userIds = [...new Set(comments.map(c => c.user_id))];
  const { data: profiles } = await db
    .from('og_profiles')
    .select('id, username, avatar_url')
    .in('id', userIds);

  const pMap = new Map((profiles || []).map(p => [p.id, p]));

  list.innerHTML = comments.map(c => {
    const u = pMap.get(c.user_id) || { username: 'usuario', avatar_url: LOOR_DEFAULT_AVATAR };
    return `
      <div class="loor-comment-item">
        <img src="${u.avatar_url || LOOR_DEFAULT_AVATAR}" alt="" loading="lazy" decoding="async">
        <div>
          <strong>@${escapeLoorHtml(u.username)}</strong>
          <p style="margin:2px 0 0;">${escapeLoorHtml(c.content)}</p>
        </div>
      </div>
    `;
  }).join('');
}

/* Saca un cuadro del video (miniatura liviana) para que Explorar no tenga que cargar el video entero */
function makeLoorThumbnail(file) {
  return new Promise(resolve => {
    let done = false;
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const finish = blob => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
      resolve(blob || null);
    };
    const timer = setTimeout(() => finish(null), 8000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onerror = () => { clearTimeout(timer); finish(null); };
    video.onloadedmetadata = () => {
      try { video.currentTime = Math.min(0.4, (video.duration || 1) / 2); } catch (err) { finish(null); }
    };
    video.onseeked = () => {
      try {
        const w = 360;
        const ratio = (video.videoHeight || 640) / (video.videoWidth || 360);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = Math.round(w * ratio);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(b => { clearTimeout(timer); finish(b); }, 'image/jpeg', 0.7);
      } catch (err) { clearTimeout(timer); finish(null); }
    };
    video.src = url;
  });
}

async function handleUploadLoor(e) {
  e.preventDefault();
  if (!requireLoorAuth()) return;

  const file = document.getElementById('loor-video-file').files[0];
  const desc = document.getElementById('loor-desc-input').value.trim();
  const tagsRaw = document.getElementById('loor-hashtags-input').value;
  const audioName = document.getElementById('loor-audio-input').value.trim() || 'Audio original';
  const submitBtn = document.getElementById('loor-upload-submit');

  if (!file) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Subiendo video...';

  try {
    const fileExt = file.name.split('.').pop();
    const filePath = `${currentUser.id}/${Date.now()}.${fileExt}`;

    const { error: uploadError } = await db.storage
      .from('loors_videos')
      .upload(filePath, file, { cacheControl: '31536000', upsert: false });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = db.storage
      .from('loors_videos')
      .getPublicUrl(filePath);

    // Miniatura (si falla, el Loor se publica igual sin ella)
    let thumbnailUrl = null;
    try {
      const thumbBlob = await makeLoorThumbnail(file);
      if (thumbBlob) {
        const thumbPath = `${currentUser.id}/loorthumb-${Date.now()}.jpg`;
        const { error: thumbErr } = await db.storage
          .from('og-media')
          .upload(thumbPath, thumbBlob, { cacheControl: '31536000', upsert: false, contentType: 'image/jpeg' });
        if (!thumbErr) thumbnailUrl = db.storage.from('og-media').getPublicUrl(thumbPath).data.publicUrl;
      }
    } catch (thumbCatch) { console.warn('Sin miniatura:', thumbCatch); }

    const hashtagsArray = tagsRaw
      .split(/[\s,]+/)
      .map(t => t.replace(/^#/, '').trim())
      .filter(Boolean);

    // Audio elegido en la biblioteca (Mis audios o Música libre). Si no hay, se sube como antes.
    const chosenAudio = typeof getSelectedLoorAudio === 'function' ? getSelectedLoorAudio() : null;

    const newLoor = {
      user_id: currentUser.id,
      video_url: publicUrlData.publicUrl,
      description: desc,
      hashtags: hashtagsArray,
      audio_name: chosenAudio ? chosenAudio.title : audioName
    };
    if (chosenAudio) {
      newLoor.audio_url = chosenAudio.url;
      newLoor.audio_link = chosenAudio.link || null;
    }

    let { error: dbError } = await db.from('loors').insert(thumbnailUrl ? { ...newLoor, thumbnail_url: thumbnailUrl } : newLoor);
    // Si la columna thumbnail_url todavía no existe en Supabase, se publica sin ella
    if (dbError && thumbnailUrl) ({ error: dbError } = await db.from('loors').insert(newLoor));

    if (dbError) throw dbError;

    e.target.reset();
    if (typeof clearSelectedLoorAudio === 'function') clearSelectedLoorAudio();
    document.getElementById('loors-upload-modal').classList.remove('open');
    await loadLoorsFeed();
  } catch (err) {
    console.error('Error subiendo Loor:', err);
    alert('Error al subir el video: ' + err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Publicar Loor';
  }
}

function requireLoorAuth() {
  if (!currentUser) {
    if (typeof showAuthOverlay === 'function') showAuthOverlay();
    return false;
  }
  return true;
}

function escapeLoorHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
