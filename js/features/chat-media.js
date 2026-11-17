/* Depende de: config.js (db, SUPABASE_URL); state.js (currentUser, activeConversationId,
   replyingToMessageId, replyingToSnippet); utils.js (compressImageBlob)
   chat.js (appendChatMessageNode, scrollToBottomChat, setChatNodeStatus, deliverChatMessage,
   encodeChatPayload, cancelReply, formatChatTime)
   Expone: toggleChatAttachMenu, closeChatAttachMenu, pickChatGallery, pickChatFile,
   handleChatFilesSelected, sendChatAttachment, openChatCamera, closeChatCamera,
   captureChatPhoto, retakeChatPhoto, sendChatCameraPhoto, switchChatCamera,
   openChatImageViewer, buildChatPayloadNode, startChatRecording, cancelChatRecording,
   sendChatRecording, updateChatSendMicState */

const CHAT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const CHAT_MAX_FILE_BYTES = 25 * 1024 * 1024;

/* Solo se muestran adjuntos que vengan de tu almacenamiento de Supabase (o locales mientras se suben) */
function isSafeChatMediaUrl(url) {
 return typeof url === 'string' && (url.startsWith('blob:') || url.startsWith(SUPABASE_URL + '/storage/'));
}

function formatChatFileSize(bytes) {
 const n = Number(bytes) || 0;
 if (n >= 1048576) return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
 if (n >= 1024) return Math.round(n / 1024) + ' KB';
 return n + ' B';
}

function formatCallDuration(totalSeconds) {
 const t = Math.max(0, Math.round(Number(totalSeconds) || 0));
 const m = Math.floor(t / 60);
 const sec = String(t % 60).padStart(2, '0');
 return m + ':' + sec;
}

/* ---------- Cómo se dibuja cada tipo de mensaje especial ---------- */
function buildChatPayloadNode(payload, msg, isMine) {
 if (!payload || !payload.t) return null;

 if (payload.t === 'call') {
  const wrap = document.createElement('div');
  wrap.className = 'chat-call-log-inner';
  const kind = payload.v ? 'Videollamada' : 'Llamada de voz';
  let label;
  if (payload.s === 'ended') label = `${kind} · ${formatCallDuration(payload.d)}`;
  else if (payload.s === 'declined') label = isMine ? `${kind} rechazada` : `Rechazaste la ${kind.toLowerCase()}`;
  else if (payload.s === 'busy') label = `${kind} · ocupado`;
  else label = isMine ? `${kind} · sin respuesta` : `${kind} perdida`;
  wrap.textContent = (payload.v ? '📹 ' : '📞 ') + label;
  if (payload.s === 'missed' && !isMine) wrap.classList.add('missed');
  return wrap;
 }

 if (!isSafeChatMediaUrl(payload.u)) return null;

 if (payload.t === 'image') {
  const img = document.createElement('img');
  img.className = 'chat-attach-img';
  img.src = payload.u;
  img.alt = 'Foto';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('click', e => { e.stopPropagation(); openChatImageViewer(payload.u); });
  return img;
 }

 if (payload.t === 'video') {
  const video = document.createElement('video');
  video.className = 'chat-attach-video';
  video.src = payload.u + (payload.u.startsWith('blob:') ? '' : '#t=0.1');
  video.controls = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'metadata';
  return video;
 }

 if (payload.t === 'audio') return buildChatAudioNode(payload);

 if (payload.t === 'file') {
  const a = document.createElement('a');
  a.className = 'chat-attach-file';
  a.href = payload.u;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.setAttribute('download', payload.n || 'archivo');
  a.addEventListener('click', e => e.stopPropagation());

  const icon = document.createElement('span');
  icon.className = 'chat-attach-file-icon';
  icon.textContent = '📄';

  const info = document.createElement('span');
  info.className = 'chat-attach-file-info';
  const name = document.createElement('strong');
  name.textContent = payload.n || 'Archivo';
  const size = document.createElement('small');
  size.textContent = formatChatFileSize(payload.s);
  info.append(name, size);

  a.append(icon, info);
  return a;
 }
 return null;
}

