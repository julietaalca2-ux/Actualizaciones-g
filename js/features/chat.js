/* Depende de: config.js (db); state.js (currentUser, profilesCache, onlineUsersMap,
   activeConversationId, activeRecipientProfile, replyingToMessageId, replyingToSnippet,
   cachedConversationsList, renderedMessageIds, prefetchedConversationIds,
   prefetchedMessagesByConv, dmSearchTimer); utils.js (formatDate, createAvatarNode,
   setAvatarContent, ogCache, setCachedProfile, prefetchConversationMessages,
   bindSmartPrefetch, PROFILE_SELECT_FIELDS, PROFILE_MINI_FIELDS)
   En tiempo de ejecución usa funciones de otros módulos: openPublicProfile (profile.js)
   Expone: checkGlobalUnreadMessages, loadConversations, renderConversationsDOM,
   searchUsersForChat, openDirectChatWithUser, openChatRoom, buildChatMessageNode,
   appendChatMessageNode, scrollToBottomChat, triggerReplyToMessage, cancelReply,
   sendChatMessage, postChatSystemMessage, encodeChatPayload, parseChatPayload, chatContentPreview, openChatDetailsPage, toggleChatDetailsMenu, handleChatActionMenu,
   openChatRecipientProfile, triggerChatSearch, openMuteOptionsModal, openChatSubSettings,
   handleChatInputKey, autoGrowChatInput, retryChatMessage, jumpToChatMessage */

const MESSAGE_SELECT_FIELDS = 'id, conversation_id, sender_id, content, reply_to_id, reply_to_snippet, created_at';

/* Adjuntos y registros de llamada: se guardan en `content` con un prefijo invisible + JSON,
   así no hace falta cambiar la tabla `messages`. Tipos: image, video, file, call. */
const CHAT_PAYLOAD_PREFIX = '\u200bOG:';

function encodeChatPayload(obj) {
 return CHAT_PAYLOAD_PREFIX + JSON.stringify(obj);
}

function parseChatPayload(content) {
 if (typeof content !== 'string' || !content.startsWith(CHAT_PAYLOAD_PREFIX)) return null;
 try {
  const obj = JSON.parse(content.slice(CHAT_PAYLOAD_PREFIX.length));
  return obj && typeof obj === 'object' ? obj : null;
 } catch (e) { return null; }
}

/* Texto corto para la lista de conversaciones y para las respuestas citadas */
function chatContentPreview(content) {
 const p = parseChatPayload(content);
 if (!p) return content;
 if (p.t === 'image') return '📷 Foto';
 if (p.t === 'video') return '🎥 Video';
 if (p.t === 'audio') return '🎤 Mensaje de voz';
 if (p.t === 'loor') return p.x ? '🎬 ' + p.x : '🎬 Loor';
 if (p.t === 'file') return '📎 ' + (p.n || 'Archivo');
 if (p.t === 'call') return p.v ? '📹 Videollamada' : '📞 Llamada';
 return 'Mensaje';
}

async function checkGlobalUnreadMessages() {
 if (!currentUser) return;
 const { data: parts } = await db.from('conversation_participants')
  .select('conversation_id, last_read_at')
  .eq('user_id', currentUser.id);
 if (!parts || !parts.length) {
  document.getElementById('navUnreadDot')?.classList.remove('active');
  return;
 }

 const convIds = parts.map(p => p.conversation_id);
 // Eliminar N+1: traer mensajes recientes de todas las conversaciones en 1 sola consulta
 const { data: recentMsgs } = await db.from('messages')
  .select('conversation_id, created_at, sender_id')
  .in('conversation_id', convIds)
  .order('created_at', { ascending: false })
  .limit(Math.max(convIds.length * 4, 30));

 const latestByConv = {};
 (recentMsgs || []).forEach(m => {
  if (!latestByConv[m.conversation_id]) latestByConv[m.conversation_id] = m;
 });

 for (const p of parts) {
  const latest = latestByConv[p.conversation_id];
  if (latest && latest.sender_id !== currentUser.id) {
   if (!p.last_read_at || new Date(latest.created_at) > new Date(p.last_read_at)) {
    document.getElementById('navUnreadDot')?.classList.add('active');
    return;
   }
  }
 }
 document.getElementById('navUnreadDot')?.classList.remove('active');
}

