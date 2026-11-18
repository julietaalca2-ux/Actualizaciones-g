/* ==========================================
   FEATURE: NOTIFICACIONES
   - Aviso arriba (banner) cuando la app está abierta
   - Permiso de notificaciones + notificación en el centro de notificaciones del teléfono
   - Suscripción Web Push (llegan con la app cerrada; requiere la Edge Function send-push)
   Depende de: db, currentUser, profilesCache, PROFILE_MINI_FIELDS, setCachedProfile,
   showTab (navigation.js), openChatRoom + chatContentPreview (chat.js), openPublicProfile (profile.js)
   Expone: ogNotify, ogNotifyIncomingMessage, ogNotifyFromRealtime, ogEnableNotifications,
   ogToggleSystemNotifications, ogRefreshNotifSettingsUI, ogInitNotifications, ogSyncPushPrefs
   ========================================== */

const OG_NOTIF_ENABLED_KEY = 'og_push_enabled';          // '0' = el usuario las apagó
const OG_NOTIF_PROMPT_KEY = 'og_notif_prompt_dismissed'; // timestamp
const OG_NOTIF_PROMPT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const OG_BANNER_MS = 4800;

let ogBannerHost = null;
let ogSwReg = null;

/* ---------- Estado y soporte ---------- */

function ogNotifSupported() {
  return 'Notification' in window && 'serviceWorker' in navigator;
}

function ogPushSupported() {
  return ogNotifSupported() && 'PushManager' in window;
}

function ogNotifPermission() {
  return ogNotifSupported() ? Notification.permission : 'unsupported';
}

function ogNotifUserEnabled() {
  try { return localStorage.getItem(OG_NOTIF_ENABLED_KEY) !== '0'; } catch (e) { return true; }
}