/* ---------- Visor de foto a pantalla completa ---------- */
function openChatImageViewer(url) {
 if (!isSafeChatMediaUrl(url)) return;
 const box = document.createElement('div');
 box.className = 'chat-lightbox';
 const img = document.createElement('img');
 img.src = url;
 img.alt = 'Foto';
 const close = document.createElement('button');
 close.type = 'button';
 close.className = 'chat-lightbox-close';
 close.setAttribute('aria-label', 'Cerrar');
 close.textContent = '✕';
 const remove = () => { box.remove(); document.removeEventListener('keydown', onKey); };
 const onKey = e => { if (e.key === 'Escape') remove(); };
 box.addEventListener('click', remove);
 document.addEventListener('keydown', onKey);
 box.append(img, close);
 document.body.append(box);
}

/* ---------- Menú de adjuntar ---------- */
function toggleChatAttachMenu(event) {
 if (event) event.stopPropagation();
 document.getElementById('chatAttachMenu')?.classList.toggle('active');
}

function closeChatAttachMenu() {
 document.getElementById('chatAttachMenu')?.classList.remove('active');
}

document.addEventListener('click', e => {
 if (!e.target.closest('#chatAttachMenu') && !e.target.closest('.chat-tool-btn')) closeChatAttachMenu();
});

function pickChatGallery() { closeChatAttachMenu(); document.getElementById('chatGalleryInput')?.click(); }
function pickChatFile() { closeChatAttachMenu(); document.getElementById('chatFileInput')?.click(); }

async function handleChatFilesSelected(input) {
 const files = Array.from(input.files || []);
 input.value = '';
 for (const file of files) {
  await sendChatAttachment(file);
 }
}

/* ---------- Envío (burbuja al instante, subida y luego guardado) ---------- */
function guessChatExtension(file, blob) {
 const fromName = (file.name || '').split('.').pop().toLowerCase();
 if (/^[a-z0-9]{1,8}$/.test(fromName) && fromName !== (file.name || '').toLowerCase()) return fromName;
 const type = (blob.type || '').split('/')[1] || '';
 const clean = type.replace(/[^a-z0-9]/gi, '').slice(0, 8);
 return clean === 'jpeg' ? 'jpg' : (clean || 'bin');
}

