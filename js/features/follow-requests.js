/* ÖG — Cuenta privada y solicitudes de seguidor
   Depende de: config.js (db); state.js (currentUser, profilesCache, cachedActivityEvents);
   utils.js (ogCache, setCachedProfile, PROFILE_MINI_FIELDS);
   notifications.js (ogShowBanner); sounds.js (ogPlaySound)
   Requiere haber ejecutado supabase/02_cuenta_privada_y_solicitudes.sql
   Expone: ogRequestFollow, ogCancelFollowRequest, ogHasPendingRequest, ogIsProfilePrivate,
   ogApplyPrivateGate, ogSyncPrivateAccount, ogLoadPrivateFromServer, ogOpenFollowRequests,
   ogCloseFollowRequests, ogFetchPendingRequests, ogRespondFollowRequest */

let ogFollowRequested = false;     // ¿ya pedí seguir al perfil que estoy mirando?
let ogPrivateServerValue = null;   // valor real de "cuenta privada" guardado en el servidor
let ogPendingRequests = [];        // solicitudes pendientes que recibí
const ogApprovedRecently = new Set(); // evita avisarme "empezó a seguirte" por mi propia aprobación
let ogSuppressFollowUntil = 0;

function ogShouldSuppressFollowNotif(userId) {
  return ogApprovedRecently.has(userId) || Date.now() < ogSuppressFollowUntil;
}

/* ---------- Seguir / solicitar ---------- */

// Devuelve 'following' | 'requested' | 'error'
async function ogRequestFollow(targetId) {
  if (!currentUser || !targetId) return 'error';
  try {
    const { data, error } = await db.rpc('request_follow', { p_target: targetId });
    if (!error) return data === 'requested' ? 'requested' : 'following';

    // El SQL todavía no se ejecutó: se comporta como antes (seguir directo)
    if (error.code === 'PGRST202' || /request_follow/i.test(error.message || '')) {
      const ins = await db.from('follows').insert({ follower_id: currentUser.id, following_id: targetId });
      return ins.error ? 'error' : 'following';
    }
    console.warn('No se pudo seguir:', error);
    return 'error';
  } catch (e) {
    console.warn('No se pudo seguir:', e);
    return 'error';
  }
}

// Cancela una solicitud pendiente o limpia la ya aceptada (al dejar de seguir)
async function ogCancelFollowRequest(targetId) {
  if (!currentUser || !targetId) return;
  try {
    await db.from('follow_requests').delete()
      .eq('requester_id', currentUser.id).eq('target_id', targetId);
  } catch (e) {}
}

async function ogHasPendingRequest(targetId) {
  if (!currentUser || !targetId) return false;
  try {
    const { data, error } = await db.from('follow_requests').select('status')
      .eq('requester_id', currentUser.id).eq('target_id', targetId).eq('status', 'pending').maybeSingle();
    return !error && !!data;
  } catch (e) { return false; }
}

async function ogIsProfilePrivate(userId) {
  if (!userId) return false;
  try {
    const { data, error } = await db.from('og_profiles').select('is_private').eq('id', userId).maybeSingle();
    return !error && !!data?.is_private;
  } catch (e) { return false; }
}

/* En perfiles privados, quien no es seguidor aprobado ve un candado en vez del contenido */
async function ogApplyPrivateGate(userId) {
  const grid = document.getElementById('publicposts');
  if (!grid) return;
  let notice = document.getElementById('publicPrivateNotice');
  const hideEls = [grid, document.getElementById('publicHighlightsScrollContainer')].filter(Boolean);

  const priv = userId && currentUser && userId !== currentUser.id ? await ogIsProfilePrivate(userId) : false;
  // El perfil mostrado pudo cambiar mientras se consultaba
  if (viewedProfile && viewedProfile.id !== userId) return;

  if (priv && !isFollowing) {
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'publicPrivateNotice';
      notice.className = 'private-notice';
      grid.parentNode.insertBefore(notice, grid);
    }
    notice.innerHTML = '<div class="private-notice-lock">🔒</div>' +
      '<strong>Esta cuenta es privada</strong>' +
      '<span>Seguila para ver sus publicaciones e historias.</span>';
    notice.style.display = 'flex';
    hideEls.forEach(el => { el.style.display = 'none'; });
  } else {
    if (notice) notice.style.display = 'none';
    hideEls.forEach(el => { el.style.display = ''; });
  }
}

