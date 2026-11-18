/* Compartir un Loor por mensaje directo.
   Depende de: config.js (db); state.js (currentUser, profilesCache); utils.js (createAvatarNode, setCachedProfile,
   ogCache, PROFILE_MINI_FIELDS); chat.js (encodeChatPayload, MESSAGE_SELECT_FIELDS, loadConversations,
   cachedConversationsList, prefetchedMessagesByConv); loors.js (openLoorsSection).
   El Loor viaja como un mensaje normal: content = prefijo invisible + JSON { t:'loor', id, th, v, un, d, x }.
   `x` es el texto que escribe quien comparte. */

let loorShareData = null;
let loorShareSelected = new Map();   // userId -> profile
let loorShareSearchTimer = null;
let loorShareSending = false;

function loorShareEls() {
  return {
    backdrop: document.getElementById('loor-share-backdrop'),
    list: document.getElementById('loor-share-list'),
    search: document.getElementById('loor-share-search'),
    text: document.getElementById('loor-share-text'),
    send: document.getElementById('loor-share-send'),
    status: document.getElementById('loor-share-status')
  };
}

function openLoorShareSheet(data) {
  if (!currentUser) { if (typeof showAuthOverlay === 'function') showAuthOverlay(); return; }
  loorShareData = data;
  loorShareSelected = new Map();
  loorShareSending = false;
  const els = loorShareEls();
  if (!els.backdrop) return;
  els.search.value = '';
  els.text.value = '';
  els.status.textContent = '';
  els.backdrop.classList.add('open');
  updateLoorShareSendBtn();
  renderLoorShareContacts();
}

function closeLoorShareSheet() {
  const els = loorShareEls();
  if (els.backdrop) els.backdrop.classList.remove('open');
  loorShareData = null;
}

async function getLoorShareContacts() {
  let list = (typeof cachedConversationsList !== 'undefined' && Array.isArray(cachedConversationsList) && cachedConversationsList.length)
    ? cachedConversationsList : (ogCache.get('conversations', 1000 * 60 * 60 * 12) || []);
  if (!list.length && typeof loadConversations === 'function') {
    try { await loadConversations(); } catch (_) {}
    list = (typeof cachedConversationsList !== 'undefined' && Array.isArray(cachedConversationsList)) ? cachedConversationsList : [];
  }
  // Orden: los que hablamos más recientemente primero
  return list.map(c => c.profile).filter(p => p && p.id && p.id !== currentUser.id);
}

async function renderLoorShareContacts() {
  const { list } = loorShareEls();
  list.innerHTML = '<p class="loor-share-empty">Cargando…</p>';
  const contacts = await getLoorShareContacts();
  if (!loorShareData) return;
  if (!contacts.length) {
    list.innerHTML = '<p class="loor-share-empty">Todavía no tenés conversaciones. Buscá a alguien por su usuario.</p>';
    return;
  }
  renderLoorShareRows(contacts);
}

function renderLoorShareRows(profiles) {
  const { list } = loorShareEls();
  const frag = document.createDocumentFragment();
  profiles.forEach(profile => {
    const row = document.createElement('div');
    row.className = 'loor-share-row' + (loorShareSelected.has(profile.id) ? ' selected' : '');
    row.dataset.userId = profile.id;

    const av = createAvatarNode(profile, false);
    av.classList.add('loor-share-avatar');

    const info = document.createElement('div');
    info.className = 'loor-share-info';
    const name = document.createElement('strong');
    name.textContent = profile.username || profile.display_name;
    const user = document.createElement('small');
    user.textContent = '@' + profile.username;
    info.append(name, user);

    const check = document.createElement('span');
    check.className = 'loor-share-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '✓';

    row.append(av, info, check);
    row.addEventListener('click', () => {
      if (loorShareSending) return;
      if (loorShareSelected.has(profile.id)) {
        loorShareSelected.delete(profile.id);
        row.classList.remove('selected');
      } else {
        loorShareSelected.set(profile.id, profile);
        row.classList.add('selected');
      }
      updateLoorShareSendBtn();
    });
    frag.append(row);
  });
  list.replaceChildren(frag);
}

function updateLoorShareSendBtn() {
  const { send } = loorShareEls();
  const n = loorShareSelected.size;
  send.disabled = n === 0 || loorShareSending;
  send.textContent = loorShareSending ? 'Enviando…' : (n > 1 ? `Enviar (${n})` : 'Enviar');
}

