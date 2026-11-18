/* Llamadas de voz y videollamadas 1 a 1 (WebRTC).
   Depende de: config.js (db); state.js (currentUser, profilesCache, activeConversationId,
   activeRecipientProfile); utils.js (setAvatarContent, PROFILE_MINI_FIELDS, setCachedProfile);
   chat.js (postChatSystemMessage, encodeChatPayload)
   Señalización: canales "broadcast" de Supabase Realtime (uno por usuario: og-call:<id>).
   Expone: initCallSignaling, stopCallSignaling, startCall, acceptIncomingCall, rejectIncomingCall,
   hangUpCall, toggleCallMute, toggleCallCamera, switchCallCamera

   IMPORTANTE: la persona solo recibe la llamada si tiene la app abierta (no hay notificaciones push).
   Para que funcione en datos móviles / redes estrictas hace falta un servidor TURN:
   definilo en js/config.js con window.OG_ICE_SERVERS (ver comentario allí). */

const CALL_RING_TIMEOUT_MS = 45000;
const CALL_DEFAULT_ICE = [
 { urls: 'stun:stun.l.google.com:19302' },
 { urls: 'stun:stun1.l.google.com:19302' }
];

let callInboxChannel = null;
let callInboxUserId = null;
const callOutChannels = {};
let call = null;

/* ---------- Señalización ---------- */
function initCallSignaling() {
 if (!currentUser) { stopCallSignaling(); return; }
 if (callInboxChannel && callInboxUserId === currentUser.id) return;
 stopCallSignaling();
 callInboxUserId = currentUser.id;
 callInboxChannel = db.channel('og-call:' + currentUser.id, { config: { broadcast: { self: false } } });
 callInboxChannel
  .on('broadcast', { event: 'signal' }, ({ payload }) => {
   handleCallSignal(payload).catch(e => console.error('Error en señal de llamada:', e));
  })
  .subscribe();
}

function stopCallSignaling() {
 if (call) teardownCall();
 if (callInboxChannel) { db.removeChannel(callInboxChannel); callInboxChannel = null; }
 callInboxUserId = null;
 Object.keys(callOutChannels).forEach(id => {
  db.removeChannel(callOutChannels[id].ch);
  delete callOutChannels[id];
 });
}

function getCallOutChannel(userId) {
 if (callOutChannels[userId]) return callOutChannels[userId];
 const ch = db.channel('og-call:' + userId, { config: { broadcast: { self: false, ack: true } } });
 const ready = new Promise(resolve => {
  ch.subscribe(status => {
   if (status === 'SUBSCRIBED') resolve(true);
   else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') resolve(false);
  });
 });
 callOutChannels[userId] = { ch, ready };
 return callOutChannels[userId];
}

async function sendCallSignal(toUserId, data) {
 if (!currentUser || !toUserId) return false;
 const entry = getCallOutChannel(toUserId);
 const ok = await entry.ready;
 if (!ok) {
  db.removeChannel(entry.ch);
  delete callOutChannels[toUserId];
  return false;
 }
 try {
  const res = await entry.ch.send({ type: 'broadcast', event: 'signal', payload: { ...data, from: currentUser.id } });
  return res === 'ok';
 } catch (e) { return false; }
}

function releaseCallOutChannel(userId) {
 const entry = callOutChannels[userId];
 if (!entry) return;
 setTimeout(() => {
  db.removeChannel(entry.ch);
  if (callOutChannels[userId] === entry) delete callOutChannels[userId];
 }, 1500);
}

/* ---------- Estado y utilidades ---------- */
function newCallState(init) {
 return {
  id: 'call-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  peerId: null, peerProfile: null, video: false, role: 'caller', convId: null,
  state: 'ringing', pc: null, localStream: null, remoteStream: null,
  pendingIce: [], startedAt: 0, durationTimer: null, ringTimeout: null, disconnectTimer: null,
  muted: false, camOff: false, facing: 'user', logged: false, ended: false,
  ...init
 };
}

function getCallIceServers() {
 return Array.isArray(window.OG_ICE_SERVERS) && window.OG_ICE_SERVERS.length ? window.OG_ICE_SERVERS : CALL_DEFAULT_ICE;
}

