/* ==========================================
   FEATURE: NOTAS (texto corto + canción opcional, duran 24 horas)
   Se muestran como una fila arriba de Chat (#notes-row).
   Depende de: db (Supabase), currentUser, myProfile, profilesCache,
   openPublicProfile (profile.js), y de loors.js / audio-library.js
   (escapeLoorHtml, LOOR_DEFAULT_AVATAR, openAudioPicker)
   ========================================== */

const NOTE_MAX_CHARS = 60;
const NOTE_LIFETIME_MS = 24 * 60 * 60 * 1000;
const NOTE_AUDIO_MAX_SECONDS = 30;

let myNote = null;
let otherNotes = [];
let noteProfilesMap = new Map();
let noteDraftAudio = null;
let noteAudioEl = null;
let noteAudioBtn = null;
let viewedNote = null;
let notesInitialized = false;

function initNotes() {
  if (notesInitialized) return;
  notesInitialized = true;

  const page = document.getElementById('messagesPage');
  if (!page) return;

  // Cargar las notas cada vez que se entra a Chat (sin tocar navigation.js)
  let wasActive = page.classList.contains('active');
  const observer = new MutationObserver(() => {
    const nowActive = page.classList.contains('active');
    if (nowActive && !wasActive) loadNotes();
    wasActive = nowActive;
  });
  observer.observe(page, { attributes: true, attributeFilter: ['class'] });

  const row = document.getElementById('notes-row');
  if (row) row.addEventListener('click', onNotesRowClick);

  const input = document.getElementById('note-text-input');
  if (input) input.addEventListener('input', updateNoteCounter);

  if (wasActive) loadNotes();
}

/* ---------- Cargar y mostrar ---------- */

async function loadNotes() {
  const row = document.getElementById('notes-row');
  if (!row || !currentUser) return;

  try {
    const { data, error } = await db
      .from('notes')
      .select('*')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    if (error) throw error;

    const notes = data || [];
    myNote = notes.find(n => n.user_id === currentUser.id) || null;
    otherNotes = notes.filter(n => n.user_id !== currentUser.id);

    const ids = [...new Set(otherNotes.map(n => n.user_id))];
    noteProfilesMap = new Map();
    ids.forEach(id => {
      if (typeof profilesCache !== 'undefined' && profilesCache[id]) noteProfilesMap.set(id, profilesCache[id]);
    });
    const missing = ids.filter(id => !noteProfilesMap.has(id));
    if (missing.length) {
      const { data: profs } = await db
        .from('og_profiles')
        .select('id, username, display_name, avatar_url')
        .in('id', missing);
      (profs || []).forEach(p => noteProfilesMap.set(p.id, p));
    }
  } catch (err) {
    console.error('Error cargando notas:', err);
    myNote = null;
    otherNotes = [];
  }

  renderNotesRow();
}

function noteAvatarHtml(url) {
  const src = escapeLoorHtml(url || '') || LOOR_DEFAULT_AVATAR;
  return `<img class="note-avatar" src="${src}" alt="" onerror="this.onerror=null;this.src=LOOR_DEFAULT_AVATAR">`;
}

function noteBubbleHtml(note) {
  const text = note.content || note.audio_title || '';
  const icon = note.audio_url ? '🎵 ' : '';
  return `<div class="note-bubble">${icon}${escapeLoorHtml(text)}</div>`;
}

function renderNotesRow() {
  const row = document.getElementById('notes-row');
  if (!row) return;

  const myAvatarUrl = (typeof myProfile !== 'undefined' && myProfile && myProfile.avatar_url) || '';
  const myBubble = myNote
    ? noteBubbleHtml(myNote)
    : '<div class="note-bubble note-bubble-empty">Tu nota</div>';

  let html = `
    <div class="note-item" data-note="mine">
      ${myBubble}
      ${noteAvatarHtml(myAvatarUrl)}
      <span class="note-label">${myNote ? 'Tu nota' : 'Añadir'}</span>
    </div>
  `;

  otherNotes.forEach((n, i) => {
    const p = noteProfilesMap.get(n.user_id) || {};
    const name = p.username || 'usuario';
    html += `
      <div class="note-item" data-note="${i}">
        ${noteBubbleHtml(n)}
        ${noteAvatarHtml(p.avatar_url)}
        <span class="note-label">${escapeLoorHtml(name)}</span>
      </div>
    `;
  });

  row.innerHTML = html;
}

function onNotesRowClick(e) {
  const item = e.target.closest('.note-item');
  if (!item) return;
  if (item.dataset.note === 'mine') {
    openNoteComposer();
  } else {
    openNoteViewer(parseInt(item.dataset.note, 10));
  }
}

/* ---------- Crear mi nota ---------- */

function openNoteComposer() {
  const modal = document.getElementById('note-composer-modal');
  const input = document.getElementById('note-text-input');
  if (!modal || !input) return;

  input.value = myNote ? myNote.content : '';
  noteDraftAudio = (myNote && myNote.audio_url)
    ? { title: myNote.audio_title || 'Canción', url: myNote.audio_url, link: myNote.audio_link || null }
    : null;

  const delBtn = document.getElementById('note-delete-btn');
  if (delBtn) delBtn.style.display = myNote ? 'block' : 'none';

  updateNoteCounter();
  renderNoteDraftAudio();
  modal.classList.add('open');
}

function closeNoteComposer() {
  const modal = document.getElementById('note-composer-modal');
  if (modal) modal.classList.remove('open');
}

function updateNoteCounter() {
  const input = document.getElementById('note-text-input');
  const counter = document.getElementById('note-counter');
  if (input && counter) counter.textContent = `${input.value.length}/${NOTE_MAX_CHARS}`;
}