function onLoorShareSearch() {
  clearTimeout(loorShareSearchTimer);
  const { search, list } = loorShareEls();
  const val = search.value.trim();
  if (val.length < 2) { renderLoorShareContacts(); return; }
  loorShareSearchTimer = setTimeout(async () => {
    const safe = val.replace(/[%_,()]/g, '');
    const { data } = await db.from('og_profiles').select(PROFILE_MINI_FIELDS)
      .ilike('username', '%' + safe + '%').limit(15);
    if (!loorShareData) return;
    const results = (data || []).filter(p => p.id !== currentUser.id);
    results.forEach(p => setCachedProfile(p, false));
    if (!results.length) { list.innerHTML = '<p class="loor-share-empty">No se encontraron usuarios.</p>'; return; }
    renderLoorShareRows(results);
  }, 220);
}

async function sendLoorToUser(userId, loor, text) {
  const { data: convId, error: convErr } = await db.rpc('get_or_create_conversation', { user_a: currentUser.id, user_b: userId });
  if (convErr || !convId) throw convErr || new Error('No se pudo abrir la conversación');

  const meta = { t: 'loor', id: loor.id, un: loor.username || '', d: (loor.desc || '').slice(0, 140) };
  if (loor.thumb) meta.th = loor.thumb;
  if (loor.video) meta.v = loor.video;
  if (text) meta.x = text;

  const res = await db.from('messages')
    .insert({ conversation_id: convId, sender_id: currentUser.id, content: encodeChatPayload(meta) })
    .select(MESSAGE_SELECT_FIELDS).single();
  if (res.error) throw res.error;

  // Que la próxima vez que se abra ese chat se vuelva a pedir con el mensaje nuevo
  try { delete prefetchedMessagesByConv[convId]; } catch (_) {}
  ogCache.remove('chat_msgs_' + convId);
  return res.data;
}

async function submitLoorShare() {
  if (loorShareSending || !loorShareData || !loorShareSelected.size) return;
  loorShareSending = true;
  updateLoorShareSendBtn();
  const els = loorShareEls();
  els.status.textContent = '';
  const text = els.text.value.trim().slice(0, 500);
  const loor = loorShareData;

  const targets = [...loorShareSelected.keys()];
  const results = await Promise.allSettled(targets.map(id => sendLoorToUser(id, loor, text)));
  const failed = targets.filter((id, i) => results[i].status === 'rejected');
  loorShareSending = false;

  if (typeof cachedConversationsList !== 'undefined') cachedConversationsList = null;
  ogCache.remove('conversations');
  if (typeof ogPlaySound === 'function' && failed.length < targets.length) ogPlaySound('send');

  if (!failed.length) {
    closeLoorShareSheet();
    if (typeof showToast === 'function') showToast(targets.length > 1 ? 'Loor enviado' : 'Loor enviado');
    return;
  }
  // Se quedan marcados solo los que fallaron para reintentar
  loorShareSelected = new Map([...loorShareSelected].filter(([id]) => failed.includes(id)));
  document.querySelectorAll('#loor-share-list .loor-share-row').forEach(r => {
    r.classList.toggle('selected', loorShareSelected.has(r.dataset.userId));
  });
  els.status.textContent = 'No se pudo enviar a ' + failed.length + ' persona(s). Probá de nuevo.';
  updateLoorShareSendBtn();
}

async function shareLoorExternally() {
  const d = loorShareData;
  if (!d) return;
  const shareData = { title: 'Mirá este Loor en ÖG', text: d.desc || 'Video en ÖG LOORS', url: window.location.origin + '?loor=' + d.id };
  if (navigator.share) {
    try { await navigator.share(shareData); } catch (_) {}
  } else {
    try { await navigator.clipboard.writeText(shareData.url); } catch (_) {}
    if (typeof showToast === 'function') showToast('Enlace copiado');
    else alert('Enlace del Loor copiado al portapapeles');
  }
}

/* Al tocar un Loor dentro del chat: se abre en Loors (arranca por ese video) */
function openLoorFromChat(loorId) {
  if (!loorId) return;
  const nav = document.getElementById('bottomNavBar');
  if (nav) { nav.style.display = 'flex'; nav.classList.remove('nav-hidden'); }
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('nav-loors-btn')?.classList.add('active');
  if (typeof openLoorsSection === 'function') openLoorsSection(loorId);
}