/* ---------- Ajuste "Cuenta privada" (guardado en el servidor) ---------- */

async function ogLoadPrivateFromServer() {
  if (!currentUser) return;
  try {
    const { data, error } = await db.from('og_profiles').select('is_private').eq('id', currentUser.id).maybeSingle();
    if (error || !data) return;
    ogPrivateServerValue = !!data.is_private;
    const el = document.getElementById('privateAccountToggle');
    if (el) el.checked = ogPrivateServerValue;
  } catch (e) {}
}

async function ogSyncPrivateAccount() {
  const el = document.getElementById('privateAccountToggle');
  if (!el || !currentUser) return;
  const want = el.checked;
  if (ogPrivateServerValue === want) return;

  const { error } = await db.rpc('set_account_private', { p_private: want });
  if (error) {
    el.checked = !!ogPrivateServerValue;
    try {
      const raw = localStorage.getItem('og_user_settings_' + currentUser.id);
      const prefs = raw ? JSON.parse(raw) : {};
      prefs.privateAccount = !!ogPrivateServerValue;
      localStorage.setItem('og_user_settings_' + currentUser.id, JSON.stringify(prefs));
    } catch (e) {}
    if (typeof ogShowBanner === 'function') {
      ogShowBanner({ title: 'No se pudo cambiar', body: 'Falta ejecutar supabase/02_cuenta_privada_y_solicitudes.sql en Supabase.' });
    }
    return;
  }

  ogPrivateServerValue = want;
  if (typeof ogShowBanner === 'function') {
    ogShowBanner(want
      ? { title: 'Cuenta privada', body: 'Solo las personas que aprobés podrán seguirte.' }
      : { title: 'Cuenta pública', body: 'Ahora cualquiera puede seguirte. Las solicitudes pendientes se aceptaron.' });
  }
  if (!want) { ogSuppressFollowUntil = Date.now() + 10000; ogInvalidateAfterRequestChange(); }
}

/* ---------- Solicitudes recibidas ---------- */

async function ogFetchPendingRequests() {
  if (!currentUser) return [];
  try {
    const { data, error } = await db.from('follow_requests')
      .select('requester_id, created_at')
      .eq('target_id', currentUser.id).eq('status', 'pending')
      .order('created_at', { ascending: false }).limit(100);
    if (error) return [];
    ogPendingRequests = data || [];
  } catch (e) { ogPendingRequests = []; }
  await ogEnsureProfiles(ogPendingRequests.map(r => r.requester_id));
  return ogPendingRequests;
}

async function ogEnsureProfiles(ids) {
  const missing = [...new Set(ids.filter(Boolean))].filter(id => !profilesCache[id]);
  if (!missing.length) return;
  try {
    const { data } = await db.from('og_profiles').select(PROFILE_MINI_FIELDS).in('id', missing);
    (data || []).forEach(p => setCachedProfile(p, false));
  } catch (e) {}
}

async function ogRespondFollowRequest(requesterId, accept) {
  try {
    const { error } = await db.rpc('respond_follow_request', { p_requester: requesterId, p_accept: !!accept });
    return !error;
  } catch (e) { return false; }
}

function ogInvalidateAfterRequestChange() {
  cachedActivityEvents = null;
  try { ogCache.remove('activity_events'); } catch (e) {}
  if (typeof loadFollowCounts === 'function') loadFollowCounts();
  if (typeof loadStoriesData === 'function') loadStoriesData();
}

/* ---------- Pantalla "Solicitudes de seguidores" ---------- */

function ogRequestAvatar(profile) {
  const av = document.createElement('div');
  av.className = 'fr-avatar';
  if (profile?.avatar_url) {
    const img = document.createElement('img');
    img.src = profile.avatar_url; img.alt = ''; img.loading = 'lazy';
    av.append(img);
  } else {
    av.textContent = (profile?.username || '?').charAt(0).toUpperCase();
  }
  return av;
}