async function getCallLocalStream(video, facing) {
 return navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: video ? { facingMode: facing || 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false
 });
}

function setCallStatus(text) {
 const el = document.getElementById('callStatus');
 if (el) el.textContent = text;
}

function showCallOverlay() {
 const c = call;
 if (!c) return;
 const overlay = document.getElementById('callOverlay');
 document.getElementById('callPeerName').textContent = c.peerProfile?.username || c.peerProfile?.display_name || 'Llamada';
 setAvatarContent(document.getElementById('callPeerAvatar'), c.peerProfile?.avatar_url, '👤');
 overlay.classList.toggle('audio-only', !c.video);
 overlay.classList.remove('connected');
 document.getElementById('callCamBtn').style.display = c.video ? 'flex' : 'none';
 document.getElementById('callFlipBtn').style.display = c.video ? 'flex' : 'none';
 document.getElementById('callMuteBtn').classList.remove('off');
 document.getElementById('callCamBtn').classList.remove('off');

 const localVideo = document.getElementById('callLocalVideo');
 localVideo.srcObject = c.localStream && c.video ? c.localStream : null;
 localVideo.style.visibility = 'visible';
 localVideo.classList.toggle('mirrored', c.facing === 'user');
 if (c.video) localVideo.play().catch(() => {});
 overlay.classList.add('active');
}

function hideCallUi() {
 document.getElementById('callOverlay')?.classList.remove('active', 'connected', 'audio-only');
 document.getElementById('incomingCallOverlay')?.classList.remove('active');
 const rv = document.getElementById('callRemoteVideo');
 if (rv) rv.srcObject = null;
 const lv = document.getElementById('callLocalVideo');
 if (lv) lv.srcObject = null;
}

async function resolveCallPeerProfile(userId) {
 if (profilesCache[userId]) return profilesCache[userId];
 try {
  const { data } = await db.from('og_profiles').select(PROFILE_MINI_FIELDS).eq('id', userId).maybeSingle();
  if (data) { setCachedProfile(data, false); return data; }
 } catch (e) {}
 return { id: userId, username: 'usuario', display_name: 'Usuario', avatar_url: null };
}

/* ---------- Sonido de llamada entrante ---------- */
let ringCtx = null;
let ringInterval = null;

function startRingtone() {
 stopRingtone();
 const beep = () => {
  try {
   if (!ringCtx) ringCtx = new (window.AudioContext || window.webkitAudioContext)();
   if (ringCtx.state === 'suspended') ringCtx.resume();
   const osc = ringCtx.createOscillator();
   const gain = ringCtx.createGain();
   osc.frequency.value = 480;
   gain.gain.setValueAtTime(0.0001, ringCtx.currentTime);
   gain.gain.exponentialRampToValueAtTime(0.18, ringCtx.currentTime + 0.05);
   gain.gain.exponentialRampToValueAtTime(0.0001, ringCtx.currentTime + 0.9);
   osc.connect(gain).connect(ringCtx.destination);
   osc.start();
   osc.stop(ringCtx.currentTime + 1);
  } catch (e) {}
  if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
 };
 beep();
 ringInterval = setInterval(beep, 2500);
}

function stopRingtone() {
 clearInterval(ringInterval);
 ringInterval = null;
 if (navigator.vibrate) navigator.vibrate(0);
}

/* ---------- Conexión WebRTC ---------- */
function createCallPeer() {
 const c = call;
 const pc = new RTCPeerConnection({ iceServers: getCallIceServers() });
 c.pc = pc;
 c.localStream.getTracks().forEach(t => pc.addTrack(t, c.localStream));

 pc.ontrack = e => {
  if (!call || call !== c) return;
  c.remoteStream = e.streams[0] || c.remoteStream || new MediaStream();
  if (!e.streams[0]) c.remoteStream.addTrack(e.track);
  const rv = document.getElementById('callRemoteVideo');
  if (rv.srcObject !== c.remoteStream) rv.srcObject = c.remoteStream;
  rv.play().catch(() => {});
 };

 pc.onicecandidate = e => {
  if (e.candidate && call === c) {
   sendCallSignal(c.peerId, { type: 'ice', callId: c.id, candidate: e.candidate.toJSON() });
  }
 };

 pc.onconnectionstatechange = () => {
  if (call !== c) return;
  const st = pc.connectionState;
  if (st === 'connected') {
   clearTimeout(c.disconnectTimer);
   onCallConnected();
  } else if (st === 'disconnected') {
   setCallStatus('Reconectando…');
   clearTimeout(c.disconnectTimer);
   c.disconnectTimer = setTimeout(() => { if (call === c && pc.connectionState !== 'connected') finishCall('failed'); }, 12000);
  } else if (st === 'failed') {
   finishCall('failed');
  }
 };
}