async function loadConversations() {
 const container = document.getElementById('dmConversationsList');
 if (!currentUser) return;

 if (!cachedConversationsList) {
  const cached = ogCache.get('conversations', 1000 * 60 * 60 * 12);
  if (Array.isArray(cached)) cachedConversationsList = cached;
 }
 if (Array.isArray(cachedConversationsList)) {
  renderConversationsDOM(cachedConversationsList, container);
 }

 try {
  const { data: myParts } = await db.from('conversation_participants')
   .select('conversation_id, last_read_at')
   .eq('user_id', currentUser.id);

  if (!myParts || !myParts.length) {
   cachedConversationsList = [];
   ogCache.set('conversations', []);
   container.innerHTML = '<div class="activity-empty">No tenés conversaciones activas.</div>';
   return;
  }

  const convIds = myParts.map(p => p.conversation_id);

  // Batch paralelo: participantes + últimos mensajes de todas las conversaciones en 2 únicas consultas
  const [allPartsRes, recentMsgsRes] = await Promise.all([
   db.from('conversation_participants').select('conversation_id, user_id').in('conversation_id', convIds),
   db.from('messages')
    .select('conversation_id, content, created_at, sender_id')
    .in('conversation_id', convIds)
    .order('created_at', { ascending: false })
    .limit(Math.max(convIds.length * 4, 40))
  ]);

  const convMap = {};
  myParts.forEach(p => {
   convMap[p.conversation_id] = { otherUserId: null, last_read_at: p.last_read_at };
  });
  (allPartsRes.data || []).forEach(p => {
   if (p.user_id !== currentUser.id && convMap[p.conversation_id]) {
    convMap[p.conversation_id].otherUserId = p.user_id;
   }
  });

  const latestMsgByConv = {};
  (recentMsgsRes.data || []).forEach(m => {
   if (!latestMsgByConv[m.conversation_id]) latestMsgByConv[m.conversation_id] = m;
  });

  const otherUserIds = [...new Set(Object.values(convMap).map(c => c.otherUserId).filter(Boolean))];
  const missing = otherUserIds.filter(id => !profilesCache[id]);
  if (missing.length > 0) {
   const { data: profs } = await db.from('og_profiles').select(PROFILE_MINI_FIELDS).in('id', missing);
   (profs || []).forEach(p => setCachedProfile(p, false));
   ogCache.set('profiles_map', profilesCache);
  }

  const valid = convIds.map(convId => {
   const otherId = convMap[convId]?.otherUserId;
   const profile = profilesCache[otherId];
   if (!profile) return null;

   const lastMsg = latestMsgByConv[convId] || null;
   const isUnread = Boolean(
    lastMsg &&
    lastMsg.sender_id !== currentUser.id &&
    (!convMap[convId].last_read_at || new Date(lastMsg.created_at) > new Date(convMap[convId].last_read_at))
   );

   return {
    conversationId: convId,
    profile,
    lastMessage: lastMsg ? (lastMsg.sender_id === currentUser.id ? 'Tú: ' : '') + chatContentPreview(lastMsg.content) : 'Conversación iniciada',
    time: lastMsg ? formatDate(lastMsg.created_at) : '',
    timestamp: lastMsg ? new Date(lastMsg.created_at).getTime() : 0,
    isUnread
   };
  }).filter(Boolean);

  valid.sort((a, b) => b.timestamp - a.timestamp);
  cachedConversationsList = valid;
  ogCache.set('conversations', valid);
  renderConversationsDOM(valid, container);
 } catch (e) {
  if (!cachedConversationsList) {
   container.innerHTML = '<div class="activity-empty">Error al cargar conversaciones.</div>';
  }
 }
}

