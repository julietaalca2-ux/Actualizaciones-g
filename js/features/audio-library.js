/* ==========================================
   FEATURE: BIBLIOTECA DE AUDIOS (para Loors)
   - "Mis audios": audios que sube cada usuario (Supabase Storage, bucket og_audios)
   - "Música libre": canciones con licencia Creative Commons de Jamendo
   Depende de: db (Supabase), currentUser, y de loors.js (requireLoorAuth, escapeLoorHtml)
   ========================================== */

// Pega aquí tu Client ID gratuito de https://devportal.jamendo.com
// (entre las comillas, reemplazando el texto PEGAR_AQUI_TU_CLIENT_ID)
const JAMENDO_CLIENT_ID = 'PEGAR_AQUI_TU_CLIENT_ID';
const JAMENDO_TRACKS_URL = 'https://api.jamendo.com/v3.0/tracks/';
const OWN_AUDIO_MAX_BYTES = 20 * 1024 * 1024; // 20 MB, igual que el bucket og_audios

let selectedLoorAudio = null;
let audioPickerTarget = 'loor'; // 'loor' = audio de un Loor, 'note' = canción de una nota, 'post' = música de una publicación
let audioPreviewEl = null;
let audioPreviewBtn = null;
let audioPickerBound = false;
let ownAudiosCache = [];
let freeTracksCache = [];

/* ---------- Audio elegido para el Loor que se está subiendo ---------- */

function getSelectedLoorAudio() {
  return selectedLoorAudio;
}

function clearSelectedLoorAudio() {
  selectedLoorAudio = null;
  renderSelectedLoorAudio();
}

function renderSelectedLoorAudio() {
  const box = document.getElementById('loor-audio-selected');
  const name = document.getElementById('loor-audio-selected-name');
  const btn = document.getElementById('loor-audio-choose-btn');
  if (!box || !name) return;

  if (selectedLoorAudio) {
    name.textContent = selectedLoorAudio.title;
    box.style.display = 'flex';
    if (btn) btn.textContent = '🎵 Cambiar audio';
  } else {
    name.textContent = '';
    box.style.display = 'none';
    if (btn) btn.textContent = '🎵 Elegir audio';
  }
}

function selectLoorAudio(audio) {
  if (audioPickerTarget === 'note') {
    // La canción es para una nota (notes.js)
    if (typeof setNoteAudio === 'function') setNoteAudio(audio);
  } else if (audioPickerTarget === 'post') {
    // La música es para una publicación (feed.js)
    if (typeof setPostAudio === 'function') setPostAudio(audio);
  } else {
    selectedLoorAudio = audio;
    renderSelectedLoorAudio();
  }
  closeAudioPicker();
}

/* ---------- Ventana para elegir audio ---------- */

function openAudioPicker(target) {
  if (!requireLoorAuth()) return;
  audioPickerTarget = target === 'note' ? 'note' : (target === 'post' ? 'post' : 'loor');
  bindAudioPicker();
  document.getElementById('audio-picker-modal').classList.add('open');
  switchAudioTab('own');
}

function closeAudioPicker() {
  stopAudioPreview();
  const modal = document.getElementById('audio-picker-modal');
  if (modal) modal.classList.remove('open');
}

function switchAudioTab(tab) {
  stopAudioPreview();
  const isOwn = tab === 'own';
  document.getElementById('audio-tab-own').classList.toggle('active', isOwn);
  document.getElementById('audio-tab-free').classList.toggle('active', !isOwn);
  document.getElementById('audio-panel-own').style.display = isOwn ? 'block' : 'none';
  document.getElementById('audio-panel-free').style.display = isOwn ? 'none' : 'block';

  if (isOwn) {
    loadOwnAudios();
  } else if (freeTracksCache.length === 0) {
    searchFreeMusic('');
  }
}

function bindAudioPicker() {
  if (audioPickerBound) return;
  audioPickerBound = true;

  const uploadForm = document.getElementById('audio-upload-form');
  if (uploadForm) uploadForm.addEventListener('submit', handleUploadOwnAudio);

  const searchForm = document.getElementById('audio-search-form');
  if (searchForm) {
    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      searchFreeMusic(document.getElementById('audio-search-input').value.trim());
    });
  }

  const ownList = document.getElementById('audio-own-list');
  if (ownList) ownList.addEventListener('click', onOwnAudioListClick);

  const freeList = document.getElementById('audio-free-list');
  if (freeList) freeList.addEventListener('click', onFreeAudioListClick);
}