function ogRenderFollowRequests() {
  const list = document.getElementById('followRequestsList');
  if (!list) return;

  if (!ogPendingRequests.length) {
    list.innerHTML = '<div class="fr-empty"><div class="fr-empty-icon">👥</div>' +
      '<strong>No tenés solicitudes pendientes</strong>' +
      '<span>Cuando alguien pida seguirte, vas a poder aprobarlo desde acá.</span></div>';
    return;
  }

  const frag = document.createDocumentFragment();
  ogPendingRequests.forEach(req => {
    const profile = profilesCache[req.requester_id];
    if (!profile) return;

    const row = document.createElement('div');
    row.className = 'fr-row';
    row.dataset.requester = req.requester_id;

    const who = document.createElement('div');
    who.className = 'fr-who';
    who.append(ogRequestAvatar(profile));
    const names = document.createElement('div');
    names.className = 'fr-names';
    const u = document.createElement('div'); u.className = 'fr-username'; u.textContent = profile.username || 'usuario';
    names.append(u);
    if (profile.display_name && profile.display_name !== profile.username) {
      const d = document.createElement('div'); d.className = 'fr-display'; d.textContent = profile.display_name;
      names.append(d);
    }
    who.append(names);
    who.onclick = () => { ogCloseFollowRequests(); openPublicProfile(profile.id); };

    const actions = document.createElement('div');
    actions.className = 'fr-actions';
    const ok = document.createElement('button');
    ok.type = 'button'; ok.className = 'fr-btn fr-confirm'; ok.textContent = 'Confirmar';
    const no = document.createElement('button');
    no.type = 'button'; no.className = 'fr-btn fr-delete'; no.textContent = 'Eliminar';
    ok.onclick = () => ogAnswerRequest(req.requester_id, true, row);
    no.onclick = () => ogAnswerRequest(req.requester_id, false, row);
    actions.append(ok, no);

    row.append(who, actions);
    frag.append(row);
  });
  list.replaceChildren(frag);
}

async function ogAnswerRequest(requesterId, accept, row) {
  const buttons = row.querySelectorAll('button');
  buttons.forEach(b => { b.disabled = true; });
  row.classList.add('is-busy');

  const ok = await ogRespondFollowRequest(requesterId, accept);
  if (!ok) {
    buttons.forEach(b => { b.disabled = false; });
    row.classList.remove('is-busy');
    if (typeof ogShowBanner === 'function') ogShowBanner({ title: 'No se pudo completar', body: 'Revisá tu conexión e intentá de nuevo.' });
    return;
  }

  if (accept) {
    ogPlaySound('pop');
    ogApprovedRecently.add(requesterId);
    setTimeout(() => ogApprovedRecently.delete(requesterId), 10000);
  }
  ogPendingRequests = ogPendingRequests.filter(r => r.requester_id !== requesterId);
  row.classList.add('is-leaving');
  setTimeout(() => { row.remove(); if (!ogPendingRequests.length) ogRenderFollowRequests(); }, 220);

  ogInvalidateAfterRequestChange();
  if (typeof ogUpdateRequestsRow === 'function') ogUpdateRequestsRow();
}

async function ogOpenFollowRequests() {
  const view = document.getElementById('followRequestsView');
  if (!view) return;
  view.classList.add('active');
  document.body.classList.add('fr-open');
  // Se pinta al instante con lo que ya se conoce y se actualiza después
  if (ogPendingRequests.length) ogRenderFollowRequests();
  else document.getElementById('followRequestsList').innerHTML = '<div class="activity-empty">Cargando…</div>';
  await ogFetchPendingRequests();
  ogRenderFollowRequests();
}

function ogCloseFollowRequests() {
  document.getElementById('followRequestsView')?.classList.remove('active');
  document.body.classList.remove('fr-open');
  if (typeof ogUpdateRequestsRow === 'function') ogUpdateRequestsRow();
}