function ogNotifPrefs() {
  try {
    const raw = localStorage.getItem('og_user_settings_' + (currentUser?.id || 'guest'));
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

// type: 'like' | 'comment' | 'follow' | 'message' | 'call'
function ogNotifTypeAllowed(type) {
  const p = ogNotifPrefs();
  if (type === 'like') return p.notifLikes !== false;
  if (type === 'comment') return p.notifComments !== false;
  if (type === 'follow') return p.notifFollows !== false;
  if (type === 'message') return p.notifDm !== false;
  return true; // llamadas siempre
}

async function ogGetSwRegistration() {
  if (ogSwReg) return ogSwReg;
  if (!('serviceWorker' in navigator)) return null;
  try {
    ogSwReg = (await navigator.serviceWorker.getRegistration('./')) || (await navigator.serviceWorker.ready);
  } catch (e) { ogSwReg = null; }
  return ogSwReg;
}

/* ---------- Aviso de arriba (banner dentro de la app) ---------- */

function ogEnsureBannerHost() {
  if (ogBannerHost && document.body.contains(ogBannerHost)) return ogBannerHost;
  ogBannerHost = document.createElement('div');
  ogBannerHost.className = 'og-banner-host';
  ogBannerHost.setAttribute('aria-live', 'polite');
  document.body.appendChild(ogBannerHost);
  return ogBannerHost;
}

function ogShowBanner({ title, body, icon, tag, onClick }) {
  const host = ogEnsureBannerHost();

  // Un aviso con el mismo tag reemplaza al anterior (ej. varios mensajes del mismo chat)
  if (tag) host.querySelectorAll(`.og-banner[data-tag="${CSS.escape(tag)}"]`).forEach(el => el.remove());
  while (host.children.length >= 3) host.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = 'og-banner';
  el.setAttribute('role', 'status');
  if (tag) el.dataset.tag = tag;

  const img = document.createElement('img');
  img.className = 'og-banner-icon';
  img.alt = '';
  img.src = icon || 'icons/icon-192.png';
  img.onerror = () => { img.onerror = null; img.src = 'icons/icon-192.png'; };

  const text = document.createElement('div');
  text.className = 'og-banner-text';
  const t = document.createElement('div');
  t.className = 'og-banner-title';
  t.textContent = title || 'ÖG';
  const b = document.createElement('div');
  b.className = 'og-banner-body';
  b.textContent = body || '';
  text.append(t, b);

  const now = document.createElement('span');
  now.className = 'og-banner-now';
  now.textContent = 'ahora';

  el.append(img, text, now);
  host.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => el.remove(), 350);
  };
  const arm = () => { clearTimeout(timer); timer = setTimeout(dismiss, OG_BANNER_MS); };
  arm();

  // Deslizar hacia arriba (o hacia un lado) para descartar; tocar para abrir
  let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false;
  el.addEventListener('pointerdown', e => {
    sx = e.clientX; sy = e.clientY; dx = 0; dy = 0; dragging = true;
    clearTimeout(timer);
    el.style.transition = 'none';
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    dx = e.clientX - sx; dy = Math.min(0, e.clientY - sy);
    el.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    el.style.transition = '';
    if (dy < -24 || Math.abs(dx) > 90) { el.style.transform = ''; dismiss(); return; }
    el.style.transform = '';
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) {
      dismiss();
      if (typeof onClick === 'function') onClick();
    } else {
      arm();
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) {}
}

/* ---------- Notificación del sistema (centro de notificaciones del teléfono) ---------- */

async function ogShowSystemNotification({ title, body, icon, tag, data, requireInteraction, renotify }) {
  if (ogNotifPermission() !== 'granted') return false;
  const reg = await ogGetSwRegistration();
  if (!reg || !reg.showNotification) return false;
  try {
    await reg.showNotification(title || 'ÖG', {
      body: body || '',
      icon: icon || 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: tag || undefined,
      renotify: !!(tag && renotify),
      requireInteraction: !!requireInteraction,
      data: data || {},
      timestamp: Date.now()
    });
    return true;
  } catch (e) {
    console.warn('No se pudo mostrar la notificación del sistema:', e);
    return false;
  }
}

/* Punto de entrada único.
   - App abierta y a la vista  -> banner arriba
   - App en segundo plano      -> notificación del sistema (centro de notificaciones) */
async function ogNotify(opts) {
  if (!currentUser || !opts) return;
  if (!ogNotifTypeAllowed(opts.type)) return;

  const visible = document.visibilityState === 'visible' && document.hasFocus();
  const data = Object.assign({ type: opts.type }, opts.data || {});

  if (visible) {
    ogPlaySound('notif');
    ogShowBanner({
      title: opts.title, body: opts.body, icon: opts.icon, tag: opts.tag,
      onClick: () => ogHandleNotificationTarget(data)
    });
    return;
  }

  if (ogNotifUserEnabled()) {
    await ogShowSystemNotification({
      title: opts.title, body: opts.body, icon: opts.icon, tag: opts.tag, data,
      requireInteraction: opts.type === 'call', renotify: opts.type === 'call'
    });
  }
}

/* ---------- Qué abrir al tocar una notificación ---------- */

async function ogHandleNotificationTarget(data) {
  if (!data || !currentUser) return;
  try {
    if (data.request) {
      showTab('notifications');
      if (typeof ogOpenFollowRequests === 'function') ogOpenFollowRequests();
      return;
    }
    if (data.type === 'message' && data.conversation_id) {
      const profile = await ogGetProfile(data.sender_id);
      if (profile && typeof openChatRoom === 'function') {
        showTab('messagesPage');
        openChatRoom(data.conversation_id, profile);
        return;
      }
      showTab('messagesPage');
    } else if (data.type === 'follow' && data.user_id && typeof openPublicProfile === 'function') {
      openPublicProfile(data.user_id);
    } else if (data.type === 'call') {
      // la pantalla de llamada ya se muestra sola
    } else {
      showTab('notifications');
    }
  } catch (e) { console.warn('No se pudo abrir el destino de la notificación:', e); }
}

async function ogGetProfile(userId) {
  if (!userId) return null;
  if (profilesCache[userId]) return profilesCache[userId];
  try {
    const { data } = await db.from('og_profiles').select(PROFILE_MINI_FIELDS).eq('id', userId).maybeSingle();
    if (data) { setCachedProfile(data, true); return data; }
  } catch (e) {}
  return null;
}

function ogDisplayName(p) {
  return (p && (p.username || p.display_name)) || 'Alguien';
}

/* ---------- Eventos que llegan desde realtime.js ---------- */

async function ogNotifyIncomingMessage(msg) {
  if (!msg || msg.sender_id === currentUser?.id) return;
  // Si ya estás mirando esa conversación no hace falta avisar
  const looking = document.visibilityState === 'visible' && document.hasFocus() && activeConversationId === msg.conversation_id;
  if (looking) { ogPlaySound('receive'); return; }

  const p = await ogGetProfile(msg.sender_id);
  const preview = typeof chatContentPreview === 'function' ? chatContentPreview(msg.content) : 'Mensaje nuevo';
  ogNotify({
    type: 'message',
    title: ogDisplayName(p),
    body: String(preview || 'Mensaje nuevo').slice(0, 140),
    icon: p?.avatar_url || undefined,
    tag: 'msg-' + msg.conversation_id,
    data: { conversation_id: msg.conversation_id, sender_id: msg.sender_id }
  });
}

// kind: 'like' | 'comment' | 'follow'
async function ogNotifyFromRealtime(kind, row) {
  if (!row || !currentUser) return;
  try {
    if (kind === 'follow') {
      if (row.following_id !== currentUser.id) return;
      if (typeof ogShouldSuppressFollowNotif === 'function' && ogShouldSuppressFollowNotif(row.follower_id)) return;
      const p = await ogGetProfile(row.follower_id);
      ogNotify({
        type: 'follow', title: ogDisplayName(p), body: 'empezó a seguirte',
        icon: p?.avatar_url || undefined, tag: 'follow-' + row.follower_id,
        data: { user_id: row.follower_id }
      });
      return;
    }

    if (row.user_id === currentUser.id) return;
    // Solo avisar si la publicación es mía
    const { data: post } = await db.from('posts').select('user_id').eq('id', row.post_id).maybeSingle();
    if (!post || post.user_id !== currentUser.id) return;

    const p = await ogGetProfile(row.user_id);
    if (kind === 'like') {
      ogNotify({
        type: 'like', title: ogDisplayName(p), body: 'le dio me gusta a tu publicación',
        icon: p?.avatar_url || undefined, tag: 'likes-' + row.post_id, data: { post_id: row.post_id }
      });
    } else if (kind === 'comment') {
      ogNotify({
        type: 'comment', title: ogDisplayName(p), body: 'comentó: ' + String(row.content || '').slice(0, 120),
        icon: p?.avatar_url || undefined, tag: 'comments-' + row.post_id, data: { post_id: row.post_id }
      });
    }
  } catch (e) { console.warn('Error preparando la notificación:', e); }
}

// Alguien pidió seguirme (cuenta privada)
async function ogNotifyFollowRequest(row) {
  if (!row || !currentUser || row.target_id !== currentUser.id || row.status !== 'pending') return;
  const p = await ogGetProfile(row.requester_id);
  ogNotify({
    type: 'follow', title: ogDisplayName(p), body: 'solicitó seguirte',
    icon: p?.avatar_url || undefined, tag: 'followreq-' + row.requester_id,
    data: { user_id: row.requester_id, request: true }
  });
}

// Una cuenta privada aceptó mi solicitud
async function ogNotifyRequestAccepted(row) {
  if (!row || !currentUser || row.requester_id !== currentUser.id || row.status !== 'accepted') return;
  const p = await ogGetProfile(row.target_id);
  ogNotify({
    type: 'follow', title: ogDisplayName(p), body: 'aceptó tu solicitud de seguimiento',
    icon: p?.avatar_url || undefined, tag: 'followacc-' + row.target_id,
    data: { user_id: row.target_id }
  });
}

/* ---------- Permisos y suscripción push ---------- */

function ogUrlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

function ogVapidKeyConfigured() {
  const k = window.OG_VAPID_PUBLIC_KEY;
  return !!k && k.indexOf('PEGAR') !== 0;
}

async function ogSubscribePush() {
  if (!currentUser || !ogPushSupported() || !ogVapidKeyConfigured()) return false;
  const reg = await ogGetSwRegistration();
  if (!reg) return false;
  try {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: ogUrlBase64ToUint8Array(window.OG_VAPID_PUBLIC_KEY)
      });
    }
    const json = sub.toJSON();
    const prefs = ogNotifPrefs();
    const { error } = await db.from('push_subscriptions').upsert({
      user_id: currentUser.id,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_agent: navigator.userAgent.slice(0, 250),
      prefs: {
        likes: prefs.notifLikes !== false,
        comments: prefs.notifComments !== false,
        follows: prefs.notifFollows !== false,
        dm: prefs.notifDm !== false
      },
      updated_at: new Date().toISOString()
    }, { onConflict: 'endpoint' });
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn('No se pudo registrar el push:', e);
    return false;
  }
}