function onCallConnected() {
 const c = call;
 if (!c || c.state === 'connected') return;
 c.state = 'connected';
 c.startedAt = Date.now();
 clearTimeout(c.ringTimeout);
 document.getElementById('callOverlay').classList.add('connected');
 setCallStatus('0:00');
 c.durationTimer = setInterval(() => {
  if (call === c) setCallStatus(formatCallDuration((Date.now() - c.startedAt) / 1000));
 }, 1000);
}

async function flushPendingIce() {
 const c = call;
 if (!c || !c.pc || !c.pc.remoteDescription) return;
 const queued = c.pendingIce.splice(0);
 for (const cand of queued) {
  try { await c.pc.addIceCandidate(cand); } catch (e) {}
 }
}

/* ---------- Llamar ---------- */
async function startCall(withVideo) {
 if (!currentUser || !activeRecipientProfile || !activeConversationId) return;
 if (call) { alert('Ya estás en una llamada.'); return; }
 if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
  alert('Tu navegador no admite llamadas. Probá con Safari o Chrome actualizado.');
  return;
 }
 initCallSignaling();

 const c = newCallState({
  role: 'caller',
  peerId: activeRecipientProfile.id,
  peerProfile: activeRecipientProfile,
  video: !!withVideo,
  convId: activeConversationId
 });
 call = c;

 try {
  c.localStream = await getCallLocalStream(c.video, c.facing);
 } catch (e) {
  call = null;
  alert(c.video
   ? 'No se pudo acceder a la cámara y al micrófono. Revisá los permisos de la app.'
   : 'No se pudo acceder al micrófono. Revisá los permisos de la app.');
  return;
 }

 showCallOverlay();
 setCallStatus('Llamando…');
 createCallPeer();

 const sent = await sendCallSignal(c.peerId, { type: 'invite', callId: c.id, video: c.video, convId: c.convId });
 if (call !== c) return;
 if (!sent) { finishCall('unreachable'); return; }
 c.ringTimeout = setTimeout(() => { if (call === c && c.state === 'ringing') finishCall('timeout'); }, CALL_RING_TIMEOUT_MS);
}