function renderConversationsDOM(conversationsList, container) {
 if (!conversationsList || !conversationsList.length) {
  container.innerHTML = '<div class="activity-empty">No hay conversaciones recientes.</div>';
  return;
 }
 const fragment = document.createDocumentFragment();

 conversationsList.forEach(item => {
  const row = document.createElement('div');
  row.className = 'dm-conv-item' + (item.isUnread ? ' unread' : '');
  row.onclick = () => openChatRoom(item.conversationId, item.profile);
  bindSmartPrefetch(row, () => prefetchConversationMessages(item.conversationId));

  const av = createAvatarNode(item.profile, false);
  av.className += ' dm-conv-avatar';

  const info = document.createElement('div');
  info.className = 'dm-conv-info';

  const nameRow = document.createElement('div');
  nameRow.className = 'dm-conv-name';
  const nameSpan = document.createElement('span');
  nameSpan.textContent = item.profile.username || item.profile.display_name;
  const timeSpan = document.createElement('span');
  timeSpan.className = 'dm-conv-time';
  timeSpan.textContent = item.time;
  nameRow.append(nameSpan, timeSpan);

  const snippetDiv = document.createElement('div');
  snippetDiv.className = 'dm-conv-snippet';
  snippetDiv.textContent = item.lastMessage;

  info.append(nameRow, snippetDiv);
  row.append(av, info);

  if (item.isUnread) {
   const dot = document.createElement('span');
   dot.className = 'dm-unread-dot';
   row.append(dot);
  }
  fragment.append(row);
 });
 container.replaceChildren(fragment);
}

async function searchUsersForChat() {
 clearTimeout(dmSearchTimer);
 const val = document.getElementById('dmSearchInput').value.trim();
 const resultBox = document.getElementById('dmSearchResults');
 if (val.length < 2) { resultBox.replaceChildren(); return; }

 dmSearchTimer = setTimeout(async () => {
  const { data } = await db.from('og_profiles').select(PROFILE_MINI_FIELDS).ilike('username', '%' + val + '%').limit(10);
  if (!data || !data.length) {
   resultBox.innerHTML = '<p class="muted" style="text-align:center;padding:10px">No se encontraron usuarios.</p>';
   return;
  }

  const fragment = document.createDocumentFragment();
  data.forEach(profile => {
   if (profile.id === currentUser?.id) return;
   setCachedProfile(profile, false);
   const item = document.createElement('div');
   item.className = 'public-user';
   item.append(createAvatarNode(profile, false));
   const info = document.createElement('div');
   info.className = 'public-user-info';
   info.innerHTML = `<strong>${profile.username}</strong>`;
   item.append(info);
   item.onclick = () => openDirectChatWithUser(profile.id);
   fragment.append(item);
  });
  resultBox.replaceChildren(fragment);
 }, 200);
}

async function openDirectChatWithUser(recipientId) {
 if (!currentUser || !recipientId) return;
 const { data: convId } = await db.rpc('get_or_create_conversation', { user_a: currentUser.id, user_b: recipientId });
 const profile = profilesCache[recipientId] || (await db.from('og_profiles').select(PROFILE_SELECT_FIELDS).eq('id', recipientId).single()).data;
 if (profile) {
  setCachedProfile(profile, true);
  openChatRoom(convId, profile);
 }
}

/* ---------- Presentación de mensajes: fechas, grupos y scroll ---------- */
const CHAT_GROUP_GAP_MS = 5 * 60 * 1000;
let chatStickToBottom = true;
let chatInteractionsReady = false;