async function ogUnsubscribePush() {
  try {
    const reg = await ogGetSwRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) {
      await db.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
  } catch (e) { console.warn('No se pudo cancelar el push:', e); }
}

// Se llama desde saveMenuPreferences: el servidor respeta las mismas preferencias
async function ogSyncPushPrefs() {
  if (!currentUser || !ogPushSupported() || ogNotifPermission() !== 'granted') return;
  try {
    const reg = await ogGetSwRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (!sub) return;
    const p = ogNotifPrefs();
    await db.from('push_subscriptions').update({
      prefs: { likes: p.notifLikes !== false, comments: p.notifComments !== false, follows: p.notifFollows !== false, dm: p.notifDm !== false },
      updated_at: new Date().toISOString()
    }).eq('endpoint', sub.endpoint);
  } catch (e) {}
}

// Debe llamarse desde un toque del usuario (iPhone lo exige)
async function ogEnableNotifications() {
  if (!ogNotifSupported()) {
    ogRefreshNotifSettingsUI();
    return false;
  }
  try { localStorage.setItem(OG_NOTIF_ENABLED_KEY, '1'); } catch (e) {}

  let perm = Notification.permission;
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); } catch (e) { perm = Notification.permission; }
  }
  if (perm === 'granted') {
    await ogSubscribePush();
    ogShowBanner({ title: 'Notificaciones activadas', body: 'Te avisaremos de mensajes, me gusta, comentarios y seguidores.' });
  }
  ogHideNotifPrompt();
  ogRefreshNotifSettingsUI();
  return perm === 'granted';
}