/* ---------- Escuchar antes de elegir ---------- */

function toggleAudioPreview(url, btn) {
  if (audioPreviewEl && audioPreviewBtn === btn && !audioPreviewEl.paused) {
    stopAudioPreview();
    return;
  }
  stopAudioPreview();

  const el = new Audio(url);
  audioPreviewEl = el;
  audioPreviewBtn = btn;
  btn.textContent = '❚❚';

  el.addEventListener('ended', stopAudioPreview);
  el.addEventListener('error', stopAudioPreview);
  el.play().catch(() => stopAudioPreview());
}

function stopAudioPreview() {
  const el = audioPreviewEl;
  const btn = audioPreviewBtn;
  audioPreviewEl = null;
  audioPreviewBtn = null;
  if (el) {
    el.pause();
    el.removeAttribute('src');
    el.load();
  }
  if (btn) btn.textContent = '▶';
}

/* ---------- Mis audios ---------- */

async function loadOwnAudios() {
  const list = document.getElementById('audio-own-list');
  if (!list || !currentUser) return;

  list.innerHTML = '<p class="audio-empty">Cargando...</p>';

  const { data, error } = await db
    .from('audios')
    .select('id, title, audio_url, created_at')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error cargando mis audios:', error);
    list.innerHTML = '<p class="audio-empty">No se pudieron cargar tus audios.</p>';
    return;
  }

  ownAudiosCache = data || [];

  if (ownAudiosCache.length === 0) {
    list.innerHTML = '<p class="audio-empty">Aún no guardaste audios. Sube el primero arriba.</p>';
    return;
  }

  list.innerHTML = ownAudiosCache.map((a, i) => `
    <div class="audio-item" data-index="${i}">
      <button type="button" class="audio-icon-btn" data-action="preview" aria-label="Escuchar">▶</button>
      <div class="audio-item-info">
        <div class="audio-item-title">${escapeLoorHtml(a.title)}</div>
        <div class="audio-item-sub">Audio propio</div>
      </div>
      <button type="button" class="audio-use-btn" data-action="use">Usar</button>
      <button type="button" class="audio-icon-btn" data-action="remove" aria-label="Quitar de mi lista">🗑</button>
    </div>
  `).join('');
}

function onOwnAudioListClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const item = btn.closest('.audio-item');
  const audio = item ? ownAudiosCache[parseInt(item.dataset.index, 10)] : null;
  if (!audio) return;

  if (btn.dataset.action === 'preview') {
    toggleAudioPreview(audio.audio_url, btn);
  } else if (btn.dataset.action === 'use') {
    selectLoorAudio({ title: audio.title, url: audio.audio_url, link: null });
  } else if (btn.dataset.action === 'remove') {
    removeOwnAudio(audio);
  }
}

async function removeOwnAudio(audio) {
  if (!confirm('¿Quitar este audio de tu lista? Los Loors que ya lo usan no se afectan.')) return;
  const { error } = await db
    .from('audios')
    .delete()
    .eq('id', audio.id)
    .eq('user_id', currentUser.id);
  if (error) {
    alert('No se pudo quitar el audio: ' + error.message);
    return;
  }
  loadOwnAudios();
}

/* El bucket solo acepta audio/*. Un .mp4 / .mov (video) se guarda como audio/mp4:
   el navegador reproduce su pista de sonido igual. */
function audioUploadMime(file, ext) {
  const t = (file.type || '').toLowerCase();
  if (t.startsWith('audio/')) return t;
  const byExt = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', mov: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm' };
  return byExt[ext] || 'audio/mp4';
}