/* ---------- Mensajes de señalización recibidos ---------- */
async function handleCallSignal(msg) {
 if (!msg || !msg.type || !msg.from || msg.from === currentUser?.id) return;

 if (msg.type === 'invite') {
  if (call) { sendCallSignal(msg.from, { type: 'busy', callId: msg.callId }); return; }
  const profile = await resolveCallPeerProfile(msg.from);
  if (call) { sendCallSignal(msg.from, { type: 'busy', callId: msg.callId }); return; }
  call = newCallState({
   id: msg.callId, role: 'callee', peerId: msg.from, peerProfile: profile,
   video: !!msg.video, convId: msg.convId || null, state: 'incoming'
  });
  showIncomingCall();
  if (typeof ogNotify === 'function') {
   ogNotify({
    type: 'call',
    title: profile?.username || profile?.display_name || 'Alguien',
    body: msg.video ? 'Videollamada entrante…' : 'Llamada entrante…',
    icon: profile?.avatar_url || undefined,
    tag: 'incoming-call',
    data: { sender_id: msg.from }
   });
  }
  // Si quien llama se rinde o no contestamos, el aviso se cierra solo
  call.ringTimeout = setTimeout(() => { if (call && call.state === 'incoming') finishCall('missed-local'); }, CALL_RING_TIMEOUT_MS + 5000);
  return;
 }

 const c = call;
 if (!c || c.id !== msg.callId || c.peerId !== msg.from) return;

 switch (msg.type) {
  case 'accept': {
   if (c.role !== 'caller' || c.state !== 'ringing') return;
   clearTimeout(c.ringTimeout);
   c.state = 'connecting';
   setCallStatus('Conectando…');
   const offer = await c.pc.createOffer();
   await c.pc.setLocalDescription(offer);
   await sendCallSignal(c.peerId, { type: 'offer', callId: c.id, sdp: c.pc.localDescription.toJSON ? c.pc.localDescription.toJSON() : { type: offer.type, sdp: offer.sdp } });
   break;
  }
  case 'offer': {
   if (c.role !== 'callee' || !c.pc) return;
   await c.pc.setRemoteDescription(msg.sdp);
   await flushPendingIce();
   const answer = await c.pc.createAnswer();
   await c.pc.setLocalDescription(answer);
   await sendCallSignal(c.peerId, { type: 'answer', callId: c.id, sdp: c.pc.localDescription.toJSON ? c.pc.localDescription.toJSON() : { type: answer.type, sdp: answer.sdp } });
   break;
  }
  case 'answer': {
   if (c.role !== 'caller' || !c.pc) return;
   await c.pc.setRemoteDescription(msg.sdp);
   await flushPendingIce();
   break;
  }
  case 'ice': {
   if (!msg.candidate) return;
   if (c.pc && c.pc.remoteDescription) {
    try { await c.pc.addIceCandidate(msg.candidate); } catch (e) {}
   } else {
    c.pendingIce.push(msg.candidate);
   }
   break;
  }
  case 'reject': finishCall('declined', { notify: false }); break;
  case 'busy': finishCall('busy', { notify: false }); break;
  case 'cancel': finishCall('cancelled-remote', { notify: false }); break;
  case 'hangup': finishCall('remote-hangup', { notify: false }); break;
 }
}

/* ---------- Llamada entrante ---------- */
function showIncomingCall() {
 const c = call;
 if (!c) return;
 setAvatarContent(document.getElementById('incomingCallAvatar'), c.peerProfile?.avatar_url, '👤');
 document.getElementById('incomingCallName').textContent = c.peerProfile?.username || c.peerProfile?.display_name || 'Alguien';
 document.getElementById('incomingCallKind').textContent = c.video ? 'Videollamada entrante…' : 'Llamada entrante…';
 document.getElementById('incomingCallOverlay').classList.add('active');
 startRingtone();
}

async function acceptIncomingCall() {
 const c = call;
 if (!c || c.role !== 'callee' || c.state !== 'incoming') return;
 stopRingtone();
 clearTimeout(c.ringTimeout);

 if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
  alert('Tu navegador no admite llamadas.');
  finishCall('declined-local');
  return;
 }
 try {
  c.localStream = await getCallLocalStream(c.video, c.facing);
 } catch (e) {
  alert('No se pudo acceder al micrófono o la cámara. Revisá los permisos de la app.');
  if (call === c) finishCall('declined-local');
  return;
 }
 if (call !== c) { c.localStream.getTracks().forEach(t => t.stop()); return; }

 c.state = 'connecting';
 document.getElementById('incomingCallOverlay').classList.remove('active');
 showCallOverlay();
 setCallStatus('Conectando…');
 createCallPeer();
 await sendCallSignal(c.peerId, { type: 'accept', callId: c.id });
}

function rejectIncomingCall() {
 if (call && call.role === 'callee' && call.state === 'incoming') finishCall('declined-local');
}

function hangUpCall() {
 if (!call) return;
 if (call.state === 'incoming') { finishCall('declined-local'); return; }
 finishCall(call.state === 'connected' ? 'hangup-local' : 'cancelled-local');
}

/* ---------- Fin de la llamada ---------- */
function teardownCall() {
 const c = call;
 if (!c) return;
 stopRingtone();
 clearTimeout(c.ringTimeout);
 clearTimeout(c.disconnectTimer);
 clearInterval(c.durationTimer);
 if (c.pc) { try { c.pc.close(); } catch (e) {} }
 if (c.localStream) c.localStream.getTracks().forEach(t => t.stop());
 call = null;
 hideCallUi();
}