async function ogToggleSystemNotifications(checkbox) {
  if (checkbox.checked) {
    const ok = await ogEnableNotifications();
    if (!ok) checkbox.checked = false;
  } else {
    try { localStorage.setItem(OG_NOTIF_ENABLED_KEY, '0'); } catch (e) {}
    await ogUnsubscribePush();
  }
  ogRefreshNotifSettingsUI();
}

function ogRefreshNotifSettingsUI() {
  const toggle = document.getElementById('notifPushToggle');
  const info = document.getElementById('notifPushStatus');
  if (!toggle && !info) return;

  const perm = ogNotifPermission();
  let msg = '';
  let on = false;

  if (perm === 'unsupported') {
    msg = (typeof isIosDevice === 'function' && isIosDevice() && !isAppInStandaloneMode())
      ? 'En iPhone, primero instala ÖG: Compartir → “Añadir a pantalla de inicio”, y ábrela desde el ícono.'
      : 'Este navegador no admite notificaciones.';
  } else if (perm === 'denied') {
    msg = 'Las notificaciones están bloqueadas. Actívalas en los ajustes del teléfono o del navegador para este sitio / app.';
  } else if (perm === 'granted') {
    on = ogNotifUserEnabled();
    msg = on
      ? (ogVapidKeyConfigured()
        ? 'Recibirás avisos en el centro de notificaciones del teléfono.'
        : 'Activadas mientras la app esté abierta o en segundo plano. Para avisos con la app cerrada falta configurar el push del servidor.')
      : 'Desactivadas en este dispositivo.';
  } else {
    msg = 'Activa las notificaciones para recibir mensajes y actividad en el centro de notificaciones.';
  }

  if (toggle) { toggle.checked = on; toggle.disabled = perm === 'unsupported' || perm === 'denied'; }
  if (info) info.textContent = msg;
}