function chooseNoteAudio() {
  openAudioPicker('note');
}

// La llama audio-library.js cuando se elige una canción para la nota
function setNoteAudio(audio) {
  noteDraftAudio = audio;
  renderNoteDraftAudio();
}

function clearNoteAudio() {
  noteDraftAudio = null;
  renderNoteDraftAudio();
}

function renderNoteDraftAudio() {
  const box = document.getElementById('note-audio-selected');
  const name = document.getElementById('note-audio-selected-name');
  const btn = document.getElementById('note-audio-choose-btn');
  if (!box || !name) return;

  if (noteDraftAudio) {
    name.textContent = noteDraftAudio.title;
    box.style.display = 'flex';
    if (btn) btn.textContent = '🎵 Cambiar canción';
  } else {
    name.textContent = '';
    box.style.display = 'none';
    if (btn) btn.textContent = '🎵 Añadir canción';
  }
}

async function publishNote() {
  if (!requireLoorAuth()) return;

  const input = document.getElementById('note-text-input');
  const btn = document.getElementById('note-publish-btn');
  const text = input.value.trim().slice(0, NOTE_MAX_CHARS);

  if (!text && !noteDraftAudio) {
    alert('Escribe algo o añade una canción.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Compartiendo...';

  try {
    const now = Date.now();
    const row = {
      user_id: currentUser.id,
      content: text,
      audio_title: noteDraftAudio ? noteDraftAudio.title : null,
      audio_url: noteDraftAudio ? noteDraftAudio.url : null,
      audio_link: noteDraftAudio ? (noteDraftAudio.link || null) : null,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + NOTE_LIFETIME_MS).toISOString()
    };

    const { error } = await db.from('notes').upsert(row, { onConflict: 'user_id' });
    if (error) throw error;

    closeNoteComposer();
    await loadNotes();
  } catch (err) {
    console.error('Error publicando nota:', err);
    alert('No se pudo compartir la nota: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Compartir';
  }
}

async function deleteMyNote() {
  if (!requireLoorAuth()) return;
  if (!confirm('¿Eliminar tu nota?')) return;

  const { error } = await db.from('notes').delete().eq('user_id', currentUser.id);
  if (error) {
    alert('No se pudo eliminar la nota: ' + error.message);
    return;
  }
  closeNoteComposer();
  await loadNotes();
}

/* ---------- Ver la nota de otra persona ---------- */

function noteTimeAgo(iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  return `hace ${Math.floor(mins / 60)} h`;
}

function openNoteViewer(index) {
  const note = otherNotes[index];
  const modal = document.getElementById('note-viewer-modal');
  const body = document.getElementById('note-viewer-body');
  const title = document.getElementById('note-viewer-user');
  if (!note || !modal || !body) return;

  viewedNote = note;
  const p = noteProfilesMap.get(note.user_id) || {};
  const name = p.username || 'usuario';
  title.textContent = '@' + name;

  const audioBlock = note.audio_url ? `
    <div class="note-viewer-audio">
      <button type="button" class="audio-icon-btn" id="note-viewer-play" onclick="toggleNoteAudio()" aria-label="Escuchar">▶</button>
      <div class="audio-item-info">
        <div class="audio-item-title">${escapeLoorHtml(note.audio_title || 'Canción')}</div>
        ${note.audio_link ? `<a class="note-viewer-link" href="${escapeLoorHtml(note.audio_link)}" target="_blank" rel="noopener noreferrer">Ver la canción</a>` : ''}
      </div>
    </div>
  ` : '';

  body.innerHTML = `
    <div class="note-viewer-head">
      ${noteAvatarHtml(p.avatar_url)}
      <div>
        <div class="note-viewer-name">@${escapeLoorHtml(name)}</div>
        <div class="note-viewer-time">${noteTimeAgo(note.created_at)}</div>
      </div>
    </div>
    ${note.content ? `<p class="note-viewer-text">${escapeLoorHtml(note.content)}</p>` : ''}
    ${audioBlock}
    <button type="button" class="loor-submit-btn note-viewer-profile-btn" onclick="viewNoteAuthorProfile()">Ver perfil</button>
  `;

  modal.classList.add('open');
}

function closeNoteViewer() {
  stopNoteAudio();
  const modal = document.getElementById('note-viewer-modal');
  if (modal) modal.classList.remove('open');
  viewedNote = null;
}

function viewNoteAuthorProfile() {
  if (!viewedNote) return;
  const userId = viewedNote.user_id;
  closeNoteViewer();
  if (typeof openPublicProfile === 'function') openPublicProfile(userId);
}

function toggleNoteAudio() {
  const btn = document.getElementById('note-viewer-play');
  if (!viewedNote || !viewedNote.audio_url || !btn) return;

  if (noteAudioEl && noteAudioBtn === btn && !noteAudioEl.paused) {
    stopNoteAudio();
    return;
  }
  stopNoteAudio();

  const el = new Audio(viewedNote.audio_url);
  noteAudioEl = el;
  noteAudioBtn = btn;
  btn.textContent = '❚❚';

  // Como en Instagram, la canción de una nota suena un máximo de 30 segundos
  el.addEventListener('timeupdate', () => {
    if (el.currentTime >= NOTE_AUDIO_MAX_SECONDS) stopNoteAudio();
  });
  el.addEventListener('ended', stopNoteAudio);
  el.addEventListener('error', stopNoteAudio);
  el.play().catch(() => stopNoteAudio());
}

function stopNoteAudio() {
  const el = noteAudioEl;
  const btn = noteAudioBtn;
  noteAudioEl = null;
  noteAudioBtn = null;
  if (el) {
    el.pause();
    el.removeAttribute('src');
    el.load();
  }
  if (btn) btn.textContent = '▶';
}

initNotes();