const CALL_END_TEXT = {
 'declined': 'Llamada rechazada',
 'busy': 'Está en otra llamada',
 'cancelled-remote': 'Llamada cancelada',
 'remote-hangup': 'Llamada finalizada',
 'timeout': 'No contestó',
 'unreachable': 'No se pudo conectar',
 'failed': 'Se perdió la conexión',
 'hangup-local': 'Llamada finalizada'
};

function finishCall(reason, { notify = true } = {}) {
 const c = call;
 if (!c || c.ended) return;
 c.ended = true;

 const duration = c.state === 'connected' ? Math.round((Date.now() - c.startedAt) / 1000) : 0;

 // Avisar a la otra persona
 if (notify) {
  if (reason === 'hangup-local' || reason === 'failed') sendCallSignal(c.peerId, { type: 'hangup', callId: c.id });
  else if (reason === 'cancelled-local' || reason === 'timeout') sendCallSignal(c.peerId, { type: 'cancel', callId: c.id });
  else if (reason === 'declined-local') sendCallSignal(c.peerId, { type: 'reject', callId: c.id });
 }

 // Solo quien llama deja el registro en el chat
 if (c.role === 'caller' && !c.logged && c.convId && reason !== 'unreachable') {
  c.logged = true;
  let status = 'missed';
  if (duration > 0) status = 'ended';
  else if (reason === 'declined') status = 'declined';
  else if (reason === 'busy') status = 'busy';
  postChatSystemMessage(c.convId, encodeChatPayload({ t: 'call', v: c.video ? 1 : 0, s: status, d: duration }));
 }

 const text = CALL_END_TEXT[reason];
 const overlayActive = document.getElementById('callOverlay')?.classList.contains('active');
 const peerId = c.peerId;
 if (text && overlayActive) {
  setCallStatus(text);
  // Se liberan cámara y micrófono ya, y la pantalla se cierra en un instante
  stopRingtone();
  clearTimeout(c.ringTimeout);
  clearTimeout(c.disconnectTimer);
  clearInterval(c.durationTimer);
  if (c.pc) { try { c.pc.close(); } catch (e) {} }
  if (c.localStream) c.localStream.getTracks().forEach(t => t.stop());
  setTimeout(() => { if (call === c) { call = null; hideCallUi(); } }, 1400);
 } else {
  teardownCall();
 }
 releaseCallOutChannel(peerId);
}

/* ---------- Controles durante la llamada ---------- */
function toggleCallMute() {
 if (!call || !call.localStream) return;
 call.muted = !call.muted;
 call.localStream.getAudioTracks().forEach(t => { t.enabled = !call.muted; });
 document.getElementById('callMuteBtn').classList.toggle('off', call.muted);
}

function toggleCallCamera() {
 if (!call || !call.localStream || !call.video) return;
 call.camOff = !call.camOff;
 call.localStream.getVideoTracks().forEach(t => { t.enabled = !call.camOff; });
 document.getElementById('callCamBtn').classList.toggle('off', call.camOff);
 document.getElementById('callLocalVideo').style.visibility = call.camOff ? 'hidden' : 'visible';
}

async function switchCallCamera() {
 const c = call;
 if (!c || !c.video || !c.pc) return;
 const nextFacing = c.facing === 'user' ? 'environment' : 'user';
 try {
  const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: nextFacing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  const newTrack = fresh.getVideoTracks()[0];
  const sender = c.pc.getSenders().find(s => s.track && s.track.kind === 'video');
  if (sender) await sender.replaceTrack(newTrack);
  c.localStream.getVideoTracks().forEach(t => { t.stop(); c.localStream.removeTrack(t); });
  c.localStream.addTrack(newTrack);
  newTrack.enabled = !c.camOff;
  c.facing = nextFacing;
  const lv = document.getElementById('callLocalVideo');
  lv.srcObject = c.localStream;
  lv.classList.toggle('mirrored', nextFacing === 'user');
  lv.play().catch(() => {});
 } catch (e) {
  console.error('No se pudo cambiar de cámara:', e);
 }
}

window.addEventListener('beforeunload', () => {
 if (call) {
  const c = call;
  try { sendCallSignal(c.peerId, { type: c.state === 'connected' ? 'hangup' : 'cancel', callId: c.id }); } catch (e) {}
 }
});