/* ---------- Tarjeta para pedir el permiso ---------- */

function ogShowNotifPromptIfNeeded() {
  if (!currentUser || !ogNotifSupported()) return;
  if (Notification.permission !== 'default') return;
  try {
    const last = parseInt(localStorage.getItem(OG_NOTIF_PROMPT_KEY) || '0', 10);
    if (last && Date.now() - last < OG_NOTIF_PROMPT_COOLDOWN_MS) return;
  } catch (e) {}

  let card = document.getElementById('ogNotifPrompt');
  if (!card) {
    card = document.createElement('div');
    card.id = 'ogNotifPrompt';
    card.className = 'og-notif-prompt';
    card.innerHTML = `
      <div class="og-notif-prompt-emoji">🔔</div>
      <div class="og-notif-prompt-text">
        <strong>Activa las notificaciones</strong>
        Entérate al instante de mensajes, llamadas y actividad.
      </div>
      <div class="og-notif-prompt-actions">
        <button type="button" class="primary" id="ogNotifPromptYes">Activar</button>
        <button type="button" class="secondary" id="ogNotifPromptNo">Ahora no</button>
      </div>`;
    document.body.appendChild(card);
    card.querySelector('#ogNotifPromptYes').addEventListener('click', () => ogEnableNotifications());
    card.querySelector('#ogNotifPromptNo').addEventListener('click', () => {
      try { localStorage.setItem(OG_NOTIF_PROMPT_KEY, String(Date.now())); } catch (e) {}
      ogHideNotifPrompt();
    });
  }
  card.classList.add('visible');
}

function ogHideNotifPrompt() {
  document.getElementById('ogNotifPrompt')?.classList.remove('visible');
}

/* ---------- Inicio ---------- */

async function ogInitNotifications() {
  if (!currentUser) return;
  ogRefreshNotifSettingsUI();

  if (ogNotifPermission() === 'granted' && ogNotifUserEnabled()) {
    ogSubscribePush(); // mantiene la suscripción al día en cada inicio
  } else {
    // Pequeña espera para no tapar la pantalla de inicio
    setTimeout(ogShowNotifPromptIfNeeded, 3500);
  }
}

// Mensajes que manda el Service Worker al tocar una notificación con la app ya abierta
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'OG_NOTIF_CLICK') ogHandleNotificationTarget(msg.data || {});
    if (msg.type === 'OG_PUSH_RESUBSCRIBE') ogSubscribePush();
  });
}

// Si el permiso se cambia desde los ajustes del teléfono, la pantalla de ajustes se actualiza al volver
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') ogRefreshNotifSettingsUI();
});

// Al abrir la app desde una notificación con la app cerrada (?ognotif=...)
(function () {
  try {
    const params = new URLSearchParams(location.search);
    const raw = params.get('ognotif');
    if (!raw) return;
    const data = JSON.parse(decodeURIComponent(raw));
    history.replaceState(null, '', location.pathname);
    const wait = setInterval(() => {
      if (typeof currentUser !== 'undefined' && currentUser && myProfile) {
        clearInterval(wait);
        ogHandleNotificationTarget(data);
      }
    }, 400);
    setTimeout(() => clearInterval(wait), 15000);
  } catch (e) {}
})();
