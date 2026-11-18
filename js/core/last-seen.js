/* ÖG — "Última vez" de los usuarios
   Depende de: config.js (db); state.js (currentUser, onlineUsersMap, activeRecipientProfile)
   Requiere haber ejecutado supabase/03_ultima_vez_y_push.sql (columna og_profiles.last_seen_at)
   Expone: ogFormatLastSeen, ogFetchLastSeen, ogRefreshChatStatus, ogMarkUserLeft,
   ogStartLastSeenHeartbeat, ogLastSeenCache */

const ogLastSeenCache = {};            // userId -> ISO de su última conexión
const OG_HEARTBEAT_MS = 60 * 1000;
let ogHeartbeatTimer = null;
let ogLastSeenCleared = false;

function ogActivityStatusEnabled() {
  try {
    const raw = localStorage.getItem('og_user_settings_' + (currentUser?.id || 'guest'));
    return !raw || JSON.parse(raw).activityStatus !== false;
  } catch (e) { return true; }
}

/* "Última vez hoy a las 14:32" · "Última vez ayer a las 14:32" · "Última vez el 12 nov a las 14:32" */
function ogFormatLastSeen(iso) {
  if (!iso) return 'Desconectado';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Desconectado';
  const hora = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });

  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startToday) return 'Última vez hoy a las ' + hora;
  if (t >= startToday - 86400000) return 'Última vez ayer a las ' + hora;

  let dia = d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }).replace('.', '');
  if (d.getFullYear() !== now.getFullYear()) dia += ' ' + d.getFullYear();
  return 'Última vez el ' + dia + ' a las ' + hora;
}

async function ogFetchLastSeen(userId) {
  if (!userId) return null;
  try {
    const { data, error } = await db.from('og_profiles').select('last_seen_at').eq('id', userId).maybeSingle();
    if (error) return null;
    if (data?.last_seen_at) ogLastSeenCache[userId] = data.last_seen_at;
    else delete ogLastSeenCache[userId];
    return data?.last_seen_at || null;
  } catch (e) { return null; }
}

/* Pone "En línea" / "Última vez …" en la cabecera del chat y en el detalle del chat */
async function ogRefreshChatStatus() {
  const p = activeRecipientProfile;
  if (!p) return;
  const sub = document.getElementById('chatRoomStatusSub');
  const det = document.getElementById('chatDetailsActivityStatus');
  const paint = () => {
    if (activeRecipientProfile?.id !== p.id) return;
    const online = !!onlineUsersMap[p.id];
    const text = online ? 'En línea' : ogFormatLastSeen(ogLastSeenCache[p.id]);
    if (sub) sub.textContent = text;
    if (det) { det.textContent = text; det.style.color = online ? '#22c55e' : '#888888'; }
    document.getElementById('chatRoomOnlineDot')?.classList.toggle('active', online);
  };
  paint();
  if (!onlineUsersMap[p.id]) { await ogFetchLastSeen(p.id); paint(); }
}

// Se llama cuando alguien sale de la presencia: su última vez es "ahora"
function ogMarkUserLeft(userId) {
  if (!userId || userId === currentUser?.id) return;
  ogLastSeenCache[userId] = new Date().toISOString();
}

/* ---------- Guardar mi propia última vez ---------- */

async function ogWriteMyLastSeen(value) {
  if (!currentUser) return;
  try {
    await db.from('og_profiles').update({ last_seen_at: value }).eq('id', currentUser.id);
  } catch (e) { /* si falta el SQL no pasa nada */ }
}

function ogBeat() {
  if (!currentUser) return;
  if (!ogActivityStatusEnabled()) {
    // Si apagaste "estado de actividad", se borra tu última vez para que nadie la vea
    if (!ogLastSeenCleared) { ogLastSeenCleared = true; ogWriteMyLastSeen(null); }
    return;
  }
  ogLastSeenCleared = false;
  if (document.visibilityState === 'visible') ogWriteMyLastSeen(new Date().toISOString());
}

function ogStartLastSeenHeartbeat() {
  if (ogHeartbeatTimer) clearInterval(ogHeartbeatTimer);
  ogHeartbeatTimer = null;
  if (!currentUser) return;
  ogBeat();
  ogHeartbeatTimer = setInterval(ogBeat, OG_HEARTBEAT_MS);
}

// Al salir de la app o pasar a segundo plano se guarda al instante
function ogBeatOnLeave() {
  if (!currentUser || !ogActivityStatusEnabled()) return;
  ogWriteMyLastSeen(new Date().toISOString());
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') ogBeatOnLeave();
  else ogBeat();
});
window.addEventListener('pagehide', ogBeatOnLeave);