async function handleUploadOwnAudio(e) {
  e.preventDefault();
  if (!requireLoorAuth()) return;

  const fileInput = document.getElementById('audio-file-input');
  const titleInput = document.getElementById('audio-title-input');
  const submitBtn = document.getElementById('audio-upload-submit');
  const file = fileInput.files[0];
  if (!file) return;

  if (file.size > OWN_AUDIO_MAX_BYTES) {
    alert('El audio pesa más de 20 MB. Elige uno más corto.');
    return;
  }

  const title = titleInput.value.trim()
    || file.name.replace(/\.[^.]+$/, '').slice(0, 60)
    || 'Mi audio';

  submitBtn.disabled = true;
  submitBtn.textContent = 'Subiendo audio...';

  let usedMime = '';
  try {
    const ext = (file.name.split('.').pop() || 'm4a').toLowerCase().replace(/[^a-z0-9]/g, '') || 'm4a';
    const path = `${currentUser.id}/${Date.now()}.${ext}`;

    // Se sube como bytes (ArrayBuffer): así el tipo lo decide SOLO contentType (audio/...),
    // y no el tipo del archivo original (video/mp4), que Supabase usaría si se enviara el File directo.
    const bytes = await file.arrayBuffer();
    const baseMime = audioUploadMime(file, ext);
    const mimeTries = [baseMime, 'audio/x-m4a', 'audio/mpeg'].filter((m, i, arr) => arr.indexOf(m) === i);

    let uploadError = null;
    usedMime = baseMime;
    for (const mime of mimeTries) {
      usedMime = mime;
      const res = await db.storage.from('og_audios').upload(path, bytes, {
        cacheControl: '3600',
        upsert: false,
        contentType: mime
      });
      uploadError = res.error;
      // Solo se reintenta con otro tipo si el error es de tipo de archivo no permitido
      if (!uploadError || !/mime/i.test(uploadError.message || '')) break;
    }
    if (uploadError) throw uploadError;

    const { data: publicUrlData } = db.storage.from('og_audios').getPublicUrl(path);

    const { error: dbError } = await db.from('audios').insert({
      user_id: currentUser.id,
      title,
      audio_url: publicUrlData.publicUrl
    });
    if (dbError) throw dbError;

    e.target.reset();
    await loadOwnAudios();
  } catch (err) {
    console.error('Error subiendo audio:', err);
    alert('Error al subir el audio (' + (usedMime || 'sin tipo') + '): ' + err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Guardar audio';
  }
}

/* ---------- Música libre (Jamendo) ---------- */

async function searchFreeMusic(query) {
  const list = document.getElementById('audio-free-list');
  if (!list) return;

  if (!JAMENDO_CLIENT_ID || JAMENDO_CLIENT_ID.indexOf('PEGAR') === 0) {
    list.innerHTML = '<p class="audio-empty">Falta conectar Jamendo. Mientras tanto puedes usar "Mis audios".</p>';
    return;
  }

  list.innerHTML = '<p class="audio-empty">Buscando...</p>';

  try {
    const params = new URLSearchParams({
      client_id: JAMENDO_CLIENT_ID,
      format: 'json',
      limit: '20',
      imagesize: '100'
    });
    if (query) {
      params.set('search', query);
      params.set('order', 'relevance');
    } else {
      params.set('order', 'popularity_week');
    }

    const res = await fetch(JAMENDO_TRACKS_URL + '?' + params.toString());
    const json = await res.json();

    if (!json.headers || json.headers.status !== 'success') {
      throw new Error((json.headers && json.headers.error_message) || 'Respuesta inesperada de Jamendo');
    }

    freeTracksCache = (json.results || []).filter(t => t && t.audio);

    if (freeTracksCache.length === 0) {
      list.innerHTML = '<p class="audio-empty">No encontramos canciones. Prueba con otra búsqueda.</p>';
      return;
    }

    list.innerHTML = freeTracksCache.map((t, i) => `
      <div class="audio-item" data-index="${i}">
        <button type="button" class="audio-icon-btn" data-action="preview" aria-label="Escuchar">▶</button>
        <div class="audio-item-info">
          <div class="audio-item-title">${escapeLoorHtml(t.name)}</div>
          <div class="audio-item-sub">${escapeLoorHtml(t.artist_name)}</div>
        </div>
        <button type="button" class="audio-use-btn" data-action="use">Usar</button>
      </div>
    `).join('');
  } catch (err) {
    console.error('Error buscando música en Jamendo:', err);
    list.innerHTML = '<p class="audio-empty">No se pudo conectar con Jamendo. Inténtalo de nuevo en un rato.</p>';
  }
}

function onFreeAudioListClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const item = btn.closest('.audio-item');
  const track = item ? freeTracksCache[parseInt(item.dataset.index, 10)] : null;
  if (!track) return;

  if (btn.dataset.action === 'preview') {
    toggleAudioPreview(track.audio, btn);
  } else if (btn.dataset.action === 'use') {
    selectLoorAudio({
      title: `${track.name} — ${track.artist_name} (Jamendo)`,
      url: track.audio,
      link: track.shareurl || track.shorturl || `https://www.jamendo.com/track/${track.id}`
    });
  }
}