function chatDayKey(ts) {
 const d = new Date(ts);
 return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

function chatDayLabel(ts) {
 const d = new Date(ts);
 const today = new Date(); today.setHours(0, 0, 0, 0);
 const day = new Date(d); day.setHours(0, 0, 0, 0);
 const diff = Math.round((today - day) / 86400000);
 if (diff === 0) return 'Hoy';
 if (diff === 1) return 'Ayer';
 if (diff > 1 && diff < 7) return d.toLocaleDateString('es-AR', { weekday: 'long' });
 const opts = { day: 'numeric', month: 'long' };
 if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
 return d.toLocaleDateString('es-AR', opts);
}

function formatChatTime(value) {
 return new Date(value).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function isChatNearBottom(container) {
 return container.scrollHeight - container.scrollTop - container.clientHeight < 140;
}

// Agrega el nodo al final del contenedor (o fragmento), con separador de día y agrupación
function placeChatNode(parent, node, msg) {
 const ts = new Date(msg.created_at).getTime();
 const dayKey = chatDayKey(ts);
 const last = parent.lastElementChild;
 let prev = last && last.classList.contains('chat-bubble') ? last : null;
 node.dataset.ts = String(ts);
 node.dataset.day = dayKey;
 if (!prev || prev.dataset.day !== dayKey) {
  const sep = document.createElement('div');
  sep.className = 'chat-date-sep';
  sep.textContent = chatDayLabel(ts);
  parent.append(sep);
  prev = null;
 }
 if (prev && prev.dataset.sender === node.dataset.sender && ts >= Number(prev.dataset.ts) && ts - Number(prev.dataset.ts) < CHAT_GROUP_GAP_MS) {
  prev.classList.add('gn');
  node.classList.add('gp');
 }
 parent.append(node);
}

function renderChatMessagesList(msgs, container) {
 renderedMessageIds.clear();
 hideChatNewMsgBtn();
 if (!msgs || !msgs.length) {
  container.innerHTML = '<div class="activity-empty">Todavía no hay mensajes. ¡Escribí el primero!</div>';
  return;
 }
 const fragment = document.createDocumentFragment();
 msgs.forEach(m => {
  if (m.id) renderedMessageIds.add(m.id);
  placeChatNode(fragment, buildChatMessageNode(m), m);
 });
 container.replaceChildren(fragment);
 scrollToBottomChat(true);
}

async function openChatRoom(conversationId, recipientProfile) {
 activeConversationId = conversationId;
 activeRecipientProfile = recipientProfile;
 chatStickToBottom = true;
 cancelReply();
 initChatInteractions();
 if (typeof updateChatSendMicState === 'function') updateChatSendMicState();

 document.querySelectorAll('main>div').forEach(x => x.classList.remove('active'));
 document.getElementById('chatRoomPage').classList.add('active');

 const bottomNavBar = document.getElementById('bottomNavBar');
 if (bottomNavBar) bottomNavBar.style.display = 'none';

 document.getElementById('chatRoomTitle').textContent = recipientProfile.username || recipientProfile.display_name;

 const headerAvatar = document.getElementById('chatRoomHeaderAvatar');
 headerAvatar.replaceChildren();
 if (recipientProfile.avatar_url) {
  const img = document.createElement('img');
  img.src = recipientProfile.avatar_url;
  img.decoding = 'async';
  headerAvatar.append(img);
 } else {
  headerAvatar.textContent = '👤';
 }
 const dot = document.createElement('span');
 dot.id = 'chatRoomOnlineDot';
 dot.className = 'online-dot';
 if (onlineUsersMap[recipientProfile.id]) dot.classList.add('active');
 headerAvatar.append(dot);

 document.getElementById('chatRoomStatusSub').textContent = onlineUsersMap[recipientProfile.id] ? 'En línea' : ogFormatLastSeen(ogLastSeenCache[recipientProfile.id]);
 if (!onlineUsersMap[recipientProfile.id]) ogRefreshChatStatus();

 const container = document.getElementById('chatMessagesContainer');
 const cachedMsgs = prefetchedMessagesByConv[conversationId] || ogCache.get(`chat_msgs_${conversationId}`, 1000 * 60 * 60 * 12);
 if (Array.isArray(cachedMsgs) && cachedMsgs.length > 0) {
  renderChatMessagesList(cachedMsgs, container);
 } else {
  renderedMessageIds.clear();
  container.innerHTML = '<div class="activity-empty">Cargando mensajes...</div>';
 }

 const [, msgsRes] = await Promise.all([
  db.from('conversation_participants').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', conversationId).eq('user_id', currentUser.id),
  db.from('messages').select(MESSAGE_SELECT_FIELDS).eq('conversation_id', conversationId).order('created_at', { ascending: true })
 ]);

 checkGlobalUnreadMessages();

 const msgs = msgsRes.data;
 if (activeConversationId !== conversationId) return;
 if (msgs) {
  prefetchedMessagesByConv[conversationId] = msgs;
  ogCache.set(`chat_msgs_${conversationId}`, msgs.slice(-50));
  renderChatMessagesList(msgs, container);
 } else if (!cachedMsgs) {
  container.replaceChildren();
 }
}

function buildChatMessageNode(msg) {
 const isMine = msg.sender_id === currentUser.id;
 const bubble = document.createElement('div');
 bubble.className = `chat-bubble ${isMine ? 'sent' : 'received'}`;
 bubble.dataset.sender = msg.sender_id;
 if (msg.id) bubble.dataset.msgId = msg.id;

 if (msg.reply_to_snippet) {
  const rep = document.createElement('div');
  rep.className = 'chat-bubble-reply-preview';
  rep.dataset.replyId = msg.reply_to_id || '';
  rep.textContent = msg.reply_to_snippet;
  bubble.append(rep);
 }

 const payload = parseChatPayload(msg.content);
 const payloadNode = payload && typeof buildChatPayloadNode === 'function' ? buildChatPayloadNode(payload, msg, isMine) : null;
 if (payloadNode) {
  bubble.dataset.snippet = chatContentPreview(msg.content);
  if (payload.t === 'call') {
   bubble.classList.add('chat-call-log');
   bubble.dataset.sender = 'call-log';
  } else {
   bubble.classList.add('has-media');
  }
  bubble.append(payloadNode);
 } else {
  const textDiv = document.createElement('div');
  textDiv.className = 'chat-bubble-text';
  textDiv.textContent = msg.content;
  bubble.append(textDiv);
 }

 const timeDiv = document.createElement('div');
 timeDiv.className = 'chat-bubble-time';
 timeDiv.textContent = formatChatTime(msg.created_at);
 bubble.append(timeDiv);

 return bubble;
}

function appendChatMessageNode(msg) {
 if (msg?.id && renderedMessageIds.has(msg.id)) return null;
 if (msg?.id) renderedMessageIds.add(msg.id);
 const container = document.getElementById('chatMessagesContainer');
 const emptyPlaceholder = container.querySelector('.activity-empty');
 if (emptyPlaceholder) emptyPlaceholder.remove();
 // Se mide ANTES de agregar el mensaje: si ya estabas abajo, el chat te sigue
 chatStickToBottom = isChatNearBottom(container);
 const node = buildChatMessageNode(msg);
 placeChatNode(container, node, msg);
 if (msg && msg.sender_id !== currentUser?.id) markActiveConversationRead(msg);
 return node;
}

// Si estás dentro de la sala y llega un mensaje, queda marcado como leído
async function markActiveConversationRead(msg) {
 if (!currentUser || !activeConversationId || msg.conversation_id !== activeConversationId) return;
 if (!document.getElementById('chatRoomPage')?.classList.contains('active')) return;
 if (document.visibilityState !== 'visible') return;
 try {
  await db.from('conversation_participants')
   .update({ last_read_at: new Date().toISOString() })
   .eq('conversation_id', activeConversationId)
   .eq('user_id', currentUser.id);
  checkGlobalUnreadMessages();
 } catch (e) {}
}

// force === true: ir siempre abajo. Sin argumento: solo si ya estabas abajo; si no, avisa con un botón
function scrollToBottomChat(force) {
 const container = document.getElementById('chatMessagesContainer');
 if (!container) return;
 if (force === true || chatStickToBottom) {
  container.scrollTop = container.scrollHeight;
  hideChatNewMsgBtn();
 } else {
  showChatNewMsgBtn();
 }
}

function showChatNewMsgBtn() {
 const page = document.getElementById('chatRoomPage');
 if (!page) return;
 let btn = document.getElementById('chatNewMsgBtn');
 if (!btn) {
  btn = document.createElement('button');
  btn.id = 'chatNewMsgBtn';
  btn.type = 'button';
  btn.className = 'chat-new-msg-btn';
  btn.textContent = '↓ Mensajes nuevos';
  btn.onclick = () => scrollToBottomChat(true);
  page.append(btn);
 }
 const footer = page.querySelector('.chat-input-footer');
 btn.style.bottom = ((footer ? footer.offsetHeight : 60) + 12) + 'px';
 btn.classList.add('active');
}

function hideChatNewMsgBtn() {
 document.getElementById('chatNewMsgBtn')?.classList.remove('active');
}

// Gestos y toques: deslizar para responder, tocar la cita para saltar al original, reintentar envíos fallidos
function initChatInteractions() {
 if (chatInteractionsReady) return;
 const container = document.getElementById('chatMessagesContainer');
 if (!container) return;
 chatInteractionsReady = true;

 container.addEventListener('click', e => {
  const preview = e.target.closest('.chat-bubble-reply-preview');
  if (preview) { jumpToChatMessage(preview.dataset.replyId); return; }
  const failed = e.target.closest('.chat-bubble.is-error');
  if (failed) retryChatMessage(failed);
 });

 container.addEventListener('dblclick', e => {
  const bubble = e.target.closest('.chat-bubble');
  if (bubble) replyToBubble(bubble);
 });

 container.addEventListener('scroll', () => {
  if (isChatNearBottom(container)) hideChatNewMsgBtn();
 }, { passive: true });

 const THRESHOLD = 56;
 let active = null, startX = 0, startY = 0, dragging = false, armed = false;

 container.addEventListener('touchstart', e => {
  const bubble = e.target.closest('.chat-bubble');
  if (!bubble || e.touches.length !== 1) { active = null; return; }
  active = bubble;
  dragging = false;
  armed = false;
  startX = e.touches[0].clientX;
  startY = e.touches[0].clientY;
 }, { passive: true });

 container.addEventListener('touchmove', e => {
  if (!active) return;
  const dx = e.touches[0].clientX - startX;
  const dy = e.touches[0].clientY - startY;
  if (!dragging) {
   if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { active = null; return; }
   if (dx > 10 && dx > Math.abs(dy) * 1.5) {
    dragging = true;
    active.classList.add('swiping');
   } else {
    return;
   }
  }
  e.preventDefault();
  const x = Math.max(0, Math.min(dx, 90));
  const eased = x > THRESHOLD ? THRESHOLD + (x - THRESHOLD) * 0.3 : x;
  active.style.transform = `translateX(${eased}px)`;
  const nowArmed = x >= THRESHOLD;
  if (nowArmed !== armed) {
   armed = nowArmed;
   active.classList.toggle('reply-armed', armed);
   if (armed && navigator.vibrate) navigator.vibrate(8);
  }
 }, { passive: false });

 const endSwipe = () => {
  if (!active) return;
  const bubble = active;
  const shouldReply = dragging && armed;
  active = null;
  dragging = false;
  armed = false;
  bubble.classList.remove('swiping', 'reply-armed');
  bubble.style.transform = '';
  if (shouldReply) replyToBubble(bubble);
 };
 container.addEventListener('touchend', endSwipe);
 container.addEventListener('touchcancel', endSwipe);
}

function replyToBubble(bubble) {
 if (bubble.classList.contains('chat-call-log')) return;
 const text = bubble.dataset.snippet || bubble.querySelector('.chat-bubble-text')?.textContent || '';
 triggerReplyToMessage(bubble.dataset.msgId, text);
}

function jumpToChatMessage(msgId) {
 if (!msgId) return;
 const container = document.getElementById('chatMessagesContainer');
 const target = container?.querySelector(`.chat-bubble[data-msg-id="${CSS.escape(msgId)}"]`);
 if (!target) return;
 target.scrollIntoView({ block: 'center', behavior: 'smooth' });
 target.classList.remove('flash');
 void target.offsetWidth;
 target.classList.add('flash');
 setTimeout(() => target.classList.remove('flash'), 1400);
}

function triggerReplyToMessage(msgId, content) {
 // Un mensaje todavía sin confirmar no tiene id real en la base: no se puede citar
 if (!msgId || String(msgId).startsWith('optimistic-')) return;
 const clean = String(content || '').replace(/\s+/g, ' ').trim();
 replyingToMessageId = msgId;
 replyingToSnippet = clean.slice(0, 45) + (clean.length > 45 ? '...' : '');
 document.getElementById('replyingTextSnippet').textContent = replyingToSnippet;
 document.getElementById('replyingBar').classList.add('active');
 document.getElementById('chatMessageInput').focus();
}

function cancelReply() {
 replyingToMessageId = null;
 replyingToSnippet = null;
 document.getElementById('replyingBar').classList.remove('active');
}

// Campo de texto: crece hasta 5 líneas; Enter envía en computadora, en el celular Enter hace salto de línea
function autoGrowChatInput(el) {
 if (!el) return;
 if (typeof updateChatSendMicState === 'function') updateChatSendMicState(el);
 const container = document.getElementById('chatMessagesContainer');
 const stick = container ? isChatNearBottom(container) : false;
 if (!el.value) {
  el.style.height = '';
 } else {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
 }
 if (stick && container) container.scrollTop = container.scrollHeight;
}

function handleChatInputKey(e) {
 if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
 if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
  e.preventDefault();
  sendChatMessage();
 }
}

function setChatNodeStatus(node, text) {
 const timeEl = node?.querySelector('.chat-bubble-time');
 if (timeEl) timeEl.textContent = text;
}

async function sendChatMessage() {
 if (!activeConversationId || !currentUser) return;
 const input = document.getElementById('chatMessageInput');
 const text = input.value.trim();
 if (!text) return;

 const targetConvId = activeConversationId;
 const replyId = replyingToMessageId;
 const replySnippet = replyingToSnippet;

 input.value = '';
 autoGrowChatInput(input);
 cancelReply();
 input.focus();

 // Optimistic UI: insertar burbuja de inmediato (0 ms)
 const tempId = 'optimistic-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
 const optimisticMsg = {
  id: tempId,
  conversation_id: targetConvId,
  sender_id: currentUser.id,
  content: text,
  reply_to_id: replyId,
  reply_to_snippet: replySnippet,
  created_at: new Date().toISOString()
 };
 const optimisticNode = appendChatMessageNode(optimisticMsg);
 scrollToBottomChat(true);

 const payload = {
  conversation_id: targetConvId,
  sender_id: currentUser.id,
  content: text,
  reply_to_id: replyId,
  reply_to_snippet: replySnippet
 };

 if (optimisticNode) {
  optimisticNode._payload = payload;
  optimisticNode._tempId = tempId;
  optimisticNode.classList.add('is-sending');
  setChatNodeStatus(optimisticNode, 'Enviando…');
 }
 await deliverChatMessage(payload, optimisticNode, tempId);
}

async function deliverChatMessage(payload, node, tempId) {
 let inserted = null;
 try {
  const res = await db.from('messages')
   .insert(payload)
   .select(MESSAGE_SELECT_FIELDS)
   .single();
  if (!res.error) inserted = res.data;
 } catch (e) {}

 if (!inserted) {
  if (node) {
   node.classList.remove('is-sending');
   node.classList.add('is-error');
   setChatNodeStatus(node, 'No enviado · tocá para reintentar');
  }
  return;
 }

 renderedMessageIds.delete(tempId);
 renderedMessageIds.add(inserted.id);
 ogPlaySound('send');
 if (node) {
  node.classList.remove('is-sending', 'is-error');
  node.dataset.msgId = inserted.id;
  setChatNodeStatus(node, formatChatTime(inserted.created_at));
  delete node._payload;
 }
 const prevCache = prefetchedMessagesByConv[payload.conversation_id] || [];
 prefetchedMessagesByConv[payload.conversation_id] = [...prevCache, inserted];
 ogCache.set(`chat_msgs_${payload.conversation_id}`, prefetchedMessagesByConv[payload.conversation_id].slice(-50));
 cachedConversationsList = null;
 ogCache.remove('conversations');
}

function retryChatMessage(node) {
 if (!node) return;
 // Adjunto que no llegó a subirse: se vuelve a intentar la subida completa
 if (!node._payload && typeof node._retryFn === 'function') { node._retryFn(); return; }
 if (!node._payload) return;
 node.classList.remove('is-error');
 node.classList.add('is-sending');
 setChatNodeStatus(node, 'Enviando…');
 deliverChatMessage(node._payload, node, node._tempId);
}

/* Inserta un mensaje ya armado (por ejemplo el registro de una llamada) y lo muestra si el chat está abierto */
async function postChatSystemMessage(conversationId, content) {
 if (!currentUser || !conversationId) return null;
 try {
  const { data, error } = await db.from('messages')
   .insert({ conversation_id: conversationId, sender_id: currentUser.id, content })
   .select(MESSAGE_SELECT_FIELDS)
   .single();
  if (error || !data) return null;
  if (activeConversationId === conversationId && document.getElementById('chatRoomPage')?.classList.contains('active')) {
   appendChatMessageNode(data);
   scrollToBottomChat();
  }
  const prev = prefetchedMessagesByConv[conversationId] || [];
  prefetchedMessagesByConv[conversationId] = [...prev, data];
  ogCache.set(`chat_msgs_${conversationId}`, prefetchedMessagesByConv[conversationId].slice(-50));
  cachedConversationsList = null;
  ogCache.remove('conversations');
  return data;
 } catch (e) { return null; }
}

function openChatDetailsPage() {
 if (!activeRecipientProfile) return;
 document.querySelectorAll('main>div').forEach(x => x.classList.remove('active'));
 document.getElementById('chatDetailsPage').classList.add('active');

 const av = document.getElementById('chatDetailsAvatarContainer');
 setAvatarContent(av, activeRecipientProfile.avatar_url, '👤');
 document.getElementById('chatDetailsName').textContent = activeRecipientProfile.username || activeRecipientProfile.display_name;
 document.getElementById('chatDetailsUsername').textContent = '@' + activeRecipientProfile.username;

 const isOnline = onlineUsersMap[activeRecipientProfile.id];
 const statusEl = document.getElementById('chatDetailsActivityStatus');
 statusEl.textContent = isOnline ? 'En línea' : ogFormatLastSeen(ogLastSeenCache[activeRecipientProfile.id]);
 statusEl.style.color = isOnline ? '#22c55e' : '#888888';
}

function toggleChatDetailsMenu() {
 const dd = document.getElementById('chatDetailsDropdown');
 dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
}

function handleChatActionMenu(action) {
 document.getElementById('chatDetailsDropdown').style.display = 'none';
 if (action === 'block') alert('Usuario bloqueado.');
 if (action === 'report') alert('Reporte enviado.');
 if (action === 'restrict') alert('Cuenta restringida.');
}

function openChatRecipientProfile() {
 if (activeRecipientProfile) openPublicProfile(activeRecipientProfile.id);
}

function triggerChatSearch() {
 const query = prompt('Buscar mensaje en el chat:');
 if (!query) return;
 alert(`Buscando "${query}" en el historial...`);
}

function openMuteOptionsModal() { alert('Notificaciones del chat silenciadas.'); }

function openChatSubSettings(type) {
 document.querySelectorAll('main>div').forEach(x => x.classList.remove('active'));
 document.getElementById('chatSubSettingsPage').classList.add('active');

 const titleEl = document.getElementById('chatSubSettingsTitle');
 const bodyEl = document.getElementById('chatSubSettingsBody');
 bodyEl.replaceChildren();

 if (type === 'privacy') {
  titleEl.textContent = 'Privacidad y seguridad';
  bodyEl.innerHTML = `<div class="settings-row"><div class="settings-row-info"><p class="settings-row-title">Confirmaciones de lectura</p><p class="settings-row-desc">Mostrar cuando leés los mensajes.</p></div><label class="toggle-switch"><input type="checkbox" checked><span class="toggle-slider"></span></label></div>`;
 } else if (type === 'timer') {
  titleEl.textContent = 'Mensajes temporales';
  bodyEl.innerHTML = `<p class="muted">Los mensajes enviados desaparecerán automáticamente después del tiempo seleccionado.</p><button class="secondary" onclick="alert('Temporizador desactivado')">Desactivado</button><button class="secondary" onclick="alert('Configurado a 24 horas')">24 horas</button><button class="secondary" onclick="alert('Configurado a 7 días')">7 días</button>`;
 } else if (type === 'nickname') {
  titleEl.textContent = 'Apodos';
  bodyEl.innerHTML = `<input class="field" id="nicknameInput" placeholder="Nuevo apodo"><button class="primary" onclick="alert('Apodo actualizado')">Guardar apodo</button>`;
 } else if (type === 'style') {
  titleEl.textContent = 'Personalizar estilo';
  bodyEl.innerHTML = `<p class="muted">Tema actual: Minimalista Blanco</p><button class="secondary" onclick="alert('Tema azul clásico aplicado')">Azul Clásico</button><button class="secondary" onclick="alert('Tema monocromo aplicado')">Monocromo</button>`;
 }
}