async function sendChatAttachment(file, forcedKind, extraMeta) {
 if (!activeConversationId || !currentUser || !file) return;

 const kind = forcedKind || (file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file');
 const limit = kind === 'image' ? CHAT_MAX_IMAGE_BYTES : CHAT_MAX_FILE_BYTES;
 if (file.size > limit) {
  alert(`El archivo es muy pesado. El máximo es ${Math.round(limit / 1048576)} MB.`);
  return;
 }

 const convId = activeConversationId;
 const replyId = replyingToMessageId;
 const replySnippet = replyingToSnippet;
 cancelReply();

 const blob = kind === 'image' ? await compressImageBlob(file, 1600, 0.85) : file;
 const localUrl = URL.createObjectURL(blob);
 const meta = { t: kind, u: localUrl, n: file.name || (kind === 'image' ? 'foto.jpg' : 'archivo'), s: blob.size, m: blob.type || '', ...(extraMeta || {}) };

 const tempId = 'optimistic-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
 const node = appendChatMessageNode({
  id: tempId,
  conversation_id: convId,
  sender_id: currentUser.id,
  content: encodeChatPayload(meta),
  reply_to_id: replyId,
  reply_to_snippet: replySnippet,
  created_at: new Date().toISOString()
 });
 scrollToBottomChat(true);
 if (!node) return;
 node._tempId = tempId;

 const run = async () => {
  node.classList.remove('is-error');
  node.classList.add('is-sending');
  setChatNodeStatus(node, 'Enviando…');
  try {
   const ext = guessChatExtension(file, blob);
   const path = `${currentUser.id}/chat/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
   const { error } = await db.storage.from('og-media').upload(path, blob, {
    contentType: blob.type || 'application/octet-stream',
    upsert: false
   });
   if (error) throw error;
   const url = db.storage.from('og-media').getPublicUrl(path).data.publicUrl;
   const payload = {
    conversation_id: convId,
    sender_id: currentUser.id,
    content: encodeChatPayload({ ...meta, u: url }),
    reply_to_id: replyId,
    reply_to_snippet: replySnippet
   };
   node._payload = payload;
   delete node._retryFn;
   await deliverChatMessage(payload, node, tempId);
  } catch (e) {
   console.error('Error subiendo adjunto del chat:', e);
   node.classList.remove('is-sending');
   node.classList.add('is-error');
   setChatNodeStatus(node, 'No enviado · tocá para reintentar');
   node._retryFn = run;
  }
 };
 node._retryFn = run;
 await run();
}

/* ---------- Cámara dentro del chat ---------- */
let chatCamStream = null;
let chatCamFacing = 'environment';
let chatCamBlob = null;
let chatCamPreviewUrl = null;

function stopChatCameraStream() {
 if (chatCamStream) {
  chatCamStream.getTracks().forEach(t => t.stop());
  chatCamStream = null;
 }
 const v = document.getElementById('chatCameraVideo');
 if (v) v.srcObject = null;
}

async function startChatCameraStream() {
 stopChatCameraStream();
 const video = document.getElementById('chatCameraVideo');
 try {
  chatCamStream = await navigator.mediaDevices.getUserMedia({
   video: { facingMode: chatCamFacing, width: { ideal: 1920 }, height: { ideal: 1080 } },
   audio: false
  });
  video.srcObject = chatCamStream;
  video.classList.toggle('mirrored', chatCamFacing === 'user');
  await video.play();
  return true;
 } catch (e) {
  console.error('No se pudo abrir la cámara:', e);
  return false;
 }
}

async function openChatCamera() {
 if (!activeConversationId || !currentUser) return;
 closeChatAttachMenu();

 // Si el navegador no deja abrir la cámara directamente, se usa la cámara del sistema
 if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  document.getElementById('chatCameraFallbackInput')?.click();
  return;
 }
 chatCamBlob = null;
 retakeChatPhoto(true);
 document.getElementById('chatCameraModal').classList.add('active');
 const ok = await startChatCameraStream();
 if (!ok) {
  document.getElementById('chatCameraModal').classList.remove('active');
  alert('No se pudo abrir la cámara. Revisá que hayas dado permiso de cámara a la app.');
 }
}

function closeChatCamera() {
 stopChatCameraStream();
 if (chatCamPreviewUrl) { URL.revokeObjectURL(chatCamPreviewUrl); chatCamPreviewUrl = null; }
 chatCamBlob = null;
 document.getElementById('chatCameraModal')?.classList.remove('active', 'has-photo');
}

async function switchChatCamera() {
 chatCamFacing = chatCamFacing === 'user' ? 'environment' : 'user';
 await startChatCameraStream();
}

function captureChatPhoto() {
 const video = document.getElementById('chatCameraVideo');
 if (!video || !video.videoWidth) return;
 const canvas = document.createElement('canvas');
 canvas.width = video.videoWidth;
 canvas.height = video.videoHeight;
 canvas.getContext('2d').drawImage(video, 0, 0);
 canvas.toBlob(blob => {
  if (!blob) return;
  chatCamBlob = blob;
  if (chatCamPreviewUrl) URL.revokeObjectURL(chatCamPreviewUrl);
  chatCamPreviewUrl = URL.createObjectURL(blob);
  const preview = document.getElementById('chatCameraPreview');
  preview.src = chatCamPreviewUrl;
  document.getElementById('chatCameraModal').classList.add('has-photo');
 }, 'image/jpeg', 0.9);
}

function retakeChatPhoto(silent) {
 chatCamBlob = null;
 if (chatCamPreviewUrl) { URL.revokeObjectURL(chatCamPreviewUrl); chatCamPreviewUrl = null; }
 const preview = document.getElementById('chatCameraPreview');
 if (preview) preview.removeAttribute('src');
 document.getElementById('chatCameraModal')?.classList.remove('has-photo');
}

async function sendChatCameraPhoto() {
 if (!chatCamBlob) return;
 const file = new File([chatCamBlob], 'foto.jpg', { type: 'image/jpeg' });
 closeChatCamera();
 await sendChatAttachment(file, 'image');
}

document.addEventListener('visibilitychange', () => {
 const modal = document.getElementById('chatCameraModal');
 if (document.hidden && chatCamStream) stopChatCameraStream();
 else if (!document.hidden && modal?.classList.contains('active') && !modal.classList.contains('has-photo') && !chatCamStream) startChatCameraStream();
});


/* =========================================================================
   MENSAJES DE VOZ
   ========================================================================= */
const CHAT_AUDIO_MAX_SECONDS = 300;   // 5 minutos
const CHAT_AUDIO_MIN_SECONDS = 1;
let chatRec = null;
let chatCurrentAudio = null;

/* El botón de enviar aparece solo cuando hay texto; si el campo está vacío se ve el micrófono */
function updateChatSendMicState(el) {
 const input = el || document.getElementById('chatMessageInput');
 const footer = document.querySelector('#chatRoomPage .chat-input-footer');
 if (!footer || !input) return;
 footer.classList.toggle('has-text', input.value.trim().length > 0);
}

function pickChatAudioMime() {
 if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
 const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
 return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function chatAudioFileExtension(mime) {
 if ((mime || '').includes('mp4')) return 'm4a';
 if ((mime || '').includes('ogg')) return 'ogg';
 return 'webm';
}

async function startChatRecording() {
 if (!activeConversationId || !currentUser || chatRec) return;
 if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
  alert('Tu navegador no permite grabar audios. Probá con Safari o Chrome actualizado.');
  return;
 }
 closeChatAttachMenu();

 let stream;
 try {
  stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
 } catch (e) {
  alert('No se pudo acceder al micrófono. Revisá que hayas dado permiso a la app.');
  return;
 }

 // Si mientras se pedía el permiso otra grabación empezó o se cambió de chat
 if (chatRec) { stream.getTracks().forEach(t => t.stop()); return; }

 const mime = pickChatAudioMime();
 let recorder;
 try {
  recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
 } catch (e) {
  stream.getTracks().forEach(t => t.stop());
  alert('No se pudo iniciar la grabación en este dispositivo.');
  return;
 }

 const rec = {
  recorder, stream, chunks: [], mime: recorder.mimeType || mime || 'audio/webm',
  startedAt: Date.now(), timer: null, convId: activeConversationId, sendOnStop: false
 };
 chatRec = rec;
 recorder.ondataavailable = e => { if (e.data && e.data.size) rec.chunks.push(e.data); };
 recorder.onstop = () => finishChatRecording(rec);
 recorder.start(500);

 const footer = document.querySelector('#chatRoomPage .chat-input-footer');
 footer?.classList.add('recording');
 const timerEl = document.getElementById('chatRecordTimer');
 if (timerEl) timerEl.textContent = '0:00';
 rec.timer = setInterval(() => {
  const secs = (Date.now() - rec.startedAt) / 1000;
  if (timerEl) timerEl.textContent = formatCallDuration(secs);
  if (secs >= CHAT_AUDIO_MAX_SECONDS) stopChatRecording(true);
 }, 250);
}

/* send = true: se envía; false: se descarta */
function stopChatRecording(send) {
 const rec = chatRec;
 if (!rec || rec.stopping) return;
 rec.stopping = true;
 rec.sendOnStop = !!send;
 clearInterval(rec.timer);
 document.querySelector('#chatRoomPage .chat-input-footer')?.classList.remove('recording');
 if (rec.recorder.state !== 'inactive') rec.recorder.stop();
 else finishChatRecording(rec);
}

function cancelChatRecording() { stopChatRecording(false); }
function sendChatRecording() { stopChatRecording(true); }

function finishChatRecording(rec) {
 if (rec.finished) return;
 rec.finished = true;
 rec.stream.getTracks().forEach(t => t.stop());
 if (chatRec === rec) chatRec = null;
 if (!rec.sendOnStop) return;

 const seconds = (Date.now() - rec.startedAt) / 1000;
 if (seconds < CHAT_AUDIO_MIN_SECONDS || !rec.chunks.length) return;
 // Si se cambió de chat mientras se grababa, no se manda a otra conversación
 if (activeConversationId !== rec.convId) return;

 const blob = new Blob(rec.chunks, { type: rec.mime });
 const file = new File([blob], `audio.${chatAudioFileExtension(rec.mime)}`, { type: rec.mime });
 sendChatAttachment(file, 'audio', { d: Math.round(seconds) });
}

// Si la app pasa a segundo plano el sistema corta el micrófono: se descarta la grabación
document.addEventListener('visibilitychange', () => {
 if (document.hidden && chatRec) stopChatRecording(false);
});

/* ---------- Reproductor de mensajes de voz ---------- */
const CHAT_AUDIO_SPEEDS = [1, 1.5, 2];
const CHAT_PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const CHAT_PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

function buildChatAudioNode(payload) {
 const wrap = document.createElement('div');
 wrap.className = 'chat-audio';

 const btn = document.createElement('button');
 btn.type = 'button';
 btn.className = 'chat-audio-btn';
 btn.setAttribute('aria-label', 'Reproducir mensaje de voz');
 btn.innerHTML = CHAT_PLAY_SVG;

 const bar = document.createElement('div');
 bar.className = 'chat-audio-bar';
 const fill = document.createElement('div');
 fill.className = 'chat-audio-fill';
 bar.append(fill);

 const time = document.createElement('span');
 time.className = 'chat-audio-time';
 const total = Number(payload.d) || 0;
 time.textContent = formatCallDuration(total);

 const speed = document.createElement('button');
 speed.type = 'button';
 speed.className = 'chat-audio-speed';
 speed.textContent = '1x';

 const audio = new Audio();
 audio.preload = 'none';
 audio.src = payload.u;
 const state = { audio, btn };

 const duration = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : total);
 const reset = () => {
  btn.innerHTML = CHAT_PLAY_SVG;
  fill.style.width = '0%';
  time.textContent = formatCallDuration(total || duration());
 };

 btn.addEventListener('click', e => {
  e.stopPropagation();
  if (!audio.paused) { audio.pause(); return; }
  if (chatCurrentAudio && chatCurrentAudio !== state) chatCurrentAudio.audio.pause();
  chatCurrentAudio = state;
  audio.play().catch(() => { btn.innerHTML = CHAT_PLAY_SVG; });
 });
 audio.addEventListener('play', () => { btn.innerHTML = CHAT_PAUSE_SVG; });
 audio.addEventListener('pause', () => { btn.innerHTML = CHAT_PLAY_SVG; });
 audio.addEventListener('ended', () => { audio.currentTime = 0; reset(); });
 audio.addEventListener('timeupdate', () => {
  const d = duration();
  if (d > 0) fill.style.width = Math.min(100, (audio.currentTime / d) * 100) + '%';
  time.textContent = formatCallDuration(audio.currentTime);
 });

 bar.addEventListener('click', e => {
  e.stopPropagation();
  const d = duration();
  if (!d) return;
  const rect = bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.currentTime = ratio * d;
  fill.style.width = (ratio * 100) + '%';
 });

 speed.addEventListener('click', e => {
  e.stopPropagation();
  const idx = (CHAT_AUDIO_SPEEDS.indexOf(audio.playbackRate) + 1) % CHAT_AUDIO_SPEEDS.length;
  audio.playbackRate = CHAT_AUDIO_SPEEDS[idx];
  speed.textContent = CHAT_AUDIO_SPEEDS[idx] + 'x';
 });

 wrap.append(btn, bar, time, speed);
 return wrap;
}
